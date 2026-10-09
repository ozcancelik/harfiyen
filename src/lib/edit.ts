import type { Word } from "../engine";

const norm = (s: string) => s.toLocaleLowerCase("tr-TR").replace(/[^\p{L}\p{N}]/gu, "");

/**
 * Replace words[first, first + count) with the words of `text`, keeping the
 * timing of every word that survives the edit. Unchanged words are matched
 * with a longest-common-subsequence diff (ignoring case and punctuation);
 * new or rewritten words share the time between their matched neighbours in
 * proportion to their length. An empty text deletes the range.
 */
export function replaceRange(words: Word[], first: number, count: number, text: string): Word[] {
  const old = words.slice(first, first + count);
  const tokens = text.split(/\s+/).filter(Boolean);
  const before = words.slice(0, first);
  const after = words.slice(first + count);
  if (!tokens.length) return [...before, ...after];
  if (!old.length) return words;

  // LCS table over normalised tokens.
  const a = old.map((w) => norm(w.text));
  const b = tokens.map(norm);
  const L = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      L[i][j] = a[i] && a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    }
  }
  // match[j] = index of the old word token j keeps the timing of, or -1.
  const match = new Array<number>(b.length).fill(-1);
  for (let i = 0, j = 0; i < a.length && j < b.length; ) {
    if (a[i] && a[i] === b[j]) {
      match[j] = i;
      i++;
      j++;
    } else if (L[i + 1][j] >= L[i][j + 1]) i++;
    else j++;
  }

  const out: Word[] = [];
  const spanStart = old[0].start;
  const spanEnd = old[old.length - 1].end;
  for (let j = 0; j < tokens.length; ) {
    if (match[j] >= 0) {
      out.push({ ...old[match[j]], text: tokens[j] });
      j++;
      continue;
    }
    // A run of unmatched tokens fills the gap between matched neighbours.
    let k = j;
    while (k < tokens.length && match[k] < 0) k++;
    const from = j > 0 ? out[out.length - 1].end : spanStart;
    const to = k < tokens.length ? old[match[k]].start : spanEnd;
    const lo = Math.min(from, to);
    const hi = Math.max(to, lo + 0.05 * (k - j));
    const weights = tokens.slice(j, k).map((t) => t.length + 1);
    const total = weights.reduce((x, y) => x + y, 0);
    let t = lo;
    for (let m = j; m < k; m++) {
      const d = ((hi - lo) * weights[m - j]) / total;
      out.push({ text: tokens[m], start: t, end: t + d });
      t += d;
    }
    j = k;
  }
  return [...before, ...out, ...after];
}
