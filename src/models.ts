// The speech models the user can choose from. Files live under
// VITE_MODELS_BASE_URL (default /models) in each model's directory.

import type { SpeechLang } from "./engine/config";
import { MT_LANGS, SPEECH_LANGS, type MtLang } from "./engine/languages";

const ALL_LANGS: SpeechLang[] = SPEECH_LANGS.map((l) => l.code);

export type ModelId = "seda" | "mihu" | "duyu" | "whisper-turbo" | "whisper-turbo-q4";

export const MODELS_BASE = (import.meta.env.VITE_MODELS_BASE_URL || `${import.meta.env.BASE_URL}models`).replace(/\/+$/, "");

export interface ModelInfo {
  id: ModelId;
  /** Which engine runs it. */
  engine: "seda" | "duyu" | "whisper";
  name: string;
  /** Short tag next to the name. */
  tier: string;
  note: string;
  /** Approximate first download, ONNX runtime included. */
  size: string;
  /** Model and weight precision, for the inspector and exports. */
  spec: string;
  dir: string;
  /**
   * Files listed in the directory's model.json, downloaded and cached.
   * Whisper: encoder, decoder, vocab, VAD, in this order. Seda: streaming
   * encoder, decoder, joiner, LM, LODR, tokens, final encoder, VAD.
   */
  files: string[];
  link: string;
  /** Streams with low latency, so it can transcribe the microphone. */
  live: boolean;
  /** Needs WebGPU. */
  gpuOnly: boolean;
  /** Always runs on the CPU (WASM), whatever the provider choice. */
  cpuOnly: boolean;
  /** Needs 16-bit float shaders (shader-f16) on the GPU. */
  needsF16: boolean;
  /** Writes punctuation and capitals itself. */
  punctuates: boolean;
  /** The languages it transcribes. */
  langs: SpeechLang[];
}

/** Lightest first, as the menu lists them. */
export const MODELS: ModelInfo[] = [
  {
    id: "seda",
    engine: "seda",
    name: "Seda",
    tier: "Hızlı",
    note: "Küçük ve hızlı; canlı kayıtta ve her cihazda çalışır.",
    size: "190 MB",
    spec: "seda-v0.2",
    dir: "seda-v0.2",
    files: [
      "encoder.webgpu.onnx",
      "decoder.onnx",
      "joiner.int8.onnx",
      "rnnlm.int8.onnx",
      "lodr.bin",
      "tokens.txt",
      "encoder.final.webgpu.onnx",
      "silero_vad.onnx",
    ],
    link: "https://huggingface.co/atasoglu/seda-v0.2",
    live: true,
    gpuOnly: false,
    cpuOnly: false,
    needsF16: false,
    punctuates: false,
    langs: ["tr"],
  },
  {
    id: "mihu",
    engine: "seda",
    name: "Mihu",
    tier: "Çok hızlı",
    note: "Küçük ve düşük gecikmeli; canlı kayıtta ve her cihazda çalışır.",
    size: "70 MB",
    spec: "turkish-stt-66m-v2",
    dir: "turkish-stt-66m-v2",
    files: [
      "encoder.webgpu.onnx",
      "decoder.int8.onnx",
      "joiner.int8.onnx",
      "tokens.txt",
      "silero_vad.onnx",
    ],
    link: "https://huggingface.co/mihuai/turkish-stt-66m-v2",
    live: true,
    gpuOnly: false,
    cpuOnly: false,
    needsF16: false,
    punctuates: false,
    langs: ["tr"],
  },
  {
    id: "duyu",
    engine: "duyu",
    name: "Duyu",
    tier: "Hafif",
    note: "Küçük; noktalama ve büyük harfi kendisi yazar. İşlemcide çalışır; canlı kayıtta kullanılmaz.",
    size: "85 MB",
    spec: "Duyu-small (int8)",
    dir: "duyu-small",
    files: ["encoder_pre.onnx", "encoder_pass.onnx", "encoder_post.onnx", "decoder.onnx", "fbank.bin", "tokens.json"],
    link: "https://huggingface.co/KaanAydinli/Duyu-small",
    live: false,
    gpuOnly: false,
    cpuOnly: true,
    needsF16: false,
    punctuates: true,
    langs: ["tr"],
  },
  {
    id: "whisper-turbo-q4",
    engine: "whisper",
    name: "Whisper Turbo Hafif",
    tier: "Daha küçük",
    note: "Whisper Turbo'nun 4 bitlik hâli: üçte bir boyutta, zor seste biraz daha fazla hata. Ekran kartı gerekir; canlı kayıtta kullanılmaz.",
    size: "600 MB",
    spec: "whisper-large-v3-turbo (q4f16 encoder, q4f16 decoder)",
    dir: "whisper-large-v3-turbo",
    files: ["encoder_model_q4f16.onnx", "decoder_model_merged_q4f16.onnx", "vocab.json", "silero_vad.onnx"],
    link: "https://huggingface.co/openai/whisper-large-v3-turbo",
    live: false,
    gpuOnly: true,
    cpuOnly: false,
    needsF16: true,
    punctuates: true,
    langs: ALL_LANGS,
  },
  {
    id: "whisper-turbo",
    engine: "whisper",
    name: "Whisper Turbo",
    tier: "Yüksek doğruluk",
    note: "En az hata, noktalama ve rakamlarla yazar. Büyük indirme, ekran kartı gerekir; canlı kayıtta kullanılmaz.",
    size: "1,5 GB",
    spec: "whisper-large-v3-turbo (fp16 encoder, q4f16 decoder)",
    dir: "whisper-large-v3-turbo",
    files: ["encoder_model_fp16.onnx", "decoder_model_merged_q4f16.onnx", "vocab.json", "silero_vad.onnx"],
    link: "https://huggingface.co/openai/whisper-large-v3-turbo",
    live: false,
    gpuOnly: true,
    cpuOnly: false,
    needsF16: true,
    punctuates: true,
    langs: ALL_LANGS,
  },
];

