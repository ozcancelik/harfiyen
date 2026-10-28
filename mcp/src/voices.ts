// The four text-to-speech models (src/tts), loaded from disk on the CPU and put behind one speak(). The loading is
// the web app's (src/worker/tts.worker.ts) without the worker, the download and the GPU.

import { join } from "node:path";
import * as ortNode from "onnxruntime-node";
import type { Ort } from "../../src/engine/models";
import { Ahenk, type AhenkManifest } from "../../src/tts/ahenk";
import { createFrontend, decodeAsset, type Frontend } from "../../src/tts/antalia-mini/frontend";
import { Engine as MiniEngine, speak as miniSpeak, type MiniManifest } from "../../src/tts/antalia-mini/tts";
import { Ema, loadNormalizer, RATE, type EmaMeta } from "../../src/tts/ema";
import { Supertonic, type SupertonicManifest } from "../../src/tts/supertonic";
import { readBytes, readJson, requireDir } from "./models";

const ort = ortNode as unknown as Ort;

export { RATE };

/** The text-to-speech models; Supertonic is the only one that reads English. */
export type VoiceModel = "ema" | "mini" | "ahenk" | "supertonic";
export type VoiceLang = "tr" | "en";

export interface Voice {
  lang: VoiceLang;
  model: VoiceModel;
  /** One of Supertonic's voices (M1–M5, F1–F5); the other models have one voice each. */
  style: string;
  /** Semitones; below 0 is deeper. Not for Supertonic. */
  pitch: number;
  /** The same seed gives the same reading. */
  seed: number;
}

export const VOICE_INFO: Record<VoiceModel, { dir: string; name: string; langs: VoiceLang[]; note: string }> = {
  ema: { dir: "ema-lightning", name: "EMA Lightning", langs: ["tr"], note: "Türkçe, varsayılan ses" },
  mini: { dir: "antalia-mini", name: "Antalia Mini", langs: ["tr"], note: "Türkçe, küçük model" },
  ahenk: { dir: "ahenk-cep", name: "Ahenk Cep", langs: ["tr"], note: "Türkçe; rakamları, tarihleri ve kısaltmaları en iyi okuyan, biraz yavaş" },
  supertonic: { dir: "supertonic-3", name: "Supertonic 3", langs: ["tr", "en"], note: "Türkçe ve İngilizce; 10 ses (M1–M5, F1–F5)" },
};

/** The raw model: text to audio at `rate`, `speed` above 1 reading faster. */
export interface Speaker {
  rate: number;
  speak(text: string, speed: number, voice: Voice): Promise<Float32Array>;
}

const turkish = (m: { speak(text: string, speed?: number, seed?: number): Promise<Float32Array> }): Speaker => ({
  rate: RATE,
  speak: (text, speed, voice) => m.speak(text, speed, voice.seed),
});

const join_ = (parts: Float32Array[]) => {
  const all = new Float32Array(parts.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of parts) {
    all.set(c, o);
    o += c.length;
  }
  return all;
};

/** Antalia Mini as the app wraps it (src/tts/mini.ts, which reaches for Vite's env and so cannot be imported here). */
async function loadMini(dir: string): Promise<Speaker> {
  const file = (n: string) => join(dir, n);
  const manifest = readJson<MiniManifest>(file("model.json"));
  const frontend: Frontend = createFrontend(await decodeAsset(readBytes(file("frontend-data.json.gz"))));
  frontend.warmup();
  const engine = await MiniEngine.create(
    ort as never,
    { text: readBytes(file("text.onnx")), cond: readBytes(file("cond.onnx")), flow: readBytes(file("flow.onnx")), vocoder: readBytes(file("vocoder.fp16.onnx")) },
    manifest,
    ["cpu"],
  );
  return turkish({
    async speak(text, speed = 1, seed = 0) {
      const out: Float32Array[] = [];
      // The release reads slightly slower than 1 by default; speed is relative to that.
      for await (const { audio } of miniSpeak(engine, frontend.modelText(text), { seed, speed: engine.defaults.speed * speed })) out.push(audio);
      return join_(out);
    },
  });
}

async function load(model: VoiceModel): Promise<Speaker> {
  const dir = requireDir(VOICE_INFO[model].dir, "model.json");
  const file = (n: string) => join(dir, n);
  const opts = { executionProviders: ["cpu"], graphOptimizationLevel: "all" as const, logSeverityLevel: 3 as const };
  const session = (n: string) => ort.InferenceSession.create(readBytes(file(n)), opts);
  if (model === "mini") return loadMini(dir);
  if (model === "supertonic") {
    const names = ["duration_predictor.onnx", "text_encoder.w16.onnx", "vector_estimator.w16.onnx", "vocoder.w16.onnx", "indexer.bin", "styles.bin"];
    const st = await Supertonic.load(ort, readJson<SupertonicManifest>(file("model.json")), names.map((n) => readBytes(file(n))), opts);
    return { rate: st.rate, speak: (text, speed, voice) => st.speak(text, voice.lang, voice.style, speed, voice.seed) };
  }
  if (model === "ahenk") {
    const sessions = { text: await session("text.f16.onnx"), cond: await session("cond.f16.onnx"), step: await session("step.f16.onnx"), decoder: await session("decoder.f16.onnx") };
    return turkish(new Ahenk(ort, readJson<AhenkManifest>(file("model.json")), sessions));
  }
  const sessions = { text: await session("text.onnx"), sound: await session("sound.onnx"), decoder: await session("decoder.onnx") };
  return turkish(new Ema(ort, readJson<EmaMeta>(file("model.json")), sessions, await loadNormalizer(readBytes(file("normalizer.wasm")))));
}

const loaded = new Map<VoiceModel, Promise<Speaker>>();

/** Each model loaded once and kept. */
export function speaker(model: VoiceModel): Promise<Speaker> {
  let p = loaded.get(model);
  if (!p) {
    p = load(model);
    loaded.set(model, p);
    p.catch(() => loaded.delete(model));
  }
  return p;
}

/** Only Supertonic reads English; a voice for a language its model does not know is moved to Supertonic. */
export function fitVoice(v: Voice): Voice {
  return v.lang === "en" ? { ...v, model: "supertonic" } : v;
}
