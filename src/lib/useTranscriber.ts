import { useCallback, useEffect, useRef, useState } from "react";
import ortWasmUrl from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url";
import type { DecodeOptions, SpeechLang, Word } from "../engine";
import { DEFAULT_MODEL, isModelId, modelFileUrl, modelInfo, MODELS, type ModelId } from "../models";
import { allCached } from "../worker/modelStore";
import { BAND_RATE, PEAK_STEP, type AlignSpan, type FromWorker, type ProviderChoice, type ToWorker } from "../worker/protocol";
import { decodeWithAudioContext } from "./decodeFallback";
import { LiveMeter, type AuraLevels } from "../render/aura";
import { MicError, startMicrophone, type Microphone } from "./microphone";
import type { Speakers } from "./speakers";
import type { Translation } from "./translation";

export type EngineState =
  | { phase: "idle" }
  | { phase: "downloading"; loaded: number; total: number; fromCache: boolean }
  | { phase: "compiling" }
  | { phase: "ready"; provider: "webgpu" | "wasm"; gpu: string | null; fallbackReason: string | null }
  | { phase: "error"; message: string };

/** `idle`: a file is open but not transcribed yet (it waits for "Yazıya dök"). */
export type JobStatus = "idle" | "running" | "done" | "cancelled" | "error";

/** A stretch of the file in seconds. */
export interface TimeRange {
  start: number;
  end: number;
}

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
  /** The model that wrote the transcript. */
  model: ModelId;
  /** Name of the subtitle file the words came from; then no model wrote them. */
  imported?: string;
  options: DecodeOptions;
  status: JobStatus;
  duration: number | null;
  decoded: number;
  words: Word[];
  tentative: Word[];
  peaks: Float32Array;
  /** Aura band levels (low, mid, high interleaved at BAND_RATE). */
  bands: Float32Array;
  /** Speech loudness at BAND_RATE, for "Sesle vurgula"; empty in projects saved before it. */
  loudness: Float32Array;
  speed: number;
  elapsed: number | null;
  error: string | null;
  translation?: Translation;
  /** Who speaks when, once the speakers were told apart. */
  speakers?: Speakers;
  /** Where the current run started in the file: 0, the range's start, or where a stopped job was continued from. */
  startAt?: number;
  /** The part of the file being transcribed; missing for all of it. */
  range?: TimeRange;
}

/** A stopped file job can go on from where it stopped. */
export const canResume = (j: Job | null): j is Job & { file: File } =>
  !!j &&
  j.status === "cancelled" &&
  !j.live &&
  !!j.file &&
  !j.imported &&
  j.decoded < (j.range?.end ?? j.duration ?? Infinity) - 0.5;

/** A continued job (not its first run), which is already saved as a project. */
export const isContinued = (j: Job) => !!j.startAt && j.startAt !== j.range?.start;

const PROVIDER_KEY = "harfiyen.provider";
const MODEL_KEY = "harfiyen.model";

function loadModel(): ModelId {
  try {
    const v = localStorage.getItem(MODEL_KEY);
    return isModelId(v) ? v : DEFAULT_MODEL;
  } catch {
    return DEFAULT_MODEL;
  }
}

/** True if the model's files and the ONNX runtime are in the cache, so loading costs no download. */
export function modelIsCached(id: ModelId) {
  const m = modelInfo(id);
  return allCached([...m.files.map((f) => modelFileUrl(m, f)), ortWasmUrl]);
}

/** Which speech models are completely stored in the cache and ready for offline use. */
export async function cachedSpeechModels(): Promise<Set<ModelId>> {
  const flags = await Promise.all(MODELS.map((m) => modelIsCached(m.id)));
  return new Set(MODELS.filter((_, i) => flags[i]).map((m) => m.id));
}

function loadProvider(): ProviderChoice {
  try {
    const v = localStorage.getItem(PROVIDER_KEY);
    return v === "webgpu" || v === "wasm" ? v : "auto";
  } catch {
    return "auto";
  }
}