export const DEFAULT_MODEL: ModelId = "seda";

export const modelInfo = (id: ModelId): ModelInfo => MODELS.find((m) => m.id === id) ?? MODELS[0];

export const isModelId = (v: unknown): v is ModelId => MODELS.some((m) => m.id === v);

export const modelFileUrl = (m: ModelInfo, file: string) => `${MODELS_BASE}/${m.dir}/${file}`;

// ---- every downloadable model ----

export type PackKind = "asr" | "punct" | "mt" | "tts" | "speakers";

/**
 * A set of files downloaded together: a speech model above, or one of the
 * helpers below. Settings lists these; the workers load them by the same dir
 * and file names.
 */
export interface ModelPack {
  id: string;
  kind: PackKind;
  name: string;
  note: string;
  dir: string;
  /** The directory's manifest; its `files` gives each file's exact size. */
  manifest: string;
  files: string[];
  gpuOnly: boolean;
  needsF16: boolean;
}

export const PUNCT_PACK: ModelPack = {
  id: "punct",
  kind: "punct",
  name: "Noktalama",
  note: "Seda'nın dökümüne nokta, virgül, büyük harf ve kesme işareti ekler.",
  dir: "seda-formatter",
  manifest: "model.json",
  files: ["formatter.int8.onnx", "vocab.json"],
  gpuOnly: false,
  needsF16: false,
};

export const SPEAKER_PACK: ModelPack = {
  id: "speakers",
  kind: "speakers",
  name: "Konuşmacılar",
  note: "3D-Speaker CAM++; kayıtta kimin ne zaman konuştuğunu sesinden ayırır.",
  dir: "3dspeaker-campplus",
  manifest: "model.json",
  files: ["campplus.onnx"],
  gpuOnly: false,
  needsF16: false,
};

/** A translation model's direction: from the transcript's language to the target. */
export type MtPair = `${MtLang}-${MtLang}`;

/** Each model translates to or from English; the Turkish pair has the larger "tc-big" model. */
const MT_REPOS: Partial<Record<MtPair, string>> = {
  "tr-en": "opus-mt-tc-big-tr-en",
  "en-tr": "opus-mt-tc-big-en-tr",
};

const MT_NAMES: Record<MtLang, string> = {
  tr: "Türkçe",
  en: "İngilizce",
  de: "Almanca",
  fr: "Fransızca",
  es: "İspanyolca",
  ru: "Rusça",
};

/** The language names with the "to" ending. */
const MT_TO: Record<MtLang, string> = {
  tr: "Türkçeye",
  en: "İngilizceye",
  de: "Almancaya",
  fr: "Fransızcaya",
  es: "İspanyolcaya",
  ru: "Rusçaya",
};

