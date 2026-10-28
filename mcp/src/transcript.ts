// Transcripts the tools work on, kept as JSON files so they outlive the server process.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SpeechLang, Word } from "../../src/engine";
import type { Speakers } from "../../src/lib/speakers";
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
      .filter((f) => f.endsWith(".json"))
      .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as Transcript)
      .sort((a, b) => b.created.localeCompare(a.created));
  } catch {
    return [];
  }
}
