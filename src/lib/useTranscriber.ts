import { useCallback, useEffect, useRef, useState } from "react";
import type { DecodeOptions, Word } from "../engine";
import type { FromWorker, ToWorker } from "../worker/protocol";
import { decodeWithAudioContext } from "./decodeFallback";
import { LiveMeter, type AuraLevels } from "../render/aura";
import { MicError, startMicrophone, type Microphone } from "./microphone";

export type EngineState =
  | { phase: "idle" }
  | { phase: "downloading"; loaded: number; total: number; fromCache: boolean }
  | { phase: "compiling" }
  | { phase: "ready"; provider: "webgpu" | "wasm"; gpu: string | null; fallbackReason: string | null }
  | { phase: "error"; message: string };

export type JobStatus = "running" | "done" | "cancelled" | "error";

export type PunctState =
  | { phase: "idle" }
  | { phase: "download" | "run"; done: number; total: number }
  | { phase: "error"; message: string };

export interface Job {
  id: number;
  /** For live jobs, the recording; set once recording has stopped. */
  file: File | null;
  /** Microphone job: `recording` while the mic is open. */
  live: boolean;
  recording: boolean;
  options: DecodeOptions;
  status: JobStatus;
  duration: number | null;
  decoded: number;
  words: Word[];
  tentative: Word[];
  peaks: Float32Array;
  /** Aura band levels (low, mid, high interleaved at BAND_RATE). */
  bands: Float32Array;
  speed: number;
  elapsed: number | null;
  error: string | null;
}

