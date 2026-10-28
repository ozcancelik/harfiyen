// The web app's project file (.harfiyen, src/lib/projectStore.ts): JSON with the transcript, style and waveform,
// without the media. The app's store reaches for Vite's env and IndexedDB, so the format is read and written here.
// What the MCP does not use (caption style, crop, jump cut settings, waveform) is kept as it was, so a project
// opened here and saved again is still the app's.

import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import type { DecodingMethod, SpeechLang, Word } from "../../src/engine";
import { readSpeakers } from "../../src/lib/speakers";
import type { Translation } from "../../src/lib/translation";
import { SPEECH_MODELS, type ModelId } from "./models";
import type { Transcript } from "./transcript";

const FORMAT = "harfiyen-project";
const VERSION = 1;
export const PROJECT_EXT = ".harfiyen";

const MEDIA_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".mkv": "video/x-matroska",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".wav": "audio/wav",
  ".flac": "audio/flac",
  ".ogg": "audio/ogg",
};

/** The app's fields the MCP carries through untouched. */
export const PASSED = ["settings", "crop", "jumpCut", "peaks", "bands", "loudness", "createdAt", "id", "live", "elapsed", "stoppedAt", "media"] as const;

const isModelId = (v: unknown): v is ModelId => typeof v === "string" && v in SPEECH_MODELS;
const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : null);

function readWords(list: unknown): Word[] {
  return (Array.isArray(list) ? (list as Record<string, unknown>[]) : [])
    .filter((w) => typeof w?.text === "string" && num(w.start) !== null && num(w.end) !== null)
    .map((w): Word => ({ text: w.text as string, start: w.start as number, end: w.end as number, ...(w.cue === true && { cue: true }) }));
}

function readTrim(x: unknown): { start: number; end: number } | undefined {
  const r = x as { start?: unknown; end?: unknown } | null;
  const ok = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
  return r && ok(r.start) && ok(r.end) && r.end > r.start ? { start: r.start, end: r.end } : undefined;
}

/** A transcript from a project file. `source`: the media; missing, it is looked for next to the file under the name the project saved. */
export function readProject(text: string, file: string, source?: string): Omit<Transcript, "id" | "created"> {
  let d: Record<string, unknown>;
  try {
    d = JSON.parse(text);
  } catch {
    throw new Error("Proje dosyası okunamadı.");
  }
  if (d?.format !== FORMAT || !Array.isArray(d.words)) throw new Error("Bu bir Harfiyen proje dosyası değil.");
  if (typeof d.version !== "number" || d.version > VERSION) throw new Error("Bu proje dosyası daha yeni bir Harfiyen sürümüyle kaydedilmiş.");

  const t = d.translation as Record<string, unknown> | undefined;
  const translation: Translation | undefined =
    (t?.lang === "en" || t?.lang === "tr") && typeof t.source === "string" ? { lang: t.lang, source: t.source, words: readWords(t.words) } : undefined;
  const media = d.media as { name?: unknown } | null;
  const beside = media && typeof media.name === "string" ? join(dirname(file), media.name) : undefined;
  const words = readWords(d.words);
  const modelId = isModelId(d.model) ? d.model : "seda";
  const app: Record<string, unknown> = {};
  for (const k of PASSED) if (d[k] !== undefined) app[k] = d[k];
  return {
    name: typeof d.name === "string" && d.name ? d.name : basename(file, PROJECT_EXT),
    source: source ?? (beside && existsSync(beside) ? beside : undefined),
    range: readTrim(d.trim),
    duration: num(d.duration) ?? words.at(-1)?.end ?? 0,
    model: SPEECH_MODELS[modelId].name,
    modelId,
    method: (d.method as DecodingMethod) ?? undefined,
    lang: d.lang === "en" ? "en" : "tr",
    words,
    speakers: readSpeakers(d.speakers),
    translation,
    imported: typeof d.imported === "string" ? d.imported : undefined,
    app,
  };
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;
const b64 = (a: Float32Array) => Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString("base64");

export interface Waveform {
  peaks: Float32Array;
  bands: Float32Array;
  loudness: Float32Array;
}

/** The media's description for the project: read from the file when it is there, else as the project had it. */
function mediaOf(t: Transcript) {
  if (t.source && existsSync(t.source)) {
    const st = statSync(t.source);
    return { name: basename(t.source), size: st.size, type: MEDIA_TYPES[extname(t.source).toLowerCase()] ?? "", lastModified: Math.floor(st.mtimeMs) };
  }
  return (t.app?.media as object | undefined) ?? null;
}

/** The project file for a transcript. `wave`: the waveform to store; missing, the one the project came with, if any. */
export function writeProject(t: Transcript, wave?: Waveform): string {
  const app = t.app ?? {};
  const speakers = t.speakers && {
    names: t.speakers.names,
    turns: t.speakers.turns.map((x) => ({ start: r3(x.start), end: r3(x.end), speaker: x.speaker })),
  };
  const loudness = wave ? (wave.loudness.length ? b64(wave.loudness) : "") : app.loudness;
  return JSON.stringify({
    format: FORMAT,
    version: VERSION,
    id: typeof app.id === "string" ? app.id : randomUUID(),
    name: t.name,
    createdAt: typeof app.createdAt === "number" ? app.createdAt : Date.parse(t.created),
    updatedAt: Date.now(),
    live: app.live === true,
    model: t.modelId ?? "seda",
    ...(t.imported && { imported: t.imported }),
    method: t.method ?? "beam-lm",
    ...(t.lang === "en" && { lang: "en" as SpeechLang }),
    duration: t.duration,
    elapsed: num(app.elapsed),
    ...(num(app.stoppedAt) !== null && { stoppedAt: app.stoppedAt }),
    media: mediaOf(t),
    // Without these the app fills in its defaults.
    ...(app.settings !== undefined && { settings: app.settings }),
    ...(app.crop !== undefined && { crop: app.crop }),
    ...(t.range && { trim: t.range }),
    ...(app.jumpCut !== undefined && { jumpCut: app.jumpCut }),
    words: t.words.map((w) => ({ text: w.text, start: r3(w.start), end: r3(w.end), ...(w.cue && { cue: true }) })),
    ...(t.translation && {
      translation: {
        lang: t.translation.lang,
        source: t.translation.source,
        words: t.translation.words.map((w) => ({ text: w.text, start: r3(w.start), end: r3(w.end) })),
      },
    }),
    ...(speakers && { speakers }),
    peaks: wave ? b64(wave.peaks) : ((app.peaks as string | undefined) ?? ""),
    bands: wave ? b64(wave.bands) : ((app.bands as string | undefined) ?? ""),
    ...(loudness ? { loudness } : {}),
  });
}
