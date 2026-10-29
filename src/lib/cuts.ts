// Jump cut: the quiet stretches between words (and filler sounds, "ııı") are
// taken out, so the video goes straight from one sentence to the next. Times
// stay the file's everywhere; only playback skips the cuts, and the exports
// leave them out (output time).

import type { Word } from "../engine";
import { BAND_RATE } from "../render/aura";
import type { TimeRange } from "./useTranscriber";

export interface JumpCut {
  on: boolean;
  /** The shortest quiet stretch that is cut, seconds. */
  gap: number;
  /** Quiet kept on each side of speech, seconds, so words are not clipped. */
  pad: number;
  /** Filler sounds ("ııı", "eee", "hmm") are cut too. */
  fillers: boolean;
}

export const DEFAULT_JUMP_CUT: JumpCut = { on: false, gap: 0.6, pad: 0.15, fillers: true };

const FILLER = /^(?:[ıiea]{2,}|[ıe]+m+|h+m+|m{2,}|u+h+|u+m+|e+r+m)$/;

/** "Iıı", "eee…", "hmm": a sound, not a word. */
export const isFiller = (text: string) => FILLER.test(text.toLocaleLowerCase("tr").replace(/[^\p{L}]/gu, ""));

/** Whether a word is cut from the video (deleted by hand, or an unkept filler when filler cutting is on). */
export const isWordCut = (w: Word, jc: JumpCut) =>
  w.cut === true || (w.cut !== false && jc.on && jc.fillers && isFiller(w.text));

/** Whether the silence before `w` is shortened (cut by hand, or automatically when jump cut is on). */
export const isGapCut = (w: Word, jc: JumpCut) => w.cutGap === true || (w.cutGap !== false && jc.on);

/** Length of the quiet stretch before `words[index]` (from the previous word's end, or `spanStart` for the first). */
export function wordGap(words: Word[], index: number, spanStart = 0): number {
  if (index < 0 || index >= words.length) return 0;
  const prevEnd = index === 0 ? spanStart : words[index - 1].end;
  return Math.max(0, words[index].start - prevEnd);
}

/** Whether any automatic or manual cut is active. */
export const hasActiveCuts = (words: Word[], jc: JumpCut) =>
  jc.on || words.some((w) => w.cut === true || w.cutGap === true);

function setWordCut(w: Word, cut: boolean, jc: JumpCut): Word {
  const auto = jc.on && jc.fillers && isFiller(w.text);
  const next = cut ? (auto ? undefined : true) : auto ? false : undefined;
  if (w.cut === next) return w;
  const { cut: _, ...rest } = w;
  return next === undefined ? rest : { ...rest, cut: next };
}

function setGapCut(w: Word, cut: boolean, jc: JumpCut): Word {
  const next = cut ? (jc.on ? undefined : true) : jc.on ? false : undefined;
  if (w.cutGap === next) return w;
  const { cutGap: _, ...rest } = w;
  return next === undefined ? rest : { ...rest, cutGap: next };
}

/** Cut or restore the words at `indices` (toggles when `force` is omitted: restores if all are already cut). */
export function toggleWordsCut(words: Word[], indices: number[], jc: JumpCut, force?: boolean): Word[] {
  const set = new Set(indices.filter((i) => i >= 0 && i < words.length));
  if (!set.size) return words;
  const cut = force ?? ![...set].every((i) => isWordCut(words[i], jc));
  let changed = false;
  const out = words.map((w, i) => {
    if (!set.has(i)) return w;
    const next = setWordCut(w, cut, jc);
    if (next !== w) changed = true;
    return next;
  });
  return changed ? out : words;
}

/** Shorten or restore the silence before `words[index]`. */
export function toggleGapCut(words: Word[], index: number, jc: JumpCut, force?: boolean): Word[] {
  if (index < 0 || index >= words.length) return words;
  const w = words[index];
  const cut = force ?? !isGapCut(w, jc);
  const next = setGapCut(w, cut, jc);
  if (next === w) return words;
  const out = words.slice();
  out[index] = next;
  return out;
}

/** Cut all filler words ("ııı", "eee", "hmm"), or restore them if all are already cut. */
export function toggleAllFillers(words: Word[], jc: JumpCut): Word[] {
  const indices: number[] = [];
  words.forEach((w, i) => {
    if (isFiller(w.text)) indices.push(i);
  });
  return toggleWordsCut(words, indices, jc);
}

