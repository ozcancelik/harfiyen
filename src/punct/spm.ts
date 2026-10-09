// SentencePiece unigram encoder (the subset the punctuation model needs:
// identity normaliser, dummy prefix, whitespace as "▁", no byte fallback).
// Viterbi over the piece scores, as in sentencepiece's unigram_model.cc.

export interface SpmVocab {
  pieces: string[];
  scores: number[];
  /** 1 normal, 2 unknown, 3 control */
  types: number[];
  unkId: number;
  bosId: number;
  eosId: number;
  padId: number;
}

const SPACE = "▁";

export class SpmTokenizer {
  private ids = new Map<string, number>();
  private maxLen = 1;
  private unkScore: number;

  constructor(readonly vocab: SpmVocab) {
    let min = Infinity;
    vocab.pieces.forEach((p, i) => {
      if (vocab.types[i] !== 1) return;
      this.ids.set(p, i);
      this.maxLen = Math.max(this.maxLen, [...p].length);
      min = Math.min(min, vocab.scores[i]);
    });
    // sentencepiece: unknown pieces score (min score - 10).
    this.unkScore = min - 10;
  }

  piece(id: number) {
    return this.vocab.pieces[id];
  }

  /** Text -> piece ids (no BOS/EOS). */
  encode(text: string): number[] {
    return this.encodeWithSpans(text).ids;
  }

  /**
   * Piece ids plus the exact text each one covers ("▁" for spaces), so an
   * <unk> piece still knows which characters it stands for.
   */
  encodeWithSpans(text: string): { ids: number[]; spans: string[] } {
    const norm = SPACE + text.trim().replace(/\s+/g, " ").replaceAll(" ", SPACE);
    const chars = [...norm];
    const n = chars.length;
    const best = new Float64Array(n + 1).fill(-Infinity);
    const from = new Int32Array(n + 1).fill(-1);
    const via = new Int32Array(n + 1).fill(-1);
    best[0] = 0;
    for (let i = 0; i < n; i++) {
      if (best[i] === -Infinity) continue;
      let s = "";
      let matched = false;
      for (let j = i; j < Math.min(n, i + this.maxLen); j++) {
        s += chars[j];
        const id = this.ids.get(s);
        if (id === undefined) continue;
        matched = true;
        const sc = best[i] + this.vocab.scores[id];
        if (sc > best[j + 1]) {
          best[j + 1] = sc;
          from[j + 1] = i;
          via[j + 1] = id;
        }
      }
      if (!matched || best[i + 1] === -Infinity) {
        const sc = best[i] + this.unkScore;
        if (sc > best[i + 1]) {
          best[i + 1] = sc;
          from[i + 1] = i;
          via[i + 1] = this.vocab.unkId;
        }
      }
    }
    const ids: number[] = [];
    const spans: string[] = [];
    for (let k = n; k > 0; k = from[k]) {
      ids.push(via[k]);
      spans.push(chars.slice(from[k], k).join(""));
    }
    ids.reverse();
    spans.reverse();
    // sentencepiece merges runs of unknown characters into one <unk>.
    const outIds: number[] = [];
    const outSpans: string[] = [];
    ids.forEach((id, i) => {
      if (id === this.vocab.unkId && outIds.length && outIds[outIds.length - 1] === this.vocab.unkId) {
        outSpans[outSpans.length - 1] += spans[i];
      } else {
        outIds.push(id);
        outSpans.push(spans[i]);
      }
    });
    return { ids: outIds, spans: outSpans };
  }
}
