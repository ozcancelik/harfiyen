// A translation of the transcript. The model translates whole sentences, so the translated words have no
// timing of their own: each sentence keeps the time span of the words it came from, and its translated words
// share that span by length.

import type { Word } from "../engine";
import type { MtLang } from "../engine/languages";

/** The language translated into. */
export type TranslationLang = MtLang;

export interface Translation {
  lang: TranslationLang;
  words: Word[];
  /** sourceKey() of the transcript it was made from, to tell when it is out of date. */
  source: string;
}

/** A sentence of the transcript: `count` words from `first`. */
export interface Sentence {
  first: number;
  count: number;
  text: string;
}

/** A pause this long ends a sentence even without punctuation (Seda with punctuation off). */
const PAUSE = 1.2;
/** Longer runs are cut, at a comma when there is one in the second half. */
const MAX_WORDS = 50;
const END = /[.!?…]["'”’»)\]]*$/;
const COMMA = /[,;:]["'”’»)\]]*$/;

export function splitSentences(words: Word[]): Sentence[] {
  const out: Sentence[] = [];
  let first = 0;
  const close = (end: number) => {
    if (end <= first) return;
    out.push({ first, count: end - first, text: words.slice(first, end).map((w) => w.text).join(" ") });
    first = end;
  };
  for (let i = 0; i < words.length; i++) {
    const next = words[i + 1];
    if (END.test(words[i].text) || (next && next.start - words[i].end >= PAUSE)) close(i + 1);
    else if (i + 1 - first >= MAX_WORDS) {
      let cut = i + 1;
      for (let k = i; k > first + MAX_WORDS / 2; k--)
        if (COMMA.test(words[k].text)) {
          cut = k + 1;
          break;
        }
      close(cut);
    }
  }
  close(words.length);
  return out;
}

/** Translated sentences as words: each sentence over its source words' span, every word by its share of letters. */
export function placeTranslation(words: Word[], sentences: Sentence[], texts: string[]): Word[] {
  const out: Word[] = [];
  sentences.forEach((s, i) => {
    const parts = texts[i].split(/\s+/).filter(Boolean);
    if (!parts.length) return;
    const start = words[s.first].start;
    const span = Math.max(0, words[s.first + s.count - 1].end - start);
    // A space's worth for each word, so short words still get a moment.
    const weights = parts.map((p) => [...p].length + 1);
    const total = weights.reduce((a, b) => a + b, 0);
    let at = 0;
    parts.forEach((text, k) => {
      const a = start + (span * at) / total;
      at += weights[k];
      out.push({ text, start: a, end: start + (span * at) / total });
    });
  });
  return out;
}

/** A short fingerprint of the transcript's text (FNV-1a), stored with the translation. */
export function sourceKey(words: Word[]): string {
  let h = 0x811c9dc5;
  for (const w of words) {
    const s = w.text + " ";
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  }
  return `${words.length}:${(h >>> 0).toString(16)}`;
}