/** Shorten all long silences (>= `jc.gap`), or restore them if all are already shortened. */
export function toggleAllGaps(words: Word[], jc: JumpCut, spanStart = 0): Word[] {
  const indices: number[] = [];
  words.forEach((_, i) => {
    if (wordGap(words, i, spanStart) >= jc.gap - 1e-6) indices.push(i);
  });
  if (!indices.length) return words;
  const cut = !indices.every((i) => isGapCut(words[i], jc));
  const set = new Set(indices);
  let changed = false;
  const out = words.map((w, i) => {
    if (!set.has(i)) return w;
    const next = setGapCut(w, cut, jc);
    if (next !== w) changed = true;
    return next;
  });
  return changed ? out : words;
}

/** Restore every manually cut word and shortened silence. */
export function restoreAllCuts(words: Word[]): Word[] {
  if (!words.some((w) => w.cut !== undefined || w.cutGap !== undefined)) return words;
  return words.map(({ cut: _c, cutGap: _g, ...w }) => w);
}

/**
 * Shifts a word boundary `t` to the quietest frame in `[lo, hi]` when it is
 * at least 1 dB quieter than `t`, so cuts between touching words land in the
 * consonant/micro-pause dip rather than clipping a vowel.
 */
export function snapToQuiet(loudness: Float32Array, t: number, lo: number, hi: number): number {
  if (!loudness.length || hi <= lo) return t;
  const i0 = Math.max(0, Math.floor(lo * BAND_RATE));
  const i1 = Math.min(loudness.length - 1, Math.floor(hi * BAND_RATE));
  const it = Math.max(0, Math.min(loudness.length - 1, Math.floor(t * BAND_RATE)));
  if (i1 <= i0) return t;
  const base = loudness[it];
  let bestI = it;
  let bestVal = base;
  for (let i = i0; i <= i1; i++) {
    // Prefer frames closer to `t` when loudness is tied.
    const v = loudness[i] + Math.abs(i - it) * 0.02;
    if (v < bestVal) {
      bestVal = v;
      bestI = i;
    }
  }
  if (base - loudness[bestI] < 1) return t;
  return Math.max(lo, Math.min(hi, (bestI + 0.5) / BAND_RATE));
}

/** A loud blip shorter than this (a click, a breath) does not end a quiet stretch, seconds. */
const BLIP = 0.12;

/** Ranges sorted and joined where they touch. */
function merge(ranges: TimeRange[]): TimeRange[] {
  const out: TimeRange[] = [];
  for (const r of [...ranges].sort((a, b) => a.start - b.start)) {
    const last = out.at(-1);
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else out.push({ start: r.start, end: r.end });
  }
  return out;
}

function quantile(values: number[], q: number): number {
  const s = values.sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
}

/**
 * The loudness under which a frame counts as quiet: a third of the way from
 * the room's floor to the voice. null when the two are too close to tell
 * apart (music under the voice, say): the words alone decide then.
 */
function quietBelow(loudness: Float32Array, span: TimeRange, talk: TimeRange[]): number | null {
  const all: number[] = [];
  const voice: number[] = [];
  const end = Math.min(loudness.length, Math.ceil(span.end * BAND_RATE));
  let k = 0;
  for (let i = Math.max(0, Math.floor(span.start * BAND_RATE)); i < end; i++) {
    const t = (i + 0.5) / BAND_RATE;
    all.push(loudness[i]);
    while (k < talk.length && talk[k].end <= t) k++;
    if (k < talk.length && talk[k].start <= t) voice.push(loudness[i]);
  }
  if (all.length < BAND_RATE || voice.length < BAND_RATE / 2) return null;
  const floor = quantile(all, 0.1);
  const level = quantile(voice, 0.5);
  return level - floor < 1.5 ? null : floor + (level - floor) / 3;
}

/**
 * The quiet stretches of a..b: frames under `below` (all of it without one),
 * and filler sounds whatever their loudness. Each comes with whether a filler
 * is in it.
 */
