export class SymbolTable {
  private syms: string[] = [];

  constructor(text: string) {
    for (const line of text.split("\n")) {
      const t = line.trimEnd();
      if (!t) continue;
      const i = t.lastIndexOf(" ");
      this.syms[Number(t.slice(i + 1))] = t.slice(0, i);
    }
  }

  get(id: number): string {
    return this.syms[id] ?? "";
  }
}

export interface Word {
  text: string;
  start: number;
  end: number;
}

/**
 * Group BPE tokens into words. A token starting with "▁" begins a new word.
 * Token times mark when the transducer emitted them, so a word ends at the
 * next word's start, but no later than `tail` seconds after its last token
 * (pauses must not stretch words).
 */
export function tokensToWords(
  syms: SymbolTable,
  tokens: number[],
  times: number[],
  tail = 0.3,
): Word[] {
  const words: { text: string; start: number; last: number }[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const s = syms.get(tokens[i]);
    if (!s || s === "<unk>") continue;
    const begins = s.startsWith("▁");
    const piece = begins ? s.slice(1) : s;
    if (begins || words.length === 0) {
      if (!piece && begins) {
        // Lone "▁": the next piece starts the word.
        words.push({ text: "", start: times[i], last: times[i] });
        continue;
      }
      words.push({ text: piece, start: times[i], last: times[i] });
    } else {
      const w = words[words.length - 1];
      w.text += piece;
      w.last = times[i];
    }
  }
  const out: Word[] = [];
  const filtered = words.filter((w) => w.text.length > 0);
  for (let i = 0; i < filtered.length; i++) {
    const w = filtered[i];
    const nextStart = i + 1 < filtered.length ? filtered[i + 1].start : Infinity;
    out.push({ text: w.text, start: w.start, end: Math.min(nextStart, w.last + tail) });
  }
  return out;
}
