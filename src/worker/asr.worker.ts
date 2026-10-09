/// <reference lib="webworker" />
import { ALL_FORMATS, AudioSampleSink, BlobSource, Input } from "mediabunny";
import * as ort from "onnxruntime-web/webgpu";
import ortWasmUrl from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url";
import {
  downmix,
  Engine,
  Resampler,
  type DecodeOptions,
  type EncoderProvider,
  type ModelConfig,
  type Recognizer,
} from "../engine";
import { Punctuator, type PunctConfig } from "../punct/punctuator";
import type { SpmVocab } from "../punct/spm";
import { finishTurkish } from "../punct/turkish";
import { fetchAll } from "./modelStore";
import { BandTracker } from "../render/aura";
import { PEAK_STEP, type ErrorCode, type FromWorker, type ProviderChoice, type ToWorker } from "./protocol";

declare const self: DedicatedWorkerGlobalScope;

const MODEL_BASE = `${import.meta.env.BASE_URL}models/seda-v0.1/`;
/** Approximate; the real size is settled once the download finishes. */
const ORT_WASM_SIZE = 26_800_000;
const PROGRESS_INTERVAL_MS = 150;

const post = (m: FromWorker, transfer: Transferable[] = []) => self.postMessage(m, transfer);

class JobError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

let enginePromise: Promise<Engine> | null = null;
const cancelled = new Set<number>();

async function pickProvider(choice: ProviderChoice): Promise<{ provider: EncoderProvider; gpu: string | null; reason: string | null }> {
  if (choice === "wasm") return { provider: "wasm", gpu: null, reason: null };
  if (!("gpu" in navigator) || !navigator.gpu) {
    return { provider: "wasm", gpu: null, reason: "Bu tarayıcı WebGPU desteklemiyor." };
  }
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) return { provider: "wasm", gpu: null, reason: "WebGPU açık ama uygun bir GPU bulunamadı." };
  const info = adapter.info;
  const gpu = [info?.vendor, info?.architecture || info?.description].filter(Boolean).join(" ") || "GPU";
  return { provider: "webgpu", gpu, reason: null };
}

async function loadEngine(choice: ProviderChoice): Promise<Engine> {
  const cfgRes = await fetch(MODEL_BASE + "model.json", { cache: "no-cache" });
  if (!cfgRes.ok) throw new JobError("model", "model.json bulunamadı. Önce `npm run models` çalıştırılmalı.");
  const config: ModelConfig = await cfgRes.json();
  const names = ["encoder.webgpu.onnx", "decoder.onnx", "joiner.int8.onnx", "rnnlm.int8.onnx", "lodr.bin", "tokens.txt"];
  const files = await fetchAll(
    [
      ...names.map((n) => ({ url: MODEL_BASE + n, size: config.files[n] })),
      { url: ortWasmUrl, size: ORT_WASM_SIZE },
    ],
    (loaded, total, fromCache) => post({ type: "download", loaded, total, fromCache }),
  );
  const [encoder, decoder, joiner, lm, lodr, tokens, wasm] = files;

  post({ type: "compiling" });
  ort.env.wasm.wasmBinary = wasm.buffer as ArrayBuffer;
  // The wasm-side models (decoder, joiner, LM) are tiny per call; extra
  // threads only add synchronisation cost there.
  ort.env.wasm.numThreads = 1;
  ort.env.logLevel = "error";

  const modelFiles = {
    config,
    encoder,
    decoder,
    joiner,
    lm,
    lodr: lodr.buffer.slice(lodr.byteOffset, lodr.byteOffset + lodr.byteLength) as ArrayBuffer,
    tokens: new TextDecoder().decode(tokens),
  };

  const pick = await pickProvider(choice);
  let reason = pick.reason;
  let engine: Engine;
  try {
    engine = await Engine.create(ort, modelFiles, pick.provider);
  } catch (e) {
    if (pick.provider !== "webgpu") throw e;
    console.warn("WebGPU session failed, falling back to wasm", e);
    reason = "WebGPU oturumu açılamadı, işlemci (WASM) kullanılıyor.";
    pick.gpu = null;
    engine = await Engine.create(ort, modelFiles, "wasm");
  }
  post({
    type: "ready",
    provider: engine.provider === "webgpu" ? "webgpu" : "wasm",
    gpu: pick.gpu,
    fallbackReason: reason,
  });
  return engine;
}

function getEngine(choice: ProviderChoice = "auto") {
  if (!enginePromise) {
    enginePromise = loadEngine(choice).catch((e) => {
      enginePromise = null;
      throw e;
    });
  }
  return enginePromise;
}

const PUNCT_BASE = `${import.meta.env.BASE_URL}models/punct/`;
let punctPromise: Promise<Punctuator> | null = null;