function quietRuns(
  a: number,
  b: number,
  loudness: Float32Array,
  below: number | null,
  fillers: TimeRange[],
): { start: number; end: number; filler: boolean }[] {
  const inFiller = (t: number) => fillers.some((f) => f.start <= t && t < f.end);
  if (below === null) return [{ start: a, end: b, filler: fillers.some((f) => f.end > a && f.start < b) }];
  const i0 = Math.floor(a * BAND_RATE);
  const i1 = Math.ceil(b * BAND_RATE);
  const quiet: boolean[] = [];
  for (let i = i0; i < i1; i++) {
    const t = (i + 0.5) / BAND_RATE;
    // Past what was measured: nothing says there is sound.
    quiet.push(i >= loudness.length || loudness[i] < below || inFiller(t));
  }
  // Blips between quiet frames count as quiet.
  const blip = Math.round(BLIP * BAND_RATE);
  for (let i = 0; i < quiet.length; ) {
    if (quiet[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j < quiet.length && !quiet[j]) j++;
    if (i > 0 && j < quiet.length && j - i <= blip) quiet.fill(true, i, j);
    i = j;
  }
  const runs: { start: number; end: number; filler: boolean }[] = [];
  for (let i = 0; i < quiet.length; ) {
    if (!quiet[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j < quiet.length && quiet[j]) j++;
    const start = Math.max(a, (i0 + i) / BAND_RATE);
    const end = Math.min(b, (i0 + j) / BAND_RATE);
    if (end > start) runs.push({ start, end, filler: fillers.some((f) => f.end > start && f.start < end) });
    i = j;
  }
  return runs;
}

/**
 * The stretches of `span` to cut, sorted, in file time: quiet between the
 * words of at least `gap` (less `pad` on each side that touches speech), and
 * filler sounds. `keep` is sound that must stay as well (the dub's lines).
 * None without words: the whole span would go.
 */
export function findCuts(
  words: Word[],
  span: TimeRange,
  jc: JumpCut,
  loudness: Float32Array,
  keep: TimeRange[] = [],
): TimeRange[] {
  const inSpan = words.filter((w) => w.end > span.start && w.start < span.end);
  if (!inSpan.length) return [];
  const speech: TimeRange[] = [];
  const cutWords: TimeRange[] = [];
  for (const w of inSpan) {
    (isWordCut(w, jc) ? cutWords : speech).push({ start: w.start, end: w.end });
  }
  if (!speech.length) {
    return cutWords.length
      ? merge(cutWords.map((r) => ({ start: Math.max(span.start, r.start), end: Math.min(span.end, r.end) })))
      : [];
  }
  const talk = merge(
    [...speech, ...keep]
      .filter((r) => r.end > span.start && r.start < span.end)
      .map((r) => ({ start: Math.max(span.start, r.start), end: Math.min(span.end, r.end) })),
  );
  const below = quietBelow(loudness, span, talk);
  const cuts: TimeRange[] = [];
  for (let i = 0; i <= talk.length; i++) {
    const a = i === 0 ? span.start : talk[i - 1].end;
    const b = i === talk.length ? span.end : talk[i].start;
    if (b - a <= 0) continue;
    // Words whose preceding gap falls in a..b decide whether this silence is cut or kept.
    const gapWords = inSpan.filter((w) => w.start > a - 1e-3 && w.start <= b + 1e-3);
    const manualGapCut = gapWords.some((w) => w.cutGap === true);
    const manualGapKeep = gapWords.length > 0 && gapWords.every((w) => w.cutGap === false);
    const cutSilence = manualGapCut || (jc.on && !manualGapKeep);

    if (cutSilence) {
      for (const q of quietRuns(a, b, loudness, below, cutWords)) {
        const inside = cutWords.filter((f) => f.end > q.start && f.start < q.end);
        // The span's own ends are not speech: cut right up to them.
        let s = q.start <= span.start + 1e-3 ? span.start : q.start + jc.pad;
        let e = q.end >= span.end - 1e-3 ? span.end : q.end - jc.pad;
        if (inside.length) {
          const first = Math.max(span.start, inside[0].start);
          const last = Math.min(span.end, inside[inside.length - 1].end);
          if (first < s) s = snapToQuiet(loudness, first, Math.max(span.start, first - 0.12), Math.min(last, first + 0.04));
          if (last > e) e = snapToQuiet(loudness, last, Math.max(first, last - 0.04), Math.min(span.end, last + 0.12));
        }
        // A cut word or manual gap goes however short; automatic silence only from `gap` on.
        if (e - s > 0.04 && (q.filler || manualGapCut || q.end - q.start >= jc.gap - 1e-6)) {
          cuts.push({ start: s, end: e });
        }
      }
      continue;
    }

    // Silence cutting is off for a..b: cut only the deleted words inside it, snapping boundaries to quiet dips.
    const inside = cutWords.filter((f) => f.end > a && f.start < b);
    for (let k = 0; k < inside.length; ) {
      let endIdx = k;
      while (endIdx + 1 < inside.length && inside[endIdx + 1].start - inside[endIdx].end < jc.gap) endIdx++;
      const rawStart = Math.max(span.start, inside[k].start);
      const rawEnd = Math.min(span.end, inside[endIdx].end);
      const s =
        rawStart - a < jc.pad
          ? snapToQuiet(loudness, rawStart, Math.max(span.start, rawStart - 0.12), Math.min(rawEnd, rawStart + 0.04))
          : rawStart;
      const e =
        b - rawEnd < jc.pad
          ? snapToQuiet(loudness, rawEnd, Math.max(rawStart, rawEnd - 0.04), Math.min(span.end, rawEnd + 0.12))
          : rawEnd;
      if (e - s > 0.03) cuts.push({ start: s, end: e });
      k = endIdx + 1;
    }
  }
  return merge(cuts);
}

/** A part of the file that stays, and where it begins in the output (seconds from its start). */
export interface Kept {
  start: number;
  end: number;
  at: number;
}

/** What is left of the span once the cuts (sorted, inside it) are taken out. */
export function keptParts(span: TimeRange, cuts: TimeRange[]): Kept[] {
  const parts: Kept[] = [];
  let from = span.start;
  let at = 0;
  for (const c of [...cuts, { start: span.end, end: span.end }]) {
    if (c.start > from) {
      parts.push({ start: from, end: c.start, at });
      at += c.start - from;
    }
    from = Math.max(from, c.end);
  }
  return parts;
}

/** How long the output is. */
export const keptLength = (parts: Kept[]) => parts.reduce((s, p) => s + (p.end - p.start), 0);

/** The last part starting at or before `t` in `key` (file `start` or output `at`); -1 before the first. */
function partAt(parts: Kept[], t: number, key: "start" | "at"): number {
  let lo = 0;
  let hi = parts.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (parts[mid][key] <= t) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

/** File time to output time. A moment inside a cut is where the cut is, between the parts on either side. */
export function toOutput(t: number, parts: Kept[]): number {
  const i = partAt(parts, t, "start");
  if (i < 0) return 0;
  const p = parts[i];
  return p.at + Math.min(t, p.end) - p.start;
}

/** Output time to file time. */
export function toFile(o: number, parts: Kept[]): number {
  const p = parts[Math.max(0, partAt(parts, o, "at"))];
  return p ? Math.min(p.end, p.start + Math.max(0, o - p.at)) : o;
}

/** Whether file time `t` is in a kept part. */
export function isKept(t: number, parts: Kept[]): boolean {
  const i = partAt(parts, t, "start");
  return i >= 0 && t < parts[i].end;
}

/** The words not wholly inside a cut (a cut word or filler is not captioned). */
export function wordsOutside(words: Word[], cuts: TimeRange[]): Word[] {
  if (!cuts.length && !words.some((w) => w.cut)) return words;
  return words.filter((w) => !w.cut && !cuts.some((c) => w.start >= c.start - 0.01 && w.end <= c.end + 0.01));
}

/**
 * The words of the span at output time, as in an export of the jump-cut
 * video: shifted to its start, the cuts closed up, words inside a cut gone.
 */
export function wordsThrough(words: Word[], span: TimeRange, cuts: TimeRange[]): Word[] {
  const parts = keptParts(span, cuts);
  const out: Word[] = [];
  for (const w of words) {
    if (w.cut || w.end <= span.start || w.start >= span.end) continue;
    const start = toOutput(Math.max(span.start, w.start), parts);
    const end = toOutput(Math.min(span.end, w.end), parts);
    if (end - start > 0.01) out.push({ ...w, start, end });
  }
  return out;
}
