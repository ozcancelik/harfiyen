/// <reference lib="webworker" />
import { ALL_FORMATS, AudioSampleSink, BlobSource, Input } from "mediabunny";
import * as ort from "onnxruntime-web/webgpu";
import ortWasmUrl from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url";
import ortMjsUrl from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url";
import {
  downmix,
  Engine,
  Resampler,
  type DecodeOptions,
  type EncoderProvider,
  type ModelConfig,
} from "../engine";
import type { SpeechEngine, SpeechStream } from "../engine/stream";
import { modelFileUrl, modelInfo, packFileUrl, PUNCT_PACK, type ModelId, type ModelInfo } from "../models";
import { Formatter, type FormatterConfig } from "../punct/formatter";
import type { WordPieceVocab } from "../punct/wordpiece";
import { fetchAll, fetchManifest } from "./modelStore";
import { readPcm } from "./pcm";
import { BandTracker } from "../render/aura";
import { WhisperEngine, type WhisperConfig } from "../whisper";
import { DuyuEngine, type DuyuConfig } from "../duyu";
import { PEAK_STEP, type AlignSpan, type ErrorCode, type FromWorker, type ProviderChoice, type ToWorker } from "./protocol";
import type { SpeechLang } from "../engine/config";

declare const self: DedicatedWorkerGlobalScope;

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

let enginePromise: Promise<SpeechEngine> | null = null;
/** Set by `init`; a worker serves one model and provider for its whole life. */
let modelChoice: ModelId = "seda";
let providerChoice: ProviderChoice = "auto";
let cpuReason: string | null = null;
const cancelled = new Set<number>();

interface ProviderPick {
  provider: EncoderProvider;
  gpu: string | null;
  reason: string | null;
  /** 16-bit float shaders, which fp16 models need. */
  f16: boolean;
}

async function pickProvider(choice: ProviderChoice): Promise<ProviderPick> {
  if (choice === "wasm") return { provider: "wasm", gpu: null, reason: null, f16: false };
  if (!("gpu" in navigator) || !navigator.gpu) {
    return { provider: "wasm", gpu: null, reason: "Bu tarayıcı WebGPU desteklemiyor.", f16: false };
  }
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) return { provider: "wasm", gpu: null, reason: "WebGPU açık ama uygun bir GPU bulunamadı.", f16: false };
  const info = adapter.info;
  const gpu = [info?.vendor, info?.architecture || info?.description].filter(Boolean).join(" ") || "GPU";
  return { provider: "webgpu", gpu, reason: null, f16: adapter.features.has("shader-f16") };
}

/**
 * Threads for the wasm runtime. Fixed once the runtime starts, so a worker
 * picks it from its provider and switching provider means a new worker.
 */
function wasmThreads(provider: EncoderProvider, searchOnCpu: boolean) {
  // On the GPU only the small models run here; per-call work is too tiny for
  // extra threads to pay off, except in Seda's search (the LM, eight paths in
  // files), which takes most of the time and runs 2.5x faster with four. On
  // the CPU the encoder needs them.
  if (!self.crossOriginIsolated || (provider === "webgpu" && !searchOnCpu)) return 1;
  return Math.max(1, Math.min(4, Math.ceil((navigator.hardwareConcurrency || 2) / 2)));
}

async function readConfig<T>(m: ModelInfo): Promise<T> {
  const { data } = await fetchManifest<T>(modelFileUrl(m, "model.json"));
  if (!data) throw new JobError("model", "model.json bulunamadı. Önce `npm run models` çalıştırılmalı.");
  return data;
}

/** Model files plus the wasm runtime, with progress posted to the page. */
function download(m: ModelInfo, sizes: Record<string, number>) {
  return fetchAll(
    [...m.files.map((n) => ({ url: modelFileUrl(m, n), size: sizes[n] })), { url: ortWasmUrl, size: ORT_WASM_SIZE, approx: true }],
    (loaded, total, fromCache) => post({ type: "download", loaded, total, fromCache }),
  );
}

/**
 * Start the wasm runtime. Must happen once, before the first session.
 * searchOnCpu: the model's search runs here even on the GPU (Seda).
 */
function setupRuntime(wasm: Uint8Array, provider: EncoderProvider, searchOnCpu = false) {
  ort.env.wasm.wasmBinary = wasm.buffer as ArrayBuffer;
  // wasm threads load this script. Without it they load the bundle ORT is
  // built into, i.e. this worker in production, and never start. The dev
  // server already serves ORT as its own module.
  if (import.meta.env.PROD) ort.env.wasm.wasmPaths = { mjs: new URL(ortMjsUrl, self.location.href) };
  ort.env.wasm.numThreads = wasmThreads(provider, searchOnCpu);
  ort.env.logLevel = "error";
}

