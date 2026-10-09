import type { Word } from "../engine";
import { buildCues, cueText, type Cue } from "./cues";
import { stamp } from "./format";

/** Split a cue into at most two balanced lines for subtitles. */
function twoLines(text: string, max = 42): string {
  if (text.length <= max) return text;
  const mid = text.length / 2;
  let best = -1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === " " && (best < 0 || Math.abs(i - mid) < Math.abs(best - mid))) best = i;
  }
  return best < 0 ? text : `${text.slice(0, best)}\n${text.slice(best + 1)}`;
}

export function toSrt(cues: Cue[]): string {
  return cues
    .map((c, i) => `${i + 1}\n${stamp(c.start, ",")} --> ${stamp(c.end, ",")}\n${twoLines(cueText(c))}\n`)
    .join("\n");
}

export function toVtt(cues: Cue[]): string {
  const body = cues.map((c) => `${stamp(c.start, ".")} --> ${stamp(c.end, ".")}\n${twoLines(cueText(c))}\n`).join("\n");
  return `WEBVTT\n\n${body}`;
}

/** Plain text, one paragraph per longer pause. */
export function toText(words: Word[]): string {
  return buildCues(words, { gap: 1.5, maxDuration: Infinity, maxChars: Infinity })
    .map(cueText)
    .join("\n\n");
}

export function toJson(words: Word[], meta: Record<string, unknown>): string {
  const r = (x: number) => Math.round(x * 100) / 100;
  return JSON.stringify(
    { ...meta, words: words.map((w) => ({ text: w.text, start: r(w.start), end: r(w.end) })) },
    null,
    2,
  );
}

export function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
