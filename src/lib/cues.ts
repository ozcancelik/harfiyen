import type { Word } from "../engine";

export interface Cue {
  start: number;
  end: number;
  /** Index of the first word in the flat word list. */
  first: number;
  words: Word[];
}

export interface CueRules {
  /** A pause this long starts a new cue. */
  gap: number;
  maxDuration: number;
  maxChars: number;
}

/** Subtitle-friendly defaults: two lines of ~42 characters. */
export const SUBTITLE_RULES: CueRules = { gap: 0.8, maxDuration: 6.5, maxChars: 84 };

/** On-screen reading: longer lines, broken at pauses. */
export const READING_RULES: CueRules = { gap: 0.8, maxDuration: 14, maxChars: 220 };

export function buildCues(words: Word[], rules: CueRules = SUBTITLE_RULES): Cue[] {
  const cues: Cue[] = [];
  let cur: Cue | null = null;
  let chars = 0;
  words.forEach((w, i) => {
    const prev = i > 0 ? words[i - 1].text : "";
    // A sentence end starts a new cue, unless the cue would be a lone word.
    const sentenceEnd = /[.?!…]$/.test(prev) && !!cur && (chars >= 12 || cur.end - cur.start >= 0.8);
    const brk =
      !cur ||
      sentenceEnd ||
      w.start - cur.end >= rules.gap ||
      w.end - cur.start > rules.maxDuration ||
      chars + 1 + w.text.length > rules.maxChars;
    if (brk) {
      cur = { start: w.start, end: w.end, first: i, words: [w] };
      cues.push(cur);
      chars = w.text.length;
    } else {
      cur!.words.push(w);
      cur!.end = w.end;
      chars += 1 + w.text.length;
    }
  });
  return cues;
}

export const cueText = (c: Cue) => c.words.map((w) => w.text).join(" ");
