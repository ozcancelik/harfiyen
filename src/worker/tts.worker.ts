/// <reference lib="webworker" />
// Dubbing: reads every line aloud with EMA Lightning, Antalia Mini, Ahenk Cep or Supertonic 3 and places it at the line's start time. A line that
// does not fit before the next one is spoken faster, up to MAX_SPEED; past that it runs over and the next line
// starts late. The voice's pitch is moved by synthesising at a matching speed and resampling, so it does not change
// how long a line takes. Supertonic speaks at 44.1 kHz; its lines are brought to 48 kHz in the same resampling.
// Supertonic swallows the end of a line when pushed much past its own pace, so it is sped up less, may start a
// little before its line instead, and keeps its pitch.
//
// Nothing is heard past `end` (the video's end, or the trim's): when the last line runs over it, it and the lines
// before it move earlier into the pauses between them; with no pause left, the lines of the last seconds are read
// faster, as far as the model allows, from the last back. What still runs over is reported, so a line can be
// shortened.

import * as ort from "onnxruntime-web/webgpu";
import ortWasmUrl from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url";
import ortMjsUrl from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url";
import { packFileUrl, VOICE_PACKS } from "../models";
import { Ahenk, type AhenkManifest } from "../tts/ahenk";
import type { DubClip } from "../tts/dub";
import { Ema, loadNormalizer, RATE, type EmaMeta } from "../tts/ema";
import { Mini, type MiniManifest } from "../tts/mini";
import { Supertonic, type SupertonicManifest } from "../tts/supertonic";
import { fetchAll, fetchManifest } from "./modelStore";

declare const self: DedicatedWorkerGlobalScope;

export interface DubLine {
  start: number;
  end: number;
  text: string;
}

/** The text-to-speech models; Supertonic is the only one that reads English. */
export type VoiceModel = "ema" | "mini" | "ahenk" | "supertonic";

/** The language the dub is read in: the transcript's, or its English translation. */
export type DubLang = "tr" | "en";

export interface Voice {
  lang: DubLang;
  model: VoiceModel;
  /** One of Supertonic's voices (M1–M5, F1–F5); the other models have one voice each. */
  style: string;
  /** Semitones; below 0 is deeper. */
  pitch: number;
  /** The same seed gives the same reading. */
  seed: number;
}

/** The last line heard runs past the end by `seconds`, even moved and sped up; it starts at `start` in the media. */
export interface DubOverflow {
  start: number;
  seconds: number;
}

export type ToTts =
  /** `end`: where the dub must be over by, at the latest. */
  | { type: "dub"; jobId: number; lines: DubLine[]; duration: number; end: number; voice: Voice }
  | { type: "preview"; jobId: number; text: string; voice: Voice }
  | { type: "cancel"; jobId: number };

export type FromTts =
  | { type: "download"; jobId: number; loaded: number; total: number }
  | { type: "progress"; jobId: number; done: number; total: number }
  | { type: "done"; jobId: number; clips: DubClip[]; overflow: DubOverflow | null; elapsed: number }
  | { type: "preview"; jobId: number; audio: Float32Array }
  | { type: "cancelled"; jobId: number }
  | { type: "error"; jobId: number; message: string };

/** Approximate; the real size is settled once the download finishes. */
const ORT_WASM_SIZE = 26_800_000;
const MAX_SPEED = 1.35;
/** Supertonic reads at 1.05 already; past about 1.2 in all it starts dropping the last syllables. */
const MAX_SPEED_SUPERTONIC = 1.15;
/** How much earlier than its line a Supertonic line may start, into the silence before it. */
const LEAD_SUPERTONIC = 0.4;
/** How far back from the end lines may be read faster to fit the last one in. */
const TAIL = 20;
/** Silence kept between two lines when the first one runs late. */
const GAP = 0.05;
/** Silence between sentences when reading standalone text (no media clock). */
const FREE_GAP = 0.22;

const post = (m: FromTts, transfer: Transferable[] = []) => self.postMessage(m, transfer);
const cancelled = new Set<number>();

interface Speaker {
  /** Samples per second of what speak() returns. */
  rate: number;
  speak(text: string, speed: number, voice: Voice): Promise<Float32Array>;
}

/** One of the Turkish-only models, which speak at RATE. */
const turkish = (m: { speak(text: string, speed?: number, seed?: number): Promise<Float32Array> }): Speaker => ({
  rate: RATE,
  speak: (text, speed, voice) => m.speak(text, speed, voice.seed),
});

const speakers = new Map<VoiceModel, Promise<Speaker>>();
/** WebGPU adapter, or null for the CPU; set with the runtime, once, before the first session. */
let adapter: GPUAdapter | null | undefined;

