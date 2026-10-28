// Dubbing: every line of the transcript read aloud and placed at its own time. A port of the web app's
// src/worker/tts.worker.ts (the placement) and src/lib/useDubber.ts (the lines, the captions timed to the voice),
// which live in a worker and a React hook and cannot be imported here. Keep the numbers and the rules in step with
// them: the same text should be read the same way in both.

import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Word } from "../../src/engine";
import { buildCues, cueText, importedCues, READING_RULES } from "../../src/lib/cues";
import { splitSentences } from "../../src/lib/translation";
import { dubSlice, type DubClip } from "../../src/tts/dub";
import { RATE, speaker, type Speaker, type Voice } from "./voices";
import type { Progress } from "./pipeline";

export interface DubLine {
  start: number;
  end: number;
  text: string;
}

/** A line of the dub, and the `count` words from `first` it reads. */
export interface SpokenLine extends DubLine {
  first: number;
  count: number;
}

/** The last line heard runs past the end by `seconds`, even moved and sped up; it starts at `start` in the media. */
export interface DubOverflow {
  start: number;
  seconds: number;
}

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

/** The speech without the silence the model puts around it, which would otherwise push every following line later. */
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
export async function speak(sp: Speaker, text: string, voice: Voice, speed = 1) {
  const ratio = voice.model === "supertonic" ? 1 : 2 ** (voice.pitch / 12);
  return trimSilence(resample(await sp.speak(text, speed / ratio, voice), (ratio * sp.rate) / RATE));
}

/** `end`: where the dub must be over by (the video's end, or the trim's); 0 for standalone text. */
export async function placeLines(
  lines: DubLine[],
  duration: number,
  end: number,
  voice: Voice,
  progress: Progress,
): Promise<{ clips: DubClip[]; overflow: DubOverflow | null }> {
  progress(0, "ses yükleniyor");
  const sp = await speaker(voice.model);
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
    progress(i / lines.length, `seslendiriliyor ${i + 1}/${lines.length}`);
    const line = lines[i];
    let audio = await speak(sp, line.text, voice);
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
      audio = await speak(sp, line.text, voice, speed);
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
      const audio = await speak(sp, lines[m.line].text, voice, maxSpeed);
      if (!audio.length) continue;
      clips[k].audio = audio;
      m.speed = maxSpeed;
      over = fit();
    }
    // A few hundredths are not worth a word.
    if (over > 0.05) overflow = { start: lines[made[last].line].start, seconds: over };
  }
  progress(1);
  return { clips, overflow };
}

/**
 * Read a sentence at a time: a translation (into either language), and English. A translated sentence keeps its
 * source's start, but its words are not timed, so caption lines would cut it at made-up places; read whole, it
 * also sounds like one sentence. A Turkish transcript is read a caption line at a time.
 */
export const dubBySentence = (voiceLang: "tr" | "en", transcriptLang: "tr" | "en") => voiceLang !== transcriptLang || voiceLang === "en";

/** What the dub reads: `words` a sentence or a caption line at a time (dubBySentence). */
export function dubLines(words: Word[], bySentence: boolean): SpokenLine[] {
  const imported = importedCues(words);
  if (imported) return imported.map((c) => ({ start: c.start, end: c.end, text: cueText(c), first: c.first, count: c.words.length }));
  if (bySentence) {
    return splitSentences(words).map((s) => ({
      start: words[s.first].start,
      end: words[s.first + s.count - 1].end,
      text: s.text,
      first: s.first,
      count: s.count,
    }));
  }
  return buildCues(words, READING_RULES).map((c) => ({ start: c.start, end: c.end, text: cueText(c), first: c.first, count: c.words.length }));
}

/**
 * The words as the dub says them: each line's words moved and stretched, in proportion, onto the span its clip
 * takes. Words the dub has no clip for keep their times.
 */
export function timeToDub(words: Word[], lines: SpokenLine[], clips: { line: number; start: number; seconds: number }[]): Word[] {
  const out = words.slice();
  for (const c of clips) {
    const l = lines[c.line];
    if (!l?.count) continue;
    const from = words[l.first].start;
    const span = words[l.first + l.count - 1].end - from;
    const scale = span > 0 ? c.seconds / span : 0;
    for (let i = l.first; i < l.first + l.count; i++) {
      const w = words[i];
      out[i] = { ...w, start: c.start + (w.start - from) * scale, end: c.start + (w.end - from) * scale };
    }
  }
  return out;
}

