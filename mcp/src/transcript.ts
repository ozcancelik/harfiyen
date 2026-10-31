// Transcripts the tools work on, kept as JSON files so they outlive the server process.

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DecodingMethod, SpeechLang, Word } from "../../src/engine";
import type { Speakers } from "../../src/lib/speakers";
import type { ModelId } from "./models";
import type { Translation } from "../../src/lib/translation";

export interface Transcript {
  id: string;
  name: string;
  /** The media file the words came from, when there is one (an imported subtitle has none). */
  source?: string;
  /** Seconds of the file this transcript covers. */
  range?: { start: number; end: number };
  duration: number;
  model?: string;
  /** The app's id for the model, for the project file. */
  modelId?: ModelId;
  method?: DecodingMethod;
  /** Made from this subtitle file, not transcribed. */
  imported?: string;
  /** What a project file held that the MCP does not use (caption style, crop, waveform...), kept for saving it again. */
  app?: Record<string, unknown>;
  lang: SpeechLang;
  words: Word[];
  speakers?: Speakers;
  translation?: Translation;
  created: string;
}

const home = process.env.HARFIYEN_MCP_HOME ?? join(homedir(), ".harfiyen-mcp");
const dir = join(home, "transcripts");

const path = (id: string) => join(dir, `${id.replace(/[^\w-]/g, "")}.json`);

export function create(t: Omit<Transcript, "id" | "created">): Transcript {
  const full: Transcript = { ...t, id: randomUUID().slice(0, 8), created: new Date().toISOString() };
  save(full);
  return full;
}

export function save(t: Transcript) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path(t.id), JSON.stringify(t));
}

export function load(id: string): Transcript {
  try {
    return JSON.parse(readFileSync(path(id), "utf8"));
  } catch {
    throw new Error(`"${id}" kimlikli transkript yok. list_transcripts ile mevcut olanlara bakılabilir.`);
  }
}

export function list(): Transcript[] {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".json") && !f.endsWith(".undo.json"))
      .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as Transcript)
      .sort((a, b) => b.created.localeCompare(a.created));
  } catch {
    return [];
  }
}

export function remove(id: string): Transcript {
  const t = load(id);
  rmSync(path(t.id), { force: true });
  rmSync(undoPath(t.id), { force: true });
  return t;
}

// ---- Undo ----
// What an edit can change, kept before each edit in <id>.undo.json, the latest last. Capped: a long transcript is
// a megabyte or so per entry.

interface Snapshot {
  label: string;
  at: string;
  words: Word[];
  speakers?: Speakers;
  translation?: Translation;
  range?: { start: number; end: number };
}

const MAX_UNDO = 20;
const undoPath = (id: string) => join(dir, `${id.replace(/[^\w-]/g, "")}.undo.json`);

function readStack(id: string): Snapshot[] {
  try {
    return JSON.parse(readFileSync(undoPath(id), "utf8"));
  } catch {
    return [];
  }
}

/** Keeps the transcript as it is now, before an edit named `label`. */
export function checkpoint(t: Transcript, label: string) {
  const stack = readStack(t.id);
  stack.push({ label, at: new Date().toISOString(), words: t.words, speakers: t.speakers, translation: t.translation, range: t.range });
  mkdirSync(dir, { recursive: true });
  writeFileSync(undoPath(t.id), JSON.stringify(stack.slice(-MAX_UNDO)));
}

export const history = (id: string) => readStack(id).map((s) => ({ label: s.label, at: s.at })).reverse();

/** Takes back the last `steps` edits; returns their labels, latest first. */
export function undo(id: string, steps = 1): string[] {
  const stack = readStack(id);
  if (!stack.length) throw new Error("Geri alınacak bir düzenleme yok.");
  const taken = stack.splice(Math.max(0, stack.length - steps));
  const t = load(id);
  const back = taken[0];
  t.words = back.words;
  t.speakers = back.speakers;
  t.translation = back.translation;
  t.range = back.range;
  save(t);
  writeFileSync(undoPath(id), JSON.stringify(stack));
  return taken.map((x) => x.label).reverse();
}