async function load(jobId: number, model: VoiceModel): Promise<Speaker> {
  const pack = VOICE_PACKS[model];
  const { data: meta } = await fetchManifest<Record<string, any>>(packFileUrl(pack, pack.manifest));
  if (!meta) throw new Error("Seslendirme modeli bulunamadı. Önce `npm run models` çalıştırılmalı.");
  const names = pack.files;
  const runtime = adapter === undefined ? [{ url: ortWasmUrl, size: ORT_WASM_SIZE, approx: true }] : [];
  const files = await fetchAll(
    [...names.map((n) => ({ url: packFileUrl(pack, n), size: meta.files[n] as number })), ...runtime],
    (loaded, total) => post({ type: "download", jobId, loaded, total }),
  );

  if (adapter === undefined) {
    adapter = (await navigator.gpu?.requestAdapter().catch(() => null)) ?? null;
    ort.env.wasm.wasmBinary = files[names.length].buffer as ArrayBuffer;
    // See asr.worker.ts: wasm threads load this script, not the worker bundle.
    if (import.meta.env.PROD) ort.env.wasm.wasmPaths = { mjs: new URL(ortMjsUrl, self.location.href) };
    ort.env.wasm.numThreads =
      adapter || !self.crossOriginIsolated ? 1 : Math.max(1, Math.min(4, Math.ceil((navigator.hardwareConcurrency || 2) / 2)));
    ort.env.logLevel = "error";
  }

  const create = async (providers: string[]): Promise<Speaker> => {
    if (model === "mini") return turkish(await Mini.load(ort, meta as MiniManifest, files.slice(0, names.length), providers));
    const opts = { executionProviders: providers, graphOptimizationLevel: "all" as const };
    if (model === "supertonic") {
      const st = await Supertonic.load(ort, meta as SupertonicManifest, files.slice(0, names.length), opts);
      return { rate: st.rate, speak: (text, speed, voice) => st.speak(text, voice.lang, voice.style, speed, voice.seed) };
    }
    // Sequential: the wasm runtime rejects concurrent initialisation.
    if (model === "ahenk") {
      const [text, cond, step, decoder] = files;
      const sessions = {
        text: await ort.InferenceSession.create(text, opts),
        cond: await ort.InferenceSession.create(cond, opts),
        step: await ort.InferenceSession.create(step, opts),
        decoder: await ort.InferenceSession.create(decoder, opts),
      };
      return turkish(new Ahenk(ort, meta as AhenkManifest, sessions));
    }
    const [text, sound, decoder] = files;
    const sessions = {
      text: await ort.InferenceSession.create(text, opts),
      sound: await ort.InferenceSession.create(sound, opts),
      decoder: await ort.InferenceSession.create(decoder, opts),
    };
    return turkish(new Ema(ort, meta as EmaMeta, sessions, await loadNormalizer(files[3])));
  };
  try {
    return await create(adapter ? ["webgpu", "wasm"] : ["wasm"]);
  } catch (e) {
    if (!adapter) throw e;
    console.warn("WebGPU session failed, using the CPU", e);
    return create(["wasm"]);
  }
}

/** Loaded once per model; all stay loaded. */
function getSpeaker(jobId: number, model: VoiceModel) {
  let p = speakers.get(model);
  if (!p) {
    p = load(jobId, model);
    speakers.set(model, p);
    p.catch(() => speakers.delete(model));
  }
  return p;
}

/** Plays `x` `ratio` times faster by linear interpolation: higher and shorter above 1. */
function resample(x: Float32Array, ratio: number): Float32Array {
  if (Math.abs(ratio - 1) < 1e-9 || x.length < 2) return x;
  const y = new Float32Array(Math.floor((x.length - 1) / ratio) + 1);
  for (let k = 0; k < y.length; k++) {
    const pos = k * ratio;
    const i = Math.floor(pos);
    const b = i + 1 < x.length ? x[i + 1] : x[i];
    y[k] = x[i] + (b - x[i]) * (pos - i);
  }
  return y;
}

/** Below this, relative to the line's loudest sample (-50 dB), is silence. */
const SILENCE = 0.003;
/** Silence kept before and after the speech, so its first and last sounds are not clipped. */
const KEEP_BEFORE = 0.04;
const KEEP_AFTER = 0.08;

/**
 * The speech without the silence the model puts around it (Supertonic: about 0.4 s on each side), which would
 * otherwise push every following line later. The cut falls in silence; a few milliseconds of fade make sure.
 */
function trimSilence(x: Float32Array): Float32Array {
  let peak = 0;
  for (const v of x) peak = Math.max(peak, Math.abs(v));
  if (!peak) return x;
  const floor = peak * SILENCE;
  let first = 0;
  while (first < x.length && Math.abs(x[first]) <= floor) first++;
  let last = x.length - 1;
  while (last > first && Math.abs(x[last]) <= floor) last--;
  const from = Math.max(0, first - Math.round(KEEP_BEFORE * RATE));
  const to = Math.min(x.length, last + 1 + Math.round(KEEP_AFTER * RATE));
  if (from === 0 && to === x.length) return x;
  const y = x.slice(from, to);
  const fade = Math.min(Math.round(0.005 * RATE), y.length >> 1);
  for (let i = 0; i < fade; i++) {
    y[i] *= i / fade;
    y[y.length - 1 - i] *= i / fade;
  }
  return y;
}