/** Plain user text as timed placeholder words (one cue per sentence or line); the dub gives them their real times. */
export function wordsFromText(text: string): Word[] {
  const sentences = text
    .split(/(?:\r?\n)+|(?<=[.!?…]["'”’»)\]]*)\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const out: Word[] = [];
  let t = 0;
  for (const s of sentences) {
    const parts = s.split(/\s+/).filter(Boolean);
    if (!parts.length) continue;
    if (out.length) t += 1.5;
    parts.forEach((w, i) => {
      const d = ([...w].length + 1) * 0.06;
      out.push({ text: w, start: t, end: t + d, ...(i === 0 && { cue: true }) });
      t += d;
    });
  }
  return out;
}

/**
 * A fingerprint of the words a dub reads (FNV-1a over their text and start times): the dub is out of date once it
 * changes.
 */
export function dubKey(words: Word[]): string {
  let h = 0x811c9dc5;
  for (const w of words) {
    const s = `${w.text}@${Math.round(w.start * 1000)} `;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  }
  return `${words.length}:${(h >>> 0).toString(16)}`;
}

/** The dub as a 16-bit mono WAV at RATE, written a minute at a time so an hour of dub never needs one big buffer. */
export function writeDubWav(path: string, clips: DubClip[], duration: number): number {
  const last = clips.at(-1);
  const end = Math.max(duration, last ? last.start + last.audio.length / RATE : 0);
  const n = Math.ceil(end * RATE);
  const head = Buffer.alloc(44);
  head.write("RIFF", 0);
  head.writeUInt32LE(36 + 2 * n, 4);
  head.write("WAVEfmt ", 8);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(RATE, 24);
  head.writeUInt32LE(RATE * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write("data", 36);
  head.writeUInt32LE(2 * n, 40);
  mkdirSync(join(path, ".."), { recursive: true });
  const fd = openSync(path, "w");
  try {
    writeSync(fd, head);
    const step = 60 * RATE;
    for (let i = 0; i < n; i += step) {
      const f = dubSlice(clips, i / RATE, Math.min(step, n - i));
      const pcm = Buffer.alloc(f.length * 2);
      for (let j = 0; j < f.length; j++) pcm.writeInt16LE(Math.round(Math.max(-1, Math.min(1, f[j])) * 32767), j * 2);
      writeSync(fd, pcm);
    }
  } finally {
    closeSync(fd);
  }
  return end;
}

// ---- A transcript's dub, kept on disk ----

/** What a dub keeps beside its WAV: how it was made and where each line sits, so captions can follow it. */
export interface DubMeta {
  voice: Voice;
  /** The words it reads: the transcript's or its translation. */
  language: "transcript" | "translation";
  /** dubKey of those words when it was made; a different key now means the words changed since. */
  key: string;
  /** Seconds of the timeline the WAV covers. */
  duration: number;
  end: number;
  lines: SpokenLine[];
  clips: { line: number; start: number; seconds: number }[];
  overflow: DubOverflow | null;
  elapsed: number;
}

const home = process.env.HARFIYEN_MCP_HOME ?? join(homedir(), ".harfiyen-mcp");
const dubDir = join(home, "dubs");
const safe = (id: string) => id.replace(/[^\w-]/g, "");
export const dubWavPath = (id: string) => join(dubDir, `${safe(id)}.wav`);
const dubMetaPath = (id: string) => join(dubDir, `${safe(id)}.json`);

export function saveDub(id: string, meta: DubMeta, clips: DubClip[]) {
  mkdirSync(dubDir, { recursive: true });
  writeDubWav(dubWavPath(id), clips, meta.duration);
  writeFileSync(dubMetaPath(id), JSON.stringify(meta));
}

export function loadDub(id: string): DubMeta | null {
  try {
    return JSON.parse(readFileSync(dubMetaPath(id), "utf8"));
  } catch {
    return null;
  }
}