const mtPack = (pair: MtPair): ModelPack => {
  const [from, to] = pair.split("-") as [MtLang, MtLang];
  const dir = MT_REPOS[pair] ?? `opus-mt-${pair}`;
  return {
    // The two Turkish packs keep the ids they were first stored under.
    id: pair === "tr-en" ? "mt" : pair === "en-tr" ? "mt-en-tr" : `mt-${pair}`,
    kind: "mt",
    name: pair === "tr-en" ? "İngilizce çeviri" : pair === "en-tr" ? "Türkçe çeviri" : `${MT_NAMES[from]} → ${MT_NAMES[to]} çeviri`,
    note: `${dir}; ${MT_NAMES[from]} transkripti cümle cümle ${MT_TO[to]} çevirir.`,
    dir,
    manifest: "model.json",
    files: ["encoder.int8.onnx", "decoder.int8.onnx", "spm.json"],
    gpuOnly: false,
    needsF16: false,
  };
};

const PAIRS = MT_LANGS.flatMap((l) => (l === "en" ? [] : ([`${l}-en`, `en-${l}`] as MtPair[])));

export const MT_PACKS = Object.fromEntries(PAIRS.map((p) => [p, mtPack(p)])) as Record<MtPair, ModelPack>;

/** The models a translation runs through, in order: one when English is at either end, else via English. */
export function mtRoute(from: MtLang, to: MtLang): MtPair[] {
  if (from === to) return [];
  if (from === "en" || to === "en") return [`${from}-${to}` as MtPair];
  return [`${from}-en` as MtPair, `en-${to}` as MtPair];
}

/** Dubbing voices; the file order is the order the TTS worker takes them in. */
export const VOICE_PACKS = {
  ema: {
    id: "tts-ema",
    kind: "tts",
    name: "EMA Lightning",
    note: "Seslendirme sesi.",
    dir: "ema-lightning",
    manifest: "model.json",
    files: ["text.onnx", "sound.onnx", "decoder.onnx", "normalizer.wasm"],
    gpuOnly: false,
    needsF16: false,
  },
  mini: {
    id: "tts-mini",
    kind: "tts",
    name: "Antalia Mini",
    note: "Seslendirme sesi.",
    dir: "antalia-mini",
    manifest: "model.json",
    files: ["text.onnx", "cond.onnx", "flow.onnx", "vocoder.fp16.onnx", "frontend-data.json.gz"],
    gpuOnly: false,
    needsF16: false,
  },
  ahenk: {
    id: "tts-ahenk",
    kind: "tts",
    name: "Ahenk Cep",
    note: "Seslendirme sesi; rakamları, tarihleri ve kısaltmaları en iyi okuyan.",
    dir: "ahenk-cep",
    manifest: "model.json",
    files: ["text.f16.onnx", "cond.f16.onnx", "step.f16.onnx", "decoder.f16.onnx"],
    gpuOnly: false,
    needsF16: false,
  },
  supertonic: {
    id: "tts-supertonic",
    kind: "tts",
    name: "Supertonic 3",
    note: "Seslendirme sesi; Türkçe, İngilizce, Almanca, Fransızca, İspanyolca ve Rusça okur.",
    dir: "supertonic-3",
    manifest: "model.json",
    files: [
      "duration_predictor.onnx",
      "text_encoder.w16.onnx",
      "vector_estimator.w16.onnx",
      "vocoder.w16.onnx",
      "indexer.bin",
      "styles.bin",
    ],
    gpuOnly: false,
    needsF16: false,
  },
} satisfies Record<string, ModelPack>;

export const PACKS: ModelPack[] = [
  ...MODELS.map(
    (m): ModelPack => ({
      id: m.id,
      kind: "asr",
      name: m.name,
      note: m.note,
      dir: m.dir,
      manifest: "model.json",
      files: m.files,
      gpuOnly: m.gpuOnly,
      needsF16: m.needsF16,
    }),
  ),
  PUNCT_PACK,
  SPEAKER_PACK,
  ...PAIRS.map((p) => MT_PACKS[p]),
  VOICE_PACKS.ema,
  VOICE_PACKS.mini,
  VOICE_PACKS.ahenk,
  VOICE_PACKS.supertonic,
];

export const packFileUrl = (p: ModelPack, file: string) => `${MODELS_BASE}/${p.dir}/${file}`;