/** At RATE; `speed` above 1 speaks faster. The pitch shift leaves the length as it would be without it. */
async function speak(speaker: Speaker, text: string, voice: Voice, speed = 1) {
  const ratio = voice.model === "supertonic" ? 1 : 2 ** (voice.pitch / 12);
  return trimSilence(resample(await speaker.speak(text, speed / ratio, voice), (ratio * speaker.rate) / RATE));
}

async function dub(jobId: number, lines: DubLine[], duration: number, end: number, voice: Voice) {
  const started = performance.now();
  const speaker = await getSpeaker(jobId, voice.model);
  const st = voice.model === "supertonic";
  const maxSpeed = st ? MAX_SPEED_SUPERTONIC : MAX_SPEED;
  const lead = st ? LEAD_SUPERTONIC : 0;
  const clips: DubClip[] = [];
  /** Per clip: its line, and its length at the model's own pace and how much faster it was read. */
  const made: { line: number; natural: number; speed: number }[] = [];
  const length = (c: DubClip) => c.audio.length / RATE;
  const timed = end > 0;
  let free = 0; // where the previous clip ends
  for (let i = 0; i < lines.length; i++) {
    if (cancelled.has(jobId)) return post({ type: "cancelled", jobId });
    post({ type: "progress", jobId, done: i, total: lines.length });
    const line = lines[i];
    let audio = await speak(speaker, line.text, voice);
    const seconds = audio.length / RATE;
    if (!timed) {
      if (!audio.length) continue;
      clips.push({ line: i, start: free, audio });
      made.push({ line: i, natural: seconds, speed: 1 });
      free += seconds + FREE_GAP;
      continue;
    }
    const next = i + 1 < lines.length ? lines[i + 1].start : Math.max(duration, line.end);
    // Too long for its place: start earlier, as far as the silence before it allows, then speak faster.
    let start = Math.max(line.start, free);
    if (seconds > next - start) start = Math.max(free, line.start - lead, Math.min(start, next - seconds));
    const room = next - start;
    let speed = 1;
    if (seconds > room && room > 0) {
      speed = Math.min(maxSpeed, seconds / room);
      audio = await speak(speaker, line.text, voice, speed);
    }
    if (!audio.length) continue;
    clips.push({ line: i, start, audio });
    made.push({ line: i, natural: seconds, speed });
    free = start + audio.length / RATE + GAP;
  }

  // The last clip whose line starts before `end` must be over by then. By its line, not by where it was placed:
  // lines running late may have pushed a short last one ("Bye.") past the end altogether.
  let last = -1;
  if (timed) for (let k = 0; k < clips.length; k++) if (lines[made[k].line].start < end) last = k;
  let overflow: DubOverflow | null = null;
  if (last >= 0 && clips[last].start + length(clips[last]) > end) {
    /** Moves the last clip, and the ones before it as it reaches them, earlier into the pauses between them; what is left over. */
    const fit = () => {
      let over = clips[last].start + length(clips[last]) - end;
      for (let k = last; k >= 0 && over > 0; k--) {
        const before = k > 0 ? clips[k - 1].start + length(clips[k - 1]) + GAP : 0;
        const shift = Math.min(over, Math.max(0, clips[k].start - before));
        for (let j = k; j <= last; j++) clips[j].start -= shift;
        over -= shift;
      }
      return over;
    };
    let over = fit();
    // No pause left: the lines before the end read faster too, as far as the model allows, from the last back.
    for (let k = last; k >= 0 && over > 0.05; k--) {
      const m = made[k];
      if (lines[m.line].start < end - TAIL) break;
      if (m.speed >= maxSpeed) continue;
      if (cancelled.has(jobId)) return post({ type: "cancelled", jobId });
      const audio = await speak(speaker, lines[m.line].text, voice, maxSpeed);
      if (!audio.length) continue;
      clips[k].audio = audio;
      m.speed = maxSpeed;
      over = fit();
    }
    // A few hundredths are not worth a word.
    if (over > 0.05) overflow = { start: lines[made[last].line].start, seconds: over };
  }

  post(
    { type: "done", jobId, clips, overflow, elapsed: (performance.now() - started) / 1000 },
    clips.map((c) => c.audio.buffer as ArrayBuffer),
  );
}

self.onmessage = (ev: MessageEvent<ToTts>) => {
  const m = ev.data;
  if (m.type === "cancel") {
    cancelled.add(m.jobId);
    return;
  }
  const job =
    m.type === "dub"
      ? dub(m.jobId, m.lines, m.duration, m.end, m.voice)
      : getSpeaker(m.jobId, m.voice.model)
          .then((speaker) => speak(speaker, m.text, m.voice))
          .then((audio) => post({ type: "preview", jobId: m.jobId, audio }, [audio.buffer as ArrayBuffer]));
  job
    .catch((e) => post({ type: "error", jobId: m.jobId, message: e instanceof Error ? e.message : String(e) }))
    .finally(() => cancelled.delete(m.jobId));
};