/** The punctuation model is loaded on first use (≈60 MB, cached like the rest). */
function getPunctuator(id: number): Promise<Punctuator> {
  punctPromise ??= (async () => {
    const res = await fetch(PUNCT_BASE + "punct.json", { cache: "no-cache" });
    if (!res.ok) throw new Error("Noktalama modeli bulunamadı. `npm run models` çalıştırılmalı.");
    const cfg: PunctConfig = await res.json();
    const [model, vocab] = await fetchAll(
      ["punct.int8.onnx", "spm.json"].map((f) => ({ url: PUNCT_BASE + f, size: cfg.files[f] })),
      (done, total) => post({ type: "punct-progress", id, phase: "download", done, total }),
    );
    // Shares the wasm runtime loaded for the recognizer.
    await getEngine();
    const spm: SpmVocab = JSON.parse(new TextDecoder().decode(vocab));
    return Punctuator.create(ort, model, spm, cfg);
  })().catch((e) => {
    punctPromise = null;
    throw e;
  });
  return punctPromise;
}

async function punctuate(id: number, words: string[]) {
  try {
    const p = await getPunctuator(id);
    const marks = await p.run(words, (done, total) => post({ type: "punct-progress", id, phase: "run", done, total }));
    post({ type: "punctuated", id, words: finishTurkish(marks) });
  } catch (e) {
    post({ type: "punct-error", id, message: e instanceof Error ? e.message : String(e) });
  }
}

/** Feeds 16 kHz audio through the recognizer and reports progress. */
class Job {
  private rec: Recognizer;
  private resampler: Resampler | null = null;
  private peaks: number[] = [];
  private bands = new BandTracker();
  private peakAcc = 0;
  private peakCount = 0;
  private lastPost = 0;
  private started = performance.now();

  constructor(
    readonly id: number,
    engine: Engine,
    options: DecodeOptions,
  ) {
    this.rec = engine.createRecognizer(options);
    this.rec.onFeature = (f) => this.bands.push(f);
  }

  setSampleRate(rate: number) {
    this.resampler = new Resampler(rate, 16000);
  }

  get isCancelled() {
    return cancelled.has(this.id);
  }

  async push(samples: Float32Array, last = false) {
    const pcm = this.resampler!.process(samples, last);
    this.trackPeaks(pcm);
    this.rec.acceptWaveform(pcm);
    if (last) this.rec.inputFinished();
    while (this.rec.isReady()) {
      if (this.isCancelled) return;
      await this.rec.decodeChunk();
      this.maybePost();
    }
  }

  finish() {
    this.rec.flush();
    const elapsed = (performance.now() - this.started) / 1000;
    post({
      type: "done",
      jobId: this.id,
      committed: this.rec.takeCommitted(),
      decoded: this.rec.decodedSeconds,
      elapsed,
      bands: this.bands.take(),
      timing: this.rec.timing,
    });
  }

  private trackPeaks(pcm: Float32Array) {
    const step = 16000 * PEAK_STEP;
    for (let i = 0; i < pcm.length; i++) {
      const a = Math.abs(pcm[i]);
      if (a > this.peakAcc) this.peakAcc = a;
      if (++this.peakCount === step) {
        this.peaks.push(this.peakAcc);
        this.peakAcc = 0;
        this.peakCount = 0;
      }
    }
  }

  private maybePost() {
    const now = performance.now();
    if (now - this.lastPost < PROGRESS_INTERVAL_MS) return;
    this.lastPost = now;
    const peaks = Float32Array.from(this.peaks);
    this.peaks = [];
    const bands = this.bands.take();
    const decoded = this.rec.decodedSeconds;
    post(
      {
        type: "progress",
        jobId: this.id,
        decoded,
        committed: this.rec.takeCommitted(),
        tentative: this.rec.tentative(),
        peaks,
        bands,
        speed: decoded / ((now - this.started) / 1000),
      },
      [peaks.buffer, bands.buffer],
    );
  }
}

async function transcribeFile(job: Job, file: File) {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  let track;
  try {
    track = await input.getPrimaryAudioTrack();
  } catch {
    throw new JobError("decode-unsupported", "Dosya biçimi tanınmadı.");
  }
  if (!track) throw new JobError("no-audio", "Bu dosyada ses kanalı yok.");
  if (!(await track.canDecode())) throw new JobError("decode-unsupported", `Ses kodeki (${track.codec ?? "bilinmiyor"}) bu tarayıcıda çözülemiyor.`);

  post({ type: "meta", jobId: job.id, duration: await track.computeDuration() });
  job.setSampleRate(track.sampleRate);

  const sink = new AudioSampleSink(track);
  for await (const sample of sink.samples()) {
    if (job.isCancelled) {
      sample.close();
      break;
    }
    const channels: Float32Array[] = [];
    for (let ch = 0; ch < sample.numberOfChannels; ch++) {
      const buf = new Float32Array(sample.numberOfFrames);
      sample.copyTo(buf, { planeIndex: ch, format: "f32-planar" });
      channels.push(buf);
    }
    sample.close();
    await job.push(downmix(channels));
  }
  input.dispose();
}