/**
 * Create the sessions. A failure on the GPU is a driver or memory problem:
 * the wasm runtime is already set up for the GPU (one thread), so the page
 * restarts the worker on the CPU instead of falling back in place.
 */
async function createOnProvider<T>(pick: ProviderPick, create: () => Promise<T>): Promise<T> {
  try {
    return await create();
  } catch (e) {
    if (pick.provider !== "webgpu") throw e;
    console.warn("WebGPU session failed", e);
    throw new JobError("gpu", "WebGPU oturumu açılamadı.");
  }
}

async function loadSeda(m: ModelInfo, pick: ProviderPick): Promise<SpeechEngine> {
  const config = await readConfig<ModelConfig>(m);
  const downloaded = await download(m, config.files);
  const wasm = downloaded[downloaded.length - 1];
  const byName = Object.fromEntries(m.files.map((name, i) => [name, downloaded[i]]));
  post({ type: "compiling" });
  setupRuntime(wasm, pick.provider, true);
  const lodr = byName["lodr.bin"];
  const files = {
    config,
    encoder: byName["encoder.webgpu.onnx"],
    decoder: byName["decoder.onnx"] ?? byName["decoder.int8.onnx"],
    joiner: byName["joiner.int8.onnx"],
    lm: byName["rnnlm.int8.onnx"],
    lodr: lodr ? (lodr.buffer.slice(lodr.byteOffset, lodr.byteOffset + lodr.byteLength) as ArrayBuffer) : undefined,
    tokens: new TextDecoder().decode(byName["tokens.txt"]),
    final: byName["encoder.final.webgpu.onnx"],
    vad: byName["silero_vad.onnx"],
  };
  return createOnProvider(pick, () => Engine.create(ort, files, pick.provider));
}

async function loadWhisper(m: ModelInfo, pick: ProviderPick): Promise<SpeechEngine> {
  // Checked before the large download: Whisper does not run on the CPU here.
  if (pick.provider !== "webgpu") {
    throw new JobError(
      "model",
      pick.reason ? `${m.name} ekran kartı gerektirir. ${pick.reason}` : `${m.name} işlemcide (WASM) çalışmaz, ekran kartı gerekir.`,
    );
  }
  if (m.needsF16 && !pick.f16) throw new JobError("model", `Bu ekran kartı ${m.name} için gereken 16 bit hesaplamayı (shader-f16) desteklemiyor.`);
  const config = await readConfig<WhisperConfig>(m);
  const [encoder, decoder, vocab, vad, wasm] = await download(m, config.files);
  post({ type: "compiling" });
  setupRuntime(wasm, pick.provider);
  const files = { config, encoder, decoder, vocab: JSON.parse(new TextDecoder().decode(vocab)), vad };
  return createOnProvider(pick, () => WhisperEngine.create(ort, files, pick.provider));
}

async function loadDuyu(m: ModelInfo): Promise<SpeechEngine> {
  const config = await readConfig<DuyuConfig>(m);
  const [pre, pass, postGraph, decoder, fbank, tokens, wasm] = await download(m, config.files);
  post({ type: "compiling" });
  setupRuntime(wasm, "wasm");
  const pieces: string[] = JSON.parse(new TextDecoder().decode(tokens));
  return DuyuEngine.create(ort, { config, pre, pass, post: postGraph, decoder, fbank, pieces });
}

/** CPU-only models skip the GPU check: the CPU is not a fallback for them. */
const CPU_PICK: ProviderPick = { provider: "wasm", gpu: null, reason: null, f16: false };

async function loadEngine(model: ModelId, choice: ProviderChoice): Promise<SpeechEngine> {
  const m = modelInfo(model);
  const pick = m.cpuOnly ? CPU_PICK : await pickProvider(choice);
  const engine = await (m.engine === "whisper"
    ? loadWhisper(m, pick)
    : m.engine === "duyu"
      ? loadDuyu(m)
      : loadSeda(m, pick));
  post({
    type: "ready",
    provider: engine.provider === "webgpu" ? "webgpu" : "wasm",
    gpu: pick.gpu,
    fallbackReason: m.cpuOnly ? null : (pick.reason ?? cpuReason),
  });
  return engine;
}

