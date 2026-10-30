// Where the model files are. The web app downloads them from its host; here they come from disk, in this order:
// $HARFIYEN_MODELS, the repository's public/models (`npm run models`), ~/.harfiyen-mcp/models (where download.ts
// puts them), ~/.cache/harfiyen/models. A model that is on none of them is downloaded, but only after the user agrees.

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type ModelId = "seda" | "duyu" | "whisper-turbo" | "whisper-turbo-q4";
export type MtPair = "tr-en" | "en-tr";

export const SPEECH_MODELS: Record<ModelId, { dir: string; name: string; langs: ("tr" | "en")[]; punctuates: boolean }> = {
  seda: { dir: "seda-v0.2", name: "Seda", langs: ["tr"], punctuates: false },
  duyu: { dir: "duyu-small", name: "Duyu", langs: ["tr"], punctuates: true },
  "whisper-turbo": { dir: "whisper-large-v3-turbo", name: "Whisper Turbo", langs: ["tr", "en"], punctuates: true },
  "whisper-turbo-q4": { dir: "whisper-large-v3-turbo", name: "Whisper Turbo", langs: ["tr", "en"], punctuates: true },
};

export const PUNCT_DIR = "seda-formatter";
export const SPEAKER_DIR = "3dspeaker-campplus";
export const MT_DIRS: Record<MtPair, string> = { "tr-en": "opus-mt-tc-big-tr-en", "en-tr": "opus-mt-tc-big-en-tr" };

/** One downloadable piece: a model folder, or the part of one a single variant reads. */
export interface Unit {
  id: string;
  name: string;
  dir: string;
  /** The folder's manifest; it is written last, so its presence says the rest is whole. */
  probe: string;
  /** The files this unit reads (the manifest's `files`); all of them when omitted. */
  files?: string[];
  /** Download size in MB, for what is said before the user has agreed. */
  mb: number;
}

const WHISPER = ["decoder_model_merged_q4f16.onnx", "vocab.json", "silero_vad.onnx"];

export const UNITS: Record<string, Unit> = {
  seda: { id: "seda", name: "Seda (Türkçe yazıya döküm)", dir: "seda-v0.2", probe: "model.json", mb: 162 },
  duyu: { id: "duyu", name: "Duyu (Türkçe yazıya döküm)", dir: "duyu-small", probe: "model.json", mb: 56 },
  "whisper-turbo": {
    id: "whisper-turbo",
    name: "Whisper Turbo (Türkçe ve İngilizce yazıya döküm)",
    dir: "whisper-large-v3-turbo",
    probe: "model.json",
    files: ["encoder_model_fp16.onnx", ...WHISPER],
    mb: 1470,
  },
  "whisper-turbo-q4": {
    id: "whisper-turbo-q4",
    name: "Whisper Turbo Hafif (Türkçe ve İngilizce yazıya döküm)",
    dir: "whisper-large-v3-turbo",
    probe: "model.json",
    files: ["encoder_model_q4f16.onnx", ...WHISPER],
    mb: 570,
  },
  punct: { id: "punct", name: "Noktalama ve büyük harf", dir: PUNCT_DIR, probe: "model.json", mb: 31 },
  speakers: { id: "speakers", name: "Konuşmacı ayırma", dir: SPEAKER_DIR, probe: "model.json", files: ["campplus.onnx"], mb: 29 },
  "translate-tr-en": { id: "translate-tr-en", name: "Çeviri Türkçe → İngilizce", dir: MT_DIRS["tr-en"], probe: "model.json", mb: 357 },
  "translate-en-tr": { id: "translate-en-tr", name: "Çeviri İngilizce → Türkçe", dir: MT_DIRS["en-tr"], probe: "model.json", mb: 357 },
  "voice-ema": { id: "voice-ema", name: "Seslendirme: EMA Lightning", dir: "ema-lightning", probe: "model.json", mb: 37 },
  "voice-mini": { id: "voice-mini", name: "Seslendirme: Antalia Mini", dir: "antalia-mini", probe: "model.json", mb: 24 },
  "voice-ahenk": { id: "voice-ahenk", name: "Seslendirme: Ahenk Cep", dir: "ahenk-cep", probe: "model.json", mb: 18 },
  "voice-supertonic": { id: "voice-supertonic", name: "Seslendirme: Supertonic 3", dir: "supertonic-3", probe: "model.json", mb: 203 },
};

export const UNIT_IDS = Object.keys(UNITS) as [string, ...string[]];

const mcpHome = () => process.env.HARFIYEN_MCP_HOME ?? join(homedir(), ".harfiyen-mcp");
const repoModels = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "public", "models");

/** Where downloads go: $HARFIYEN_MODELS when it is set, else the MCP's own folder. */
export const downloadRoot = () => process.env.HARFIYEN_MODELS || join(mcpHome(), "models");

function roots(): string[] {
  const all = [process.env.HARFIYEN_MODELS, repoModels, join(mcpHome(), "models"), join(homedir(), ".cache", "harfiyen", "models")];
  return all.filter((r): r is string => !!r && existsSync(r));
}

const complete = (unit: Unit, dir: string) =>
  [unit.probe, ...(unit.files ?? [])].every((n) => {
    try {
      return statSync(join(dir, n)).isFile();
    } catch {
      return false;
    }
  });

/** The folder that holds this unit whole, or null. */
export function unitDir(unit: Unit): string | null {
  for (const r of roots()) if (complete(unit, join(r, unit.dir))) return join(r, unit.dir);
  return null;
}

export const isReady = (id: string) => unitDir(UNITS[id]) !== null;

/** Thrown when a model is not on disk; the message is what the assistant tells the user and what it does next. */
export class ModelMissing extends Error {
  constructor(readonly unit: Unit) {
    super(
      `${unit.name} modeli bu bilgisayarda yok (yaklaşık ${unit.mb} MB). Kullanıcıya sor: "${unit.name} için yaklaşık ${unit.mb} MB indirilsin mi?" ` +
        `Kullanıcı kabul ederse download_models aracını models: ["${unit.id}"] ile çağır, sonra bu işi yeniden dene. Kullanıcı onaylamadan indirme.`,
    );
  }
}

/** The unit's folder, or ModelMissing when it is not (completely) on disk. */
export function requireUnit(id: string): string {
  const unit = UNITS[id];
  const dir = unitDir(unit);
  if (!dir) throw new ModelMissing(unit);
  return dir;
}

/** The folder of a model directory wherever it is, for files read by name; downloads would go to downloadRoot(). */
export function modelDir(dir: string): string {
  for (const r of roots()) if (existsSync(join(r, dir))) return join(r, dir);
  return join(downloadRoot(), dir);
}

export const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8"));
export const readBytes = (path: string) => new Uint8Array(readFileSync(path));

/** Which models are on disk, for the status tool. */
export function installed() {
  const ready = (id: string) => isReady(id);
  return {
    root: downloadRoot(),
    speech: Object.fromEntries((Object.keys(SPEECH_MODELS) as ModelId[]).map((id) => [id, ready(id)])),
    punctuation: ready("punct"),
    speakers: ready("speakers"),
    translation: Object.fromEntries((Object.keys(MT_DIRS) as MtPair[]).map((p) => [p, ready(`translate-${p}`)])),
    /** What can be downloaded, with sizes; download_models fetches it after the user agrees. */
    missing: Object.values(UNITS)
      .filter((u) => !isReady(u.id))
      .map((u) => ({ id: u.id, name: u.name, mb: u.mb })),
  };
}
