// Projects live in IndexedDB: the transcript, style and waveform in one
// store, the media in another, so the project list never loads a video.
// Fonts the user adds sit in a third store, shared by every project; the
// user's logo and background photo in a fourth, also shared. A project's dub has a fifth, so
// neither the list nor the project itself loads its audio.
//
// Media is kept one of two ways: a file handle (Chromium; no copy, the file
// stays where it is) or a copy of the file (other browsers, recordings).
// Files too large to copy are linked again by hand when the project opens.

import type { UserFont } from "../captions/fonts";
import type { CaptionSettings } from "../captions/style";
import type { DecodingMethod, SpeechLang, Word } from "../engine";
import { isMtLang, SPEECH_LANGS } from "../engine/languages";
import { readCrop, type Crop } from "./crop";
import { DEFAULT_JUMP_CUT, type JumpCut } from "./cuts";
import { DEFAULT_MODEL, isModelId, type ModelId } from "../models";
import { readSpeakers, type Speakers } from "./speakers";
import type { Translation } from "./translation";
import type { TimeRange } from "./useTranscriber";
import type { DubOverflow, Voice } from "../worker/tts.worker";

export interface MediaInfo {
  name: string;
  size: number;
  type: string;
  lastModified: number;
}

export type MediaStorage = "handle" | "copy" | "none";

export interface Project {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  /** Made from the microphone. */
  live: boolean;
  /** Missing in projects saved before there was a choice (seda). */
  model?: ModelId;
  /** Made from this subtitle file, not transcribed. */
  imported?: string;
  method: DecodingMethod;
  /** The language spoken in the media; missing in projects from before there was a choice (Turkish). */
  lang?: SpeechLang;
  duration: number | null;
  elapsed: number | null;
  /** The transcription was stopped here and can be continued; missing when it finished. */
  stoppedAt?: number;
  words: Word[];
  peaks: Float32Array;
  bands: Float32Array;
  /** Missing in projects saved before "Sesle vurgula". */
  loudness?: Float32Array;
  translation?: Translation;
  /** Who speaks when; missing when the speakers were never told apart. */
  speakers?: Speakers;
  settings: CaptionSettings;
  /** The part of the picture shown and exported; missing shows all of it. */
  crop?: Crop;
  /** The part of the media used (transcribed, played, exported); missing for all of it. */
  trim?: TimeRange;
  /** Cutting out the quiet between words; missing when it was never turned on. */
  jumpCut?: JumpCut;
  media: MediaInfo | null;
  storage: MediaStorage;
}

/** What the media store holds for a project. */
export type StoredMedia = { kind: "copy"; file: File } | { kind: "handle"; handle: FileSystemFileHandle };

/** Copies above this stay on disk only; the user picks the file again. */
export const COPY_LIMIT = 1024 ** 3;

const DB_NAME = "harfiyen";
const PROJECTS = "projects";
const MEDIA = "media";
const FONTS = "fonts";
/** Single files kept by name (the logo, the background photo). */
const ASSETS = "assets";
const DUBS = "dubs";

let db: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  db ??= new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 4);
    req.onupgradeneeded = (e) => {
      if (e.oldVersion < 1) {
        req.result.createObjectStore(PROJECTS, { keyPath: "id" });
        req.result.createObjectStore(MEDIA);
      }
      if (e.oldVersion < 2) req.result.createObjectStore(FONTS, { keyPath: "id" });
      if (e.oldVersion < 3) req.result.createObjectStore(ASSETS);
      if (e.oldVersion < 4) req.result.createObjectStore(DUBS);
    };
    req.onsuccess = () => {
      // A newer tab wants to upgrade: step aside, open again on next use.
      req.result.onversionchange = () => {
        req.result.close();
        db = null;
      };
      resolve(req.result);
    };
    req.onerror = () => reject(req.error);
  }).catch((e) => {
    db = null; // Try again next time (e.g. a blocked upgrade).
    throw e;
  });
  return db;
}