function getEngine() {
  if (!enginePromise) {
    enginePromise = loadEngine(modelChoice, providerChoice).catch((e) => {
      enginePromise = null;
      throw e;
    });
  }
  return enginePromise;
}

let punctPromise: Promise<Formatter> | null = null;

/** The formatter is loaded on first use (≈30 MB, cached like the rest). */
function getPunctuator(id: number): Promise<Formatter> {
  punctPromise ??= (async () => {
    const { data: cfg } = await fetchManifest<FormatterConfig>(packFileUrl(PUNCT_PACK, PUNCT_PACK.manifest));
    if (!cfg) throw new Error("Noktalama modeli bulunamadı. `npm run models` çalıştırılmalı.");
    const [model, vocab] = await fetchAll(
      PUNCT_PACK.files.map((f) => ({ url: packFileUrl(PUNCT_PACK, f), size: cfg.files[f] })),
      (done, total) => post({ type: "punct-progress", id, phase: "download", done, total }),
    );
    // Shares the wasm runtime loaded for the recognizer.
    await getEngine();
    const pieces: WordPieceVocab = JSON.parse(new TextDecoder().decode(vocab));
    return Formatter.create(ort, model, pieces, cfg);
  })().catch((e) => {
    punctPromise = null;
    throw e;
  });
  return punctPromise;
}

async function punctuate(id: number, words: string[]) {
  try {
    const p = await getPunctuator(id);
    const written = await p.run(words, (done, total) => post({ type: "punct-progress", id, phase: "run", done, total }));
    post({ type: "punctuated", id, words: written });
  } catch (e) {
    post({ type: "punct-error", id, message: e instanceof Error ? e.message : String(e) });
  }
}

/** Feeds 16 kHz audio through the recognizer and reports progress. */
class Job {
  private rec: SpeechStream;
  private resampler: Resampler | null = null;
  private peaks: number[] = [];
  private bands = new BandTracker();
  private peakAcc = 0;
  private peakCount = 0;
  private lastPost = 0;
  private started = performance.now();

  private onGpu: boolean;