function append(a: Float32Array, b: Float32Array) {
  if (!b.length) return a;
  const out = new Float32Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

export function useTranscriber() {
  const workerRef = useRef<Worker | null>(null);
  const [engine, setEngine] = useState<EngineState>({ phase: "idle" });
  const [job, setJob] = useState<Job | null>(null);
  const jobRef = useRef<Job | null>(null);
  const [punct, setPunct] = useState<PunctState>({ phase: "idle" });
  const punctWaiters = useRef(new Map<number, { resolve: (w: string[]) => void; reject: (e: Error) => void }>());
  const nextPunctId = useRef(1);
  const nextId = useRef(1);

  const update = useCallback((id: number, fn: (j: Job) => Job) => {
    setJob((j) => {
      if (!j || j.id !== id) return j;
      const n = fn(j);
      jobRef.current = n;
      return n;
    });
  }, []);

  const send = useCallback((m: ToWorker, transfer: Transferable[] = []) => {
    workerRef.current?.postMessage(m, transfer);
  }, []);

  useEffect(() => {
    const w = new Worker(new URL("../worker/asr.worker.ts", import.meta.url), { type: "module" });
    workerRef.current = w;
    w.onmessage = async (ev: MessageEvent<FromWorker>) => {
      const m = ev.data;
      switch (m.type) {
        case "download":
          setEngine({ phase: "downloading", loaded: m.loaded, total: m.total, fromCache: m.fromCache });
          break;
        case "compiling":
          setEngine({ phase: "compiling" });
          break;
        case "ready":
          console.debug(`[harfiyen] encoder on ${m.provider}${m.gpu ? `, ${m.gpu}` : ""}`);
          setEngine({ phase: "ready", provider: m.provider, gpu: m.gpu, fallbackReason: m.fallbackReason });
          break;
        case "meta":
          update(m.jobId, (j) => ({ ...j, duration: m.duration }));
          break;
        case "progress":
          update(m.jobId, (j) => ({
            ...j,
            decoded: m.decoded,
            words: m.committed.length ? j.words.concat(m.committed) : j.words,
            tentative: m.tentative,
            peaks: append(j.peaks, m.peaks),
            bands: append(j.bands, m.bands),
            speed: m.speed,
          }));
          break;
        case "done": {
          const t = m.timing;
          console.debug(
            `[harfiyen] ${m.decoded.toFixed(1)} s audio in ${m.elapsed.toFixed(2)} s; ` +
              `encoder ${(t.encoder / t.chunks).toFixed(1)} ms/chunk, search ${(t.search / t.chunks).toFixed(1)} ms/chunk, ${t.chunks} chunks`,
          );
          update(m.jobId, (j) => ({
            ...j,
            status: "done",
            decoded: j.duration ?? m.decoded,
            words: j.words.concat(m.committed),
            tentative: [],
            elapsed: m.elapsed,
            bands: append(j.bands, m.bands),
            speed: m.decoded / m.elapsed,
          }));
          break;
        }
        case "cancelled":
          update(m.jobId, (j) => ({ ...j, status: "cancelled", tentative: [] }));
          break;
        case "punct-progress":
          setPunct({ phase: m.phase, done: m.done, total: m.total });
          break;
        case "punctuated":
          setPunct({ phase: "idle" });
          punctWaiters.current.get(m.id)?.resolve(m.words);
          punctWaiters.current.delete(m.id);
          break;
        case "punct-error":
          setPunct({ phase: "error", message: m.message });
          punctWaiters.current.get(m.id)?.reject(new Error(m.message));
          punctWaiters.current.delete(m.id);
          break;
        case "error": {
          if (m.jobId === null) {
            setEngine({ phase: "error", message: m.message });
            break;
          }
          const j = jobRef.current;
          if (m.code === "decode-unsupported" && j?.file && j.id === m.jobId) {
            // Let the browser's media stack decode the whole file instead.
            try {
              const pcm = await decodeWithAudioContext(j.file);
              send({ type: "transcribe-pcm", jobId: j.id, pcm, sampleRate: 16000, options: j.options }, [pcm.buffer]);
              break;
            } catch {
              update(m.jobId, (x) => ({
                ...x,
                status: "error",
                error: "Bu dosyanın sesi tarayıcıda çözülemedi. MP4, WebM, MP3, M4A veya WAV olarak kaydedip yeniden dene.",
              }));
              break;
            }
          }
          update(m.jobId, (x) => ({ ...x, status: "error", error: m.message }));
          break;
        }
      }
    };
    return () => w.terminate();
  }, [send, update]);

  const prepare = useCallback(() => {
    setEngine((e) => {
      if (e.phase === "idle" || e.phase === "error") send({ type: "init", provider: "auto" });
      return e.phase === "error" ? { phase: "idle" } : e;
    });
  }, [send]);

  const mic = useRef<Microphone | null>(null);

  const start = useCallback(
    (file: File, options: DecodeOptions) => {
      const prev = jobRef.current;
      if (prev?.status === "running") send({ type: "cancel", jobId: prev.id });
      // Opening a file while recording ends the recording.
      void mic.current?.stop();
      mic.current = null;
      prepare();
      const j: Job = {
        id: nextId.current++,
        file,
        live: false,
        recording: false,
        options,
        status: "running",
        duration: null,
        decoded: 0,
        words: [],
        tentative: [],
        peaks: new Float32Array(0),
        bands: new Float32Array(0),
        speed: 0,
        elapsed: null,
        error: null,
      };
      jobRef.current = j;
      setJob(j);
      send({ type: "transcribe", jobId: j.id, file, options });
    },
    [prepare, send],
  );

  /** Real-time microphone meter (levels for the aura, peaks for the timeline). */
  const liveMeter = useRef<LiveMeter | null>(null);
  const liveLevels = useRef<AuraLevels | null>(null);

  /** Start transcribing the microphone. Rejects with a readable message. */
  const startLive = useCallback(
    async (options: DecodeOptions) => {
      const prev = jobRef.current;
      if (prev?.status === "running") send({ type: "cancel", jobId: prev.id });
      prepare();
      const id = nextId.current++;
      let meter: LiveMeter | null = null;
      const m = await startMicrophone((pcm) => {
        meter?.push(pcm);
        send({ type: "live-audio", jobId: id, pcm }, [pcm.buffer]);
      });
      meter = new LiveMeter(m.sampleRate);
      liveMeter.current = meter;
      liveLevels.current = meter.levels;
      mic.current = m;
      const j: Job = {
        id,
        file: null,
        live: true,
        recording: true,
        options,
        status: "running",
        duration: null,
        decoded: 0,
        words: [],
        tentative: [],
        peaks: new Float32Array(0),
        bands: new Float32Array(0),
        speed: 0,
        elapsed: null,
        error: null,
      };
      jobRef.current = j;
      setJob(j);
      send({ type: "live-start", jobId: id, sampleRate: m.sampleRate, options });
    },
    [prepare, send],
  );

  /** Stop the microphone; the recording becomes the job's file. */
  const stopLive = useCallback(async () => {
    const j = jobRef.current;
    const m = mic.current;
    if (!j?.live || !m) return;
    mic.current = null;
    liveLevels.current = null;
    liveMeter.current = null;
    send({ type: "live-stop", jobId: j.id });
    update(j.id, (x) => ({ ...x, recording: false }));
    const file = await m.stop();
    update(j.id, (x) => ({ ...x, file, duration: x.duration ?? x.decoded }));
  }, [send, update]);

  const cancel = useCallback(() => {
    const j = jobRef.current;
    if (j?.live && j.recording) void stopLive();
    else if (j?.status === "running") send({ type: "cancel", jobId: j.id });
  }, [send, stopLive]);

  const clear = useCallback(() => {
    cancel();
    jobRef.current = null;
    setJob(null);
  }, [cancel]);

  // Release the microphone if the page goes away mid-recording.
  useEffect(() => () => void mic.current?.stop(), []);

  /** Punctuate and true-case plain words; resolves with one written word per input word. */
  const punctuate = useCallback(
    (words: string[]) =>
      new Promise<string[]>((resolve, reject) => {
        const id = nextPunctId.current++;
        punctWaiters.current.set(id, { resolve, reject });
        setPunct({ phase: "run", done: 0, total: 1 });
        send({ type: "punctuate", id, words });
      }),
    [send],
  );

  /** Replace the transcript of a finished job (user edits). */
  const setWords = useCallback(
    (words: Word[]) => {
      const j = jobRef.current;
      if (j && j.status !== "running") update(j.id, (x) => ({ ...x, words }));
    },
    [update],
  );

  return { engine, job, prepare, start, startLive, stopLive, cancel, clear, setWords, liveLevels, liveMeter, punctuate, punct };
}

export { MicError };