async function transcribePcm(job: Job, pcm: Float32Array, sampleRate: number) {
  post({ type: "meta", jobId: job.id, duration: pcm.length / sampleRate });
  job.setSampleRate(sampleRate);
  const step = sampleRate * 2;
  for (let i = 0; i < pcm.length && !job.isCancelled; i += step) {
    await job.push(pcm.subarray(i, i + step));
  }
}

/** Microphone chunks queued until the recognizer takes them. */
class LiveSource {
  private chunks: Float32Array[] = [];
  private wake: (() => void) | null = null;
  private stopped = false;

  push(pcm: Float32Array) {
    this.chunks.push(pcm);
    this.wake?.();
  }

  stop() {
    this.stopped = true;
    this.wake?.();
  }

  hasChunk() {
    return this.chunks.length > 0;
  }

  /** Next chunk, or null once stopped and drained. */
  async next(): Promise<Float32Array | null> {
    while (!this.chunks.length && !this.stopped) {
      await new Promise<void>((r) => (this.wake = r));
      this.wake = null;
    }
    return this.chunks.shift() ?? null;
  }
}

const live = new Map<number, LiveSource>();

async function transcribeLive(job: Job, source: LiveSource, sampleRate: number) {
  job.setSampleRate(sampleRate);
  for (;;) {
    const pcm = await source.next();
    if (!pcm || job.isCancelled) break;
    // Merge whatever piled up meanwhile, so a slow moment never builds a backlog.
    let merged = pcm;
    const more: Float32Array[] = [];
    for (let c = await peek(source); c; c = await peek(source)) more.push(c);
    if (more.length) {
      merged = new Float32Array(pcm.length + more.reduce((a, c) => a + c.length, 0));
      merged.set(pcm);
      let off = pcm.length;
      for (const c of more) {
        merged.set(c, off);
        off += c.length;
      }
    }
    await job.push(merged);
  }
}

/** Take a chunk only if one is already waiting. */
async function peek(source: LiveSource): Promise<Float32Array | null> {
  return source.hasChunk() ? source.next() : null;
}

async function runJob(jobId: number, options: DecodeOptions, feed: (job: Job) => Promise<void>) {
  let job: Job | null = null;
  try {
    const engine = await getEngine();
    job = new Job(jobId, engine, options);
    await feed(job);
    if (job.isCancelled) {
      post({ type: "cancelled", jobId });
      return;
    }
    await job.push(new Float32Array(0), true);
    job.finish();
  } catch (e) {
    const code = e instanceof JobError ? e.code : "runtime";
    post({ type: "error", jobId, code, message: e instanceof Error ? e.message : String(e) });
  } finally {
    cancelled.delete(jobId);
  }
}

// Jobs run one at a time: the GPU session is shared.
let queue = Promise.resolve();

self.onmessage = (ev: MessageEvent<ToWorker>) => {
  const m = ev.data;
  switch (m.type) {
    case "init":
      getEngine(m.provider).catch((e) =>
        post({ type: "error", jobId: null, code: e instanceof JobError ? e.code : "model", message: String(e?.message ?? e) }),
      );
      break;
    case "transcribe":
      queue = queue.then(() => runJob(m.jobId, m.options, (job) => transcribeFile(job, m.file)));
      break;
    case "transcribe-pcm":
      queue = queue.then(() => runJob(m.jobId, m.options, (job) => transcribePcm(job, m.pcm, m.sampleRate)));
      break;
    case "live-start": {
      const source = new LiveSource();
      live.set(m.jobId, source);
      queue = queue.then(() =>
        runJob(m.jobId, m.options, (job) => transcribeLive(job, source, m.sampleRate)).finally(() => live.delete(m.jobId)),
      );
      break;
    }
    case "live-audio":
      live.get(m.jobId)?.push(m.pcm);
      break;
    case "live-stop":
      live.get(m.jobId)?.stop();
      break;
    case "cancel":
      cancelled.add(m.jobId);
      live.get(m.jobId)?.stop();
      break;
    case "punctuate":
      // Queued after transcription jobs: both use the same wasm runtime.
      queue = queue.then(() => punctuate(m.id, m.words));
      break;
  }
};