const GPU_FAILED = "Ekran kartı (WebGPU) hata verdi, işlemci (WASM) kullanılıyor.";

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
  const engineRef = useRef<EngineState>(engine);
  /** Waiting for the model; each resolves with whether it became ready. */
  const readyWaiters = useRef<((ok: boolean) => void)[]>([]);
  const [job, setJob] = useState<Job | null>(null);
  const jobRef = useRef<Job | null>(null);
  const [punct, setPunct] = useState<PunctState>({ phase: "idle" });
  const punctWaiters = useRef(new Map<number, { resolve: (w: string[]) => void; reject: (e: Error) => void }>());
  const nextPunctId = useRef(1);
  type Aligned = ({ start: number; end: number }[] | null)[];
  const alignWaiters = useRef(new Map<number, { resolve: (s: Aligned) => void; reject: (e: Error) => void }>());
  const nextAlignId = useRef(1);
  /** A pasted text being timed in the audio: spans done of total, or null. */
  const [aligning, setAligning] = useState<{ done: number; total: number } | null>(null);
  const nextId = useRef(1);
  /** The user's choice; the worker may run on the CPU anyway after a GPU failure. */
  const [provider, setProviderState] = useState<ProviderChoice>(loadProvider);
  const workerProvider = useRef<ProviderChoice>(provider);
  const [model, setModelState] = useState<ModelId>(loadModel);
  const workerModel = useRef<ModelId>(model);
  const cpuReason = useRef<string | undefined>(undefined);
  const onGpuFailure = useRef(() => {});

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

  const setEngineState = useCallback((e: EngineState) => {
    engineRef.current = e;
    setEngine(e);
  }, []);

  /** Resolves once the model is ready (true) or failed to load (false). */
  const engineReady = useCallback(
    () =>
      engineRef.current.phase === "ready"
        ? Promise.resolve(true)
        : new Promise<boolean>((r) => readyWaiters.current.push(r)),
    [],
  );

  const spawn = useCallback(() => {
    const w = new Worker(new URL("../worker/asr.worker.ts", import.meta.url), { type: "module" });
    workerRef.current = w;
    const settle = (ok: boolean) => {
      const waiters = readyWaiters.current;
      readyWaiters.current = [];
      waiters.forEach((r) => r(ok));
    };
    w.onmessage = async (ev: MessageEvent<FromWorker>) => {
      // A replaced worker may still have messages in flight.
      if (workerRef.current !== w) return;
      const m = ev.data;
      switch (m.type) {
        case "download":
          setEngineState({ phase: "downloading", loaded: m.loaded, total: m.total, fromCache: m.fromCache });
          break;
        case "compiling":
          setEngineState({ phase: "compiling" });
          break;
        case "ready":
          console.debug(`[harfiyen] encoder on ${m.provider}${m.gpu ? `, ${m.gpu}` : ""}`);
          setEngineState({ phase: "ready", provider: m.provider, gpu: m.gpu, fallbackReason: m.fallbackReason });
          settle(true);
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
            loudness: append(j.loudness, m.loudness),
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
            decoded: j.range?.end ?? j.duration ?? m.decoded,
            words: j.words.concat(m.committed),
            tentative: [],
            elapsed: m.elapsed,
            bands: append(j.bands, m.bands),
            loudness: append(j.loudness, m.loudness),
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
        case "align-progress":
          setAligning({ done: m.done, total: m.total });
          break;
        case "aligned":
          setAligning(null);
          alignWaiters.current.get(m.id)?.resolve(m.spans);
          alignWaiters.current.delete(m.id);
          break;
        case "align-error":
          setAligning(null);
          alignWaiters.current.get(m.id)?.reject(new Error(m.message));
          alignWaiters.current.delete(m.id);
          break;
        case "punct-error":
          setPunct({ phase: "error", message: m.message });
          punctWaiters.current.get(m.id)?.reject(new Error(m.message));
          punctWaiters.current.delete(m.id);
          break;
        case "error": {
          if (m.code === "gpu") {
            onGpuFailure.current();
            break;
          }
          if (m.jobId === null) {
            setEngineState({ phase: "error", message: m.message });
            settle(false);
            break;
          }
          const j = jobRef.current;
          if (m.code === "decode-unsupported" && j?.file && j.id === m.jobId) {
            // Let the browser's media stack decode the whole file instead.
            try {
              const pcm = await decodeWithAudioContext(j.file);
              send(
                {
                  type: "transcribe-pcm",
                  jobId: j.id,
                  pcm,
                  sampleRate: 16000,
                  options: j.options,
                  startAt: j.startAt,
                  endAt: j.range?.end,
                },
                [pcm.buffer],
              );
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
  }, [send, update, setEngineState]);

  useEffect(() => {
    spawn();
    return () => {
      workerRef.current?.terminate();
      workerRef.current = null;
    };
  }, [spawn]);

  /**
   * Replace the worker. The wasm runtime fixes its thread count when it
   * starts and GPU memory is only reliably freed with the worker, so a
   * provider change means a fresh worker (the model comes from the cache).
   */
  const restartWorker = useCallback(
    (p: ProviderChoice, reason?: string) => {
      workerRef.current?.terminate();
      workerProvider.current = p;
      cpuReason.current = reason;
      for (const w of punctWaiters.current.values()) w.reject(new Error("Yarıda kaldı"));
      punctWaiters.current.clear();
      setPunct({ phase: "idle" });
      for (const w of alignWaiters.current.values()) w.reject(new Error("Yarıda kaldı"));
      alignWaiters.current.clear();
      setAligning(null);
      setEngineState({ phase: "idle" });
      spawn();
    },
    [spawn, setEngineState],
  );

  const prepare = useCallback(() => {
    const e = engineRef.current;
    if (e.phase !== "idle" && e.phase !== "error") return;
    send({ type: "init", model: workerModel.current, provider: workerProvider.current, reason: cpuReason.current });
    if (e.phase === "error") setEngineState({ phase: "idle" });
  }, [send, setEngineState]);

  const mic = useRef<Microphone | null>(null);

  /** A microphone start waiting for the model; bumping the ticket abandons it. */
  const [liveWaiting, setLiveWaiting] = useState(false);
  const liveTicket = useRef(0);
  const cancelLiveWait = useCallback(() => {
    liveTicket.current++;
    setLiveWaiting(false);
  }, []);

  /** Stop whatever runs now: a recording, or the wait for one. */
  const stopOthers = useCallback(() => {
    const prev = jobRef.current;
    if (prev?.status === "running") send({ type: "cancel", jobId: prev.id });
    // Opening a file while recording (or waiting to record) ends the recording.
    cancelLiveWait();
    void mic.current?.stop();
    mic.current = null;
  }, [send, cancelLiveWait]);

  /** Open a file to play, frame and trim; it is transcribed only on `transcribe`. */
  const open = useCallback(
    (file: File, options: DecodeOptions) => {
      stopOthers();
      // The model loads meanwhile, so "Yazıya dök" starts at once.
      prepare();
      const j: Job = {
        id: nextId.current++,
        file,
        live: false,
        recording: false,
        model: workerModel.current,
        options,
        status: "idle",
        duration: null,
        decoded: 0,
        words: [],
        tentative: [],
        peaks: new Float32Array(0),
        bands: new Float32Array(0),
        loudness: new Float32Array(0),
        speed: 0,
        elapsed: null,
        error: null,
      };
      jobRef.current = j;
      setJob(j);
    },
    [prepare, stopOthers],
  );

  /**
   * Transcribe the open file, or only `range` of it, with the chosen model.
   * The job stays the same (and so its project); what it had is replaced.
   * The waveform and aura start out silent up to the range, so they line up with the file.
   */
  const transcribe = useCallback(
    (options: DecodeOptions, range?: TimeRange) => {
      const prev = jobRef.current;
      if (!prev?.file || prev.live) return;
      stopOthers();
      prepare();
      const at = range?.start ?? 0;
      const bands = Math.floor(at * BAND_RATE);
      const j: Job = {
        ...prev,
        model: workerModel.current,
        imported: undefined,
        options,
        status: "running",
        decoded: at,
        words: [],
        tentative: [],
        peaks: new Float32Array(Math.floor(at / PEAK_STEP)),
        bands: new Float32Array(bands * 3),
        loudness: new Float32Array(bands),
        speed: 0,
        elapsed: null,
        error: null,
        translation: undefined,
        speakers: undefined,
        startAt: at,
        range,
      };
      jobRef.current = j;
      setJob(j);
      send({ type: "transcribe", jobId: j.id, file: prev.file, options, startAt: at, endAt: range?.end });
    },
    [prepare, send, stopOthers],
  );

  /**
   * Open a saved transcript as a finished job; `file` may come later (attach).
   * `stoppedAt`: the transcription was stopped there, it can be continued.
   */
  const load = useCallback(
    (
      p: Pick<
        Job,
                | "file"
        | "model"
        | "imported"
        | "options"
        | "duration"
        | "elapsed"
        | "words"
        | "peaks"
        | "bands"
        | "loudness"
        | "translation"
        | "speakers"
      > & { stoppedAt?: number | null },
    ) => {
      const prev = jobRef.current;
      if (prev?.status === "running") send({ type: "cancel", jobId: prev.id });
      cancelLiveWait();
      void mic.current?.stop();
      mic.current = null;
      const { stoppedAt, ...rest } = p;
      // Only a sane position counts (project files can be edited by hand).
      const stopped = typeof stoppedAt === "number" && stoppedAt >= 0;
      // Saved before it was transcribed: it still waits for "Yazıya dök".
      const waiting = !stopped && !p.words.length && !p.imported;
      const j: Job = {
        ...rest,
        id: nextId.current++,
        live: false,
        recording: false,
        status: stopped ? "cancelled" : waiting ? "idle" : "done",
        decoded: stopped ? stoppedAt : (p.duration ?? p.words.at(-1)?.end ?? 0),
        tentative: [],
        speed: p.duration && p.elapsed ? p.duration / p.elapsed : 0,
        error: null,
      };
      jobRef.current = j;
      setJob(j);
      return j.id;
    },
    [send, cancelLiveWait],
  );

  /** Give a loaded job its media. */
  const attach = useCallback(
    (file: File) => {
      const j = jobRef.current;
      if (j && j.status !== "running") update(j.id, (x) => ({ ...x, file }));
    },
    [update],
  );

  /** Update a text-to-speech job in place after re-synthesising its words. */
  const setSpoken = useCallback(
    (
      p: Pick<Job, "file" | "options" | "duration" | "elapsed" | "words" | "peaks" | "bands" | "loudness">,
    ) => {
      const j = jobRef.current;
      if (!j || j.status === "running") return;
      update(j.id, (x) => ({
        ...x,
        ...p,
        decoded: p.duration ?? 0,
        speed: p.duration && p.elapsed ? p.duration / p.elapsed : 0,
      }));
    },
    [update],
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
      // Open the microphone only once the model is ready: speech captured
      // before that would pile up unseen and arrive as one late burst.
      const ticket = ++liveTicket.current;
      if (engineRef.current.phase !== "ready") {
        setLiveWaiting(true);
        const ok = await engineReady();
        if (ticket !== liveTicket.current) return;
        setLiveWaiting(false);
        if (!ok) return; // The status bar shows why.
      }
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
        model: workerModel.current,
        options,
        status: "running",
        duration: null,
        decoded: 0,
        words: [],
        tentative: [],
        peaks: new Float32Array(0),
        bands: new Float32Array(0),
        loudness: new Float32Array(0),
        speed: 0,
        elapsed: null,
        error: null,
      };
      jobRef.current = j;
      setJob(j);
      send({ type: "live-start", jobId: id, sampleRate: m.sampleRate, options });
    },
    [prepare, send, engineReady],
  );

  /** Stop the microphone; the recording becomes the job's file. */
  const stopLive = useCallback(async () => {
    cancelLiveWait();
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
  }, [send, update, cancelLiveWait]);

  const cancel = useCallback(() => {
    cancelLiveWait();
    const j = jobRef.current;
    if (j?.live && j.recording) void stopLive();
    else if (j?.status === "running") send({ type: "cancel", jobId: j.id });
  }, [send, stopLive, cancelLiveWait]);

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

  /** Whisper times known words in spans of a file (a pasted text); one result per span. */
  const alignAudio = useCallback(
    (file: File, lang: SpeechLang, spans: AlignSpan[]) =>
      new Promise<Aligned>((resolve, reject) => {
        const id = nextAlignId.current++;
        alignWaiters.current.set(id, { resolve, reject });
        setAligning({ done: 0, total: spans.length });
        prepare();
        send({ type: "align", id, file, lang, spans });
      }),
    [send, prepare],
  );

  /** Replace the transcript of a finished job (user edits). */
  const setWords = useCallback(
    (words: Word[]) => {
      const j = jobRef.current;
      if (j && j.status !== "running") update(j.id, (x) => ({ ...x, words }));
    },
    [update],
  );

  /** Set, edit or drop the translation of a job, if it is still open. */
  const setTranslation = useCallback(
    (jobId: number, translation: Translation | undefined) => {
      const j = jobRef.current;
      if (j && j.status !== "running") update(jobId, (x) => ({ ...x, translation }));
    },
    [update],
  );

  /** Set, edit or drop who speaks when, if the job is still open. */
  const setSpeakers = useCallback(
    (jobId: number, speakers: Speakers | undefined) => {
      const j = jobRef.current;
      if (j && j.status !== "running") update(jobId, (x) => ({ ...x, speakers }));
    },
    [update],
  );

  // WebGPU failed (loading or mid-file): go on with the CPU. A file starts
  // over there; a recording stops, since its audio so far went to the old worker.
  onGpuFailure.current = () => {
    const j = jobRef.current;
    const m = modelInfo(workerModel.current);
    if (m.gpuOnly) {
      // No CPU to fall back to: say so and leave the choice to the user.
      const message = `Ekran kartı hata verdi. ${m.name} işlemcide çalışmaz; Seda ile deneyebilirsin.`;
      restartWorker(workerProvider.current);
      setEngineState({ phase: "error", message });
      if (j?.status === "running") update(j.id, (x) => ({ ...x, status: "error", tentative: [], error: message }));
      return;
    }
    restartWorker("wasm", GPU_FAILED);
    if (j?.status === "running" && j.live) {
      void stopLive();
      update(j.id, (x) => ({
        ...x,
        status: "error",
        tentative: [],
        error: "Ekran kartı hata verdi, kayıt durduruldu. İşlemciyle yeniden kaydedebilirsin.",
      }));
    } else if (j?.status === "running" && j.file) {
      transcribe(j.options, j.range);
      return;
    }
    prepare();
  };

  /** Choose where the model runs; reloads it (from the cache) if already loaded. */
  const setProvider = useCallback(
    (p: ProviderChoice) => {
      try {
        localStorage.setItem(PROVIDER_KEY, p);
      } catch {
        // Not remembered, still used for this visit.
      }
      setProviderState(p);
      const was = engineRef.current.phase;
      restartWorker(p);
      if (was !== "idle") prepare();
    },
    [restartWorker, prepare],
  );

  /**
   * Choose the speech model; the next transcription uses it. Loads it right
   * away only if it was loaded before and costs no download.
   */
  const setModel = useCallback(
    (m: ModelId) => {
      try {
        localStorage.setItem(MODEL_KEY, m);
      } catch {
        // Not remembered, still used for this visit.
      }
      setModelState(m);
      workerModel.current = m;
      const was = engineRef.current.phase;
      // Back to the user's provider choice: a CPU fallback was for the old model.
      restartWorker(provider);
      if (was !== "idle") void modelIsCached(m).then((yes) => yes && workerModel.current === m && prepare());
    },
    [restartWorker, prepare, provider],
  );

  /**
   * Go on with a stopped job from where it stopped. The words so far stay;
   * the waveform and aura are cut back to that point, since the worker may
   * have read a little further than it wrote. The model that wrote the
   * job writes the rest, so the selected model switches back to it if needed.
   */
  const resume = useCallback((trim?: TimeRange) => {
    const j = jobRef.current;
    if (!canResume(j)) return;
    // A project opened again has its range from the page (the trim), not from the job.
    const range = j.range ?? trim;
    if (workerModel.current !== j.model) setModel(j.model);
    prepare();
    const at = j.decoded;
    const bands = Math.floor(at * BAND_RATE);
    update(j.id, (x) => ({
      ...x,
      status: "running",
      startAt: at,
      range,
      error: null,
      tentative: [],
      speed: 0,
      elapsed: null,
      peaks: x.peaks.slice(0, Math.floor(at / PEAK_STEP)),
      bands: x.bands.slice(0, bands * 3),
      loudness: x.loudness.slice(0, bands),
    }));
    send({ type: "transcribe", jobId: j.id, file: j.file, options: j.options, startAt: at, endAt: range?.end });
  }, [prepare, send, update, setModel]);

  return { engine, job, liveWaiting, provider, setProvider, model, setModel, prepare, open, transcribe, load, attach, setSpoken, startLive, stopLive, cancel, resume, clear, setWords, setTranslation, setSpeakers, liveLevels, liveMeter, punctuate, punct, alignAudio, aligning };
}

export { MicError };