function done<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(stores: string[], mode: IDBTransactionMode, fn: (t: IDBTransaction) => void): Promise<void> {
  const t = (await open()).transaction(stores, mode);
  fn(t);
  await new Promise<void>((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = t.onabort = () => reject(t.error);
  });
}

export async function listProjects(): Promise<Project[]> {
  const t = (await open()).transaction(PROJECTS);
  const all = await done(t.objectStore(PROJECTS).getAll() as IDBRequest<Project[]>);
  return all.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getProject(id: string): Promise<Project | undefined> {
  const t = (await open()).transaction(PROJECTS);
  return done(t.objectStore(PROJECTS).get(id) as IDBRequest<Project | undefined>);
}

export const saveProject = (p: Project) => tx([PROJECTS], "readwrite", (t) => t.objectStore(PROJECTS).put(p));

export async function getMedia(id: string): Promise<StoredMedia | undefined> {
  const t = (await open()).transaction(MEDIA);
  return done(t.objectStore(MEDIA).get(id) as IDBRequest<StoredMedia | undefined>);
}

/** Store the media and record how, in one transaction. */
export const saveMedia = (p: Project, m: StoredMedia) =>
  tx([PROJECTS, MEDIA], "readwrite", (t) => {
    t.objectStore(MEDIA).put(m, p.id);
    t.objectStore(PROJECTS).put(p);
  });

export const deleteProject = (id: string) =>
  tx([PROJECTS, MEDIA, DUBS], "readwrite", (t) => {
    t.objectStore(PROJECTS).delete(id);
    t.objectStore(MEDIA).delete(id);
    t.objectStore(DUBS).delete(id);
  });

/** A project's dub as stored: its speech at DUB_RATE in 16 bits, and what it was made from (see useDubber). */
export interface StoredDub {
  voice: Voice;
  /** dubKey() of the words it reads. */
  key: string;
  end: number;
  duration: number;
  overflow: DubOverflow | null;
  elapsed: number;
  clips: { line: number; start: number; audio: Int16Array }[];
}

export async function getDub(id: string): Promise<StoredDub | undefined> {
  const t = (await open()).transaction(DUBS);
  return done(t.objectStore(DUBS).get(id) as IDBRequest<StoredDub | undefined>);
}

export const saveDub = (id: string, d: StoredDub) => tx([DUBS], "readwrite", (t) => t.objectStore(DUBS).put(d, id));

export async function listFonts(): Promise<UserFont[]> {
  const t = (await open()).transaction(FONTS);
  const all = await done(t.objectStore(FONTS).getAll() as IDBRequest<UserFont[]>);
  return all.sort((a, b) => a.addedAt - b.addedAt);
}

export const saveFont = (f: UserFont) => tx([FONTS], "readwrite", (t) => t.objectStore(FONTS).put(f));

export const deleteFont = (id: string) => tx([FONTS], "readwrite", (t) => t.objectStore(FONTS).delete(id));

/** One of the user's images (the logo, the background photo): the file as added, by name. */
export interface StoredImage {
  name: string;
  blob: Blob;
}

export type AssetKey = "logo" | "photo";

export async function getAsset(key: AssetKey): Promise<StoredImage | undefined> {
  const t = (await open()).transaction(ASSETS);
  return done(t.objectStore(ASSETS).get(key) as IDBRequest<StoredImage | undefined>);
}

export const saveAsset = (key: AssetKey, l: StoredImage) =>
  tx([ASSETS], "readwrite", (t) => t.objectStore(ASSETS).put(l, key));

export const deleteAsset = (key: AssetKey) => tx([ASSETS], "readwrite", (t) => t.objectStore(ASSETS).delete(key));

/** Room for a copy of `bytes`, leaving some headroom. */
export async function canCopy(bytes: number): Promise<boolean> {
  try {
    const { quota = 0, usage = 0 } = await navigator.storage.estimate();
    return quota - usage > bytes * 1.1 + 50_000_000;
  } catch {
    return true; // No estimate: try, a quota error just skips the copy.
  }
}

let persistAsked = false;
/** Ask the browser not to evict projects when space runs low. */
export function askPersist() {
  if (persistAsked) return;
  persistAsked = true;
  void navigator.storage?.persist?.().catch(() => {});
}

/** "röportaj.mp4" -> "röportaj": projects are named after their file. */
export function stripExt(name: string) {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(0, i) : name;
}

/** Older projects kept the file name with its extension. */
export const projectTitle = (p: Project) => (p.media && p.name === p.media.name ? stripExt(p.name) : p.name);

export const mediaInfo = (f: File): MediaInfo => ({
  name: f.name,
  size: f.size,
  type: f.type,
  lastModified: f.lastModified,
});

/** The picked file looks like the one the project was made from. */
export const sameMedia = (m: MediaInfo | null, f: File) => !m || m.size === f.size;

// ---- File System Access (Chromium) ----

type Permission = "granted" | "denied" | "prompt";
type HandlePermissions = {
  queryPermission?: (d: { mode: "read" }) => Promise<Permission>;
  requestPermission?: (d: { mode: "read" }) => Promise<Permission>;
};

/**
 * The file behind a stored handle. Must run from a click: asking for
 * permission again needs a user gesture. Null when it is gone or refused.
 */
export async function fileFromHandle(handle: FileSystemFileHandle): Promise<File | null> {
  try {
    const h = handle as FileSystemFileHandle & HandlePermissions;
    let state = (await h.queryPermission?.({ mode: "read" })) ?? "granted";
    if (state === "prompt") state = (await h.requestPermission?.({ mode: "read" })) ?? "denied";
    return state === "granted" ? await handle.getFile() : null;
  } catch {
    return null; // Moved, deleted or renamed.
  }
}

// ---- Project file (.harfiyen) ----

export const PROJECT_EXT = ".harfiyen";
const FORMAT = "harfiyen-project";

function toBase64(a: Float32Array): string {
  const bytes = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(s: unknown): Float32Array {
  if (typeof s !== "string" || !s) return new Float32Array(0);
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length - (bin.length % 4));
  for (let i = 0; i < bytes.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}

/** The project as a portable file. The media is not included. */
export function projectToFile(p: Project): string {
  const r = (x: number) => Math.round(x * 1000) / 1000;
  return JSON.stringify({
    format: FORMAT,
    version: 1,
    id: p.id,
    name: p.name,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    live: p.live,
    model: p.model,
    imported: p.imported,
    method: p.method,
    ...(p.lang && p.lang !== "tr" && { lang: p.lang }),
    duration: p.duration,
    elapsed: p.elapsed,
    ...(p.stoppedAt !== undefined && { stoppedAt: p.stoppedAt }),
    media: p.media,
    settings: p.settings,
    ...(p.crop && { crop: p.crop }),
    ...(p.trim && { trim: p.trim }),
    ...(p.jumpCut && { jumpCut: p.jumpCut }),
    words: p.words.map((w) => ({
      text: w.text,
      start: r(w.start),
      end: r(w.end),
      ...(w.cue && { cue: true }),
      ...(typeof w.cut === "boolean" && { cut: w.cut }),
      ...(typeof w.cutGap === "boolean" && { cutGap: w.cutGap }),
    })),
    ...(p.translation && {
      translation: {
        lang: p.translation.lang,
        source: p.translation.source,
        words: p.translation.words.map((w) => ({ text: w.text, start: r(w.start), end: r(w.end) })),
      },
    }),
    ...(p.speakers && {
      speakers: {
        names: p.speakers.names,
        turns: p.speakers.turns.map((t) => ({ start: r(t.start), end: r(t.end), speaker: t.speaker })),
      },
    }),
    peaks: toBase64(p.peaks),
    bands: toBase64(p.bands),
    ...(p.loudness?.length && { loudness: toBase64(p.loudness) }),
  });
}

/** A trim read back from a project file; undefined when missing or not a range. */
function readTrim(x: unknown): TimeRange | undefined {
  const r = x as Partial<TimeRange> | null;
  const ok = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
  return r && ok(r.start) && ok(r.end) && r.end > r.start ? { start: r.start, end: r.end } : undefined;
}

/** Jump cut settings read back from a project file; undefined when missing. Values that are not numbers are the defaults. */
export function readJumpCut(x: unknown): JumpCut | undefined {
  const j = x as Partial<JumpCut> | null;
  if (!j || typeof j !== "object") return undefined;
  const num = (v: unknown, d: number, max: number) =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.min(max, v) : d;
  return {
    on: j.on === true,
    gap: num(j.gap, DEFAULT_JUMP_CUT.gap, 5),
    pad: num(j.pad, DEFAULT_JUMP_CUT.pad, 1),
    fillers: j.fillers !== false,
  };
}

/** Read a project file; throws a readable message when it is not one. */
export function projectFromFile(text: string, defaults: CaptionSettings): Project {
  let d: Record<string, unknown>;
  try {
    d = JSON.parse(text);
  } catch {
    throw new Error("Proje dosyası okunamadı.");
  }
  if (d?.format !== FORMAT || !Array.isArray(d.words)) throw new Error("Bu bir Harfiyen proje dosyası değil.");
  if (typeof d.version !== "number" || d.version > 1)
    throw new Error("Bu proje dosyası daha yeni bir Harfiyen sürümüyle kaydedilmiş.");
  const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : null);
  const readWords = (list: unknown) =>
    (Array.isArray(list) ? (list as Record<string, unknown>[]) : [])
      .filter((w) => typeof w?.text === "string" && num(w.start) !== null && num(w.end) !== null)
      .map((w): Word => ({
        text: w.text as string,
        start: w.start as number,
        end: w.end as number,
        ...(w.cue === true && { cue: true }),
        ...(typeof w.cut === "boolean" && { cut: w.cut }),
        ...(typeof w.cutGap === "boolean" && { cutGap: w.cutGap }),
      }));
  const words = readWords(d.words);
  const t = d.translation as Record<string, unknown> | undefined;
  const translation: Translation | undefined =
    typeof t?.lang === "string" && isMtLang(t.lang) && typeof t.source === "string"
      ? { lang: t.lang, source: t.source, words: readWords(t.words) }
      : undefined;
  const media = d.media as MediaInfo | null;
  const now = Date.now();
  return {
    id: typeof d.id === "string" && d.id ? d.id : crypto.randomUUID(),
    name: typeof d.name === "string" && d.name ? d.name : "Adsız proje",
    createdAt: num(d.createdAt) ?? now,
    updatedAt: now,
    live: d.live === true,
    model: isModelId(d.model) ? d.model : DEFAULT_MODEL,
    imported: typeof d.imported === "string" ? d.imported : undefined,
    method: (d.method as DecodingMethod) ?? "beam-lm",
    lang: SPEECH_LANGS.some((l) => l.code === d.lang && l.code !== "tr") ? (d.lang as SpeechLang) : undefined,
    duration: num(d.duration),
    elapsed: num(d.elapsed),
    stoppedAt: num(d.stoppedAt) ?? undefined,
    words,
    peaks: fromBase64(d.peaks),
    bands: fromBase64(d.bands),
    loudness: fromBase64(d.loudness),
    translation,
    speakers: readSpeakers(d.speakers),
    settings: { ...defaults, ...(d.settings as Partial<CaptionSettings>) },
    crop: readCrop(d.crop) ?? undefined,
    trim: readTrim(d.trim),
    jumpCut: readJumpCut(d.jumpCut),
    media: media && typeof media.name === "string" && typeof media.size === "number" ? media : null,
    storage: "none",
  };
}
