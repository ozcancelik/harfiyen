// Where the model files are. The web app downloads them from its host; here they come from disk:
// $HARFIYEN_MODELS, else the repository's public/models (`npm run models`), else ~/.cache/harfiyen/models.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type ModelId = "seda" | "duyu" | "whisper-turbo" | "whisper-turbo-q4";
export type MtPair = "tr-en" | "en-tr";

export const SPEECH_MODELS: Record<ModelId, { dir: string; name: string; langs: ("tr" | "en")[]; punctuates: boolean }> = {
  seda: { dir: "seda-v0.2", name: "Seda", langs: ["tr"], punctuates: false },
  duyu: { dir: "duyu-small", name: "Duyu", langs: ["tr"], punctuates: true },
  "whisper-turbo": { dir: "whisper-large-v3-turbo", name: "Whisper Turbo", langs: ["tr", "en"], punctuates: true },
  "whisper-turbo-q4": { dir: "whisper-large-v3-turbo", name: "Whisper Turbo Hafif", langs: ["tr", "en"], punctuates: true },
};

export const PUNCT_DIR = "seda-formatter";
export const SPEAKER_DIR = "3dspeaker-campplus";
export const MT_DIRS: Record<MtPair, string> = { "tr-en": "opus-mt-tc-big-tr-en", "en-tr": "opus-mt-tc-big-en-tr" };

const repoModels = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "public", "models");

export function modelsRoot(): string {
  const candidates = [process.env.HARFIYEN_MODELS, repoModels, join(homedir(), ".cache", "harfiyen", "models")];
  return candidates.find((c): c is string => !!c && existsSync(c)) ?? repoModels;
}

export const modelDir = (dir: string) => join(modelsRoot(), dir);

/** The directory, or a readable error when its files are not there. */
export function requireDir(dir: string, probe: string): string {
  const path = modelDir(dir);
  if (!existsSync(join(path, probe))) {
    throw new Error(`Model dosyaları bulunamadı: ${path}. Depoda \`npm run models\` çalıştırılmalı ya da HARFIYEN_MODELS ayarlanmalı.`);
  }
  return path;
}

export const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8"));
export const readBytes = (path: string) => new Uint8Array(readFileSync(path));

/** Which models are on disk, for the status tool. */
export function installed() {
  const has = (dir: string, probe: string) => existsSync(join(modelDir(dir), probe));
  return {
    root: modelsRoot(),
    speech: Object.fromEntries(
      (Object.keys(SPEECH_MODELS) as ModelId[]).map((id) => [id, has(SPEECH_MODELS[id].dir, "model.json")]),
    ),
    punctuation: has(PUNCT_DIR, "model.json"),
    speakers: has(SPEAKER_DIR, "campplus.onnx"),
    translation: Object.fromEntries((Object.keys(MT_DIRS) as MtPair[]).map((p) => [p, has(MT_DIRS[p], "model.json")])),
  };
}