  /**
   * offset: seconds of the file before this job's audio (a continued job); times are reported from the file's start.
   * live: the microphone.
   */
  constructor(
    readonly id: number,
    engine: SpeechEngine,
    options: DecodeOptions,
    readonly offset = 0,
    live = false,
  ) {
    this.onGpu = engine.provider === "webgpu";
    this.rec = engine.createRecognizer(options, live);
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
      try {
        await this.rec.decodeChunk();
      } catch (e) {
        // On the GPU this is a driver or device failure (lost device, out of
        // memory); the page can retry on the CPU.
        if (!this.onGpu) throw e;
        console.warn("WebGPU decode failed", e);
        throw new JobError("gpu", "Ekran kartı (WebGPU) yazıya dökme sırasında hata verdi.");
      }
      this.maybePost();
    }
  }

  /** Words with times from the file's start. */
  private committed() {
    const words = this.rec.takeCommitted();
    if (this.offset) for (const w of words) Object.assign(w, { start: w.start + this.offset, end: w.end + this.offset });
    return words;
  }

  private tentative() {
    const words = this.rec.tentative();
    return this.offset ? words.map((w) => ({ ...w, start: w.start + this.offset, end: w.end + this.offset })) : words;
  }

  finish() {
    this.rec.flush();
    const elapsed = (performance.now() - this.started) / 1000;
    post({
      type: "done",
      jobId: this.id,
      committed: this.committed(),
      decoded: this.offset + this.rec.decodedSeconds,
      elapsed,
      bands: this.bands.take(),
      loudness: this.bands.takeLoudness(),
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
    const loudness = this.bands.takeLoudness();
    const decoded = this.rec.decodedSeconds;
    post(
      {
        type: "progress",
        jobId: this.id,
        decoded: this.offset + decoded,
        committed: this.committed(),
        tentative: this.tentative(),
        peaks,
        bands,
        loudness,
        speed: decoded / ((now - this.started) / 1000),
      },
      [peaks.buffer, bands.buffer, loudness.buffer],
    );
  }
}

async function transcribeFile(job: Job, file: File, endAt?: number) {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  let track;
  try {
    track = await input.getPrimaryAudioTrack();
  } catch {
    throw new JobError("decode-unsupported", "Dosya biçimi tanınmadı.");
  }
  if (!track) throw new JobError("no-audio", "Bu dosyada ses kanalı yok.");
  if (!(await track.canDecode())) throw new JobError("decode-unsupported", `Sesin kodlaması (${track.codec ?? "bilinmiyor"}) bu tarayıcıda çözülemiyor.`);

  post({ type: "meta", jobId: job.id, duration: await track.computeDuration() });
  job.setSampleRate(track.sampleRate);

  const sink = new AudioSampleSink(track);
  const from = job.offset;
  for await (const sample of sink.samples(from || undefined, endAt)) {
    if (job.isCancelled) {
      sample.close();
      break;
    }
    // A range starts and ends exactly where asked: the first sample may begin before it, the last end after it.
    const frames = sample.numberOfFrames;
    const skip = Math.max(0, Math.min(frames, Math.round((from - sample.timestamp) * sample.sampleRate)));
    const stop =
      endAt === undefined ? frames : Math.max(skip, Math.min(frames, Math.round((endAt - sample.timestamp) * sample.sampleRate)));
    const channels: Float32Array[] = [];
    for (let ch = 0; ch < sample.numberOfChannels; ch++) {
      const buf = new Float32Array(frames);
      sample.copyTo(buf, { planeIndex: ch, format: "f32-planar" });
      channels.push(skip || stop < frames ? buf.subarray(skip, stop) : buf);
    }
    sample.close();
    if (skip < stop) await job.push(downmix(channels));
  }
  input.dispose();
}

/** A pasted text: Whisper times its known words span by span. From emguts/harfiyen. */
async function alignAudio(id: number, file: File, lang: SpeechLang, spans: AlignSpan[]) {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    const engine = await getEngine();
    if (!(engine instanceof WhisperEngine)) {
      throw new Error("Sesle ince ayar yalnızca Whisper ile çalışır; model olarak Whisper'ı seç.");
    }
    const track = await input.getPrimaryAudioTrack();
    if (!track) throw new Error("Bu dosyada ses kanalı yok.");
    const sink = new AudioSampleSink(track);
    const out: ({ start: number; end: number }[] | null)[] = [];
    post({ type: "align-progress", id, done: 0, total: spans.length });
    for (const [n, s] of spans.entries()) {
      const pcm = await readPcm(sink, track.sampleRate, s.start, s.end);
      out.push(await engine.alignText(pcm, s.start, s.words, lang));
      post({ type: "align-progress", id, done: n + 1, total: spans.length });
    }
    post({ type: "aligned", id, spans: out });
  } catch (e) {
    post({ type: "align-error", id, message: String((e as Error)?.message ?? e) });
  } finally {
    input.dispose();
  }
}

async function transcribePcm(job: Job, pcm: Float32Array, sampleRate: number, endAt?: number) {
  post({ type: "meta", jobId: job.id, duration: pcm.length / sampleRate });
  job.setSampleRate(sampleRate);
  const step = sampleRate * 2;
  const end = endAt === undefined ? pcm.length : Math.min(pcm.length, Math.round(endAt * sampleRate));
  for (let i = Math.round(job.offset * sampleRate); i < end && !job.isCancelled; i += step) {
    await job.push(pcm.subarray(i, Math.min(end, i + step)));
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

async function runJob(jobId: number, options: DecodeOptions, feed: (job: Job) => Promise<void>, startAt = 0, live = false) {
  let job: Job | null = null;
  try {
    const engine = await getEngine();
    job = new Job(jobId, engine, options, startAt, live);
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
      modelChoice = m.model;
      providerChoice = m.provider;
      cpuReason = m.reason ?? null;
      getEngine().catch((e) =>
        post({ type: "error", jobId: null, code: e instanceof JobError ? e.code : "model", message: String(e?.message ?? e) }),
      );
      break;
    case "transcribe":
      queue = queue.then(() => runJob(m.jobId, m.options, (job) => transcribeFile(job, m.file, m.endAt), m.startAt));
      break;
    case "transcribe-pcm":
      queue = queue.then(() =>
        runJob(m.jobId, m.options, (job) => transcribePcm(job, m.pcm, m.sampleRate, m.endAt), m.startAt),
      );
      break;
    case "live-start": {
      const source = new LiveSource();
      live.set(m.jobId, source);
      queue = queue.then(() =>
        runJob(m.jobId, m.options, (job) => transcribeLive(job, source, m.sampleRate), 0, true).finally(() =>
          live.delete(m.jobId),
        ),
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
    case "align":
      // Queued after transcription jobs: the same model does both.
      queue = queue.then(() => alignAudio(m.id, m.file, m.lang, m.spans));
      break;
  }
};
