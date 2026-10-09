// Punctuation, true-casing and sentence boundaries for a transcript, with
// 1-800-BAD-CODE/punct_cap_seg_47_language (ONNX, int8). Port of the
// `punctuators` package's windowing and decoding, but the result is mapped
// back onto the transcript's words so their timestamps survive.

import type { Ort } from "../engine/models";
import { SpmTokenizer, type SpmVocab } from "./spm";

export interface PunctConfig {
  maxLength: number;
  overlap: number;
  preLabels: string[];
  postLabels: string[];
  nullToken: string;
  files: Record<string, number>;
}

export interface WordMark {
  /** The word with the model's capitalisation (Turkish casing rules). */
  text: string;
  /** Punctuation after the word, e.g. "," "." "?". */
  post: string | null;
  /** The model ends a sentence after this word. */
  sentenceEnd: boolean;
  /** The model capitalised the first letter. */
  capitalised: boolean;
}

const upperTr = (c: string) => c.toLocaleUpperCase("tr-TR");

export class Punctuator {
  private constructor(
    private ort: Ort,
    private session: Awaited<ReturnType<Ort["InferenceSession"]["create"]>>,
    private tok: SpmTokenizer,
    private cfg: PunctConfig,
  ) {}

  /** Runs on the CPU (wasm in the browser, "cpu" in Node): it is a one-off pass over the text. */
  static async create(
    ort: Ort,
    model: Uint8Array,
    vocab: SpmVocab,
    cfg: PunctConfig,
    provider: "wasm" | "cpu" = "wasm",
  ): Promise<Punctuator> {
    const session = await ort.InferenceSession.create(model, {
      executionProviders: [provider],
      graphOptimizationLevel: "all",
      logSeverityLevel: 3,
    });
    return new Punctuator(ort, session, new SpmTokenizer(vocab), cfg);
  }

  /** words: lowercase, unpunctuated, one entry per word (no spaces inside). */
  async run(words: string[], onProgress?: (done: number, total: number) => void): Promise<WordMark[]> {
    if (!words.length) return [];
    const { ids, spans } = this.tok.encodeWithSpans(words.join(" "));
    const n = ids.length;
    const { maxLength, overlap } = this.cfg;
    const inner = maxLength - 2;

    // Same windows as punctuators' TextInferenceDataset.
    const windows: [number, number][] = [];
    for (let start = 0, i = 0; start < n; i++) {
      const a = start - (i === 0 ? 0 : overlap);
      const b = Math.min(n, a + inner);
      windows.push([a, b]);
      start = a + inner;
    }

    const post = new Int32Array(n);
    const seg = new Uint8Array(n);
    const cap: Uint8Array[] = new Array(n);
    const { bosId, eosId } = this.tok.vocab;
    for (let w = 0; w < windows.length; w++) {
      const [a, b] = windows[w];
      const len = b - a + 2;
      const x = new BigInt64Array(len);
      x[0] = BigInt(bosId);
      for (let k = a; k < b; k++) x[k - a + 1] = BigInt(ids[k]);
      x[len - 1] = BigInt(eosId);
      const out = await this.session.run({ input_ids: new this.ort.Tensor("int64", x, [1, len]) });
      const postP = out["post_preds"].data as BigInt64Array;
      const capP = out["cap_preds"].data as Uint8Array;
      const segP = out["seg_preds"].data as Uint8Array;
      const capW = out["cap_preds"].dims[2];
      // Overlapping windows: each keeps its middle part.
      const from = w > 0 ? overlap / 2 : 0;
      const to = w < windows.length - 1 ? b - a - overlap / 2 : b - a;
      for (let k = from; k < to; k++) {
        const t = a + k;
        post[t] = Number(postP[k + 1]);
        seg[t] = segP[k + 1];
        cap[t] = capP.slice((k + 1) * capW, (k + 2) * capW);
      }
      onProgress?.(w + 1, windows.length);
    }

    // Tokens -> words: a piece starting with "▁" starts a new word.
    const marks: WordMark[] = [];
    let cur: WordMark | null = null;
    for (let t = 0; t < n; t++) {
      const chars = Array.from(spans[t]);
      const starts = chars[0] === "▁";
      if (starts || !cur) {
        cur = { text: "", post: null, sentenceEnd: false, capitalised: false };
        marks.push(cur);
      }
      for (let ci = starts ? 1 : 0; ci < chars.length; ci++) {
        const up = ci < cap[t].length && cap[t][ci] === 1;
        if (up && cur.text === "") cur.capitalised = true;
        cur.text += up ? upperTr(chars[ci]) : chars[ci];
      }
      // Punctuation and boundaries count at the end of a word.
      const label = this.cfg.postLabels[post[t]];
      cur.post = label && label !== this.cfg.nullToken ? label : null;
      cur.sentenceEnd = seg[t] === 1;
    }
    if (marks.length !== words.length) {
      throw new Error(`punctuation: ${marks.length} words from the model, ${words.length} expected`);
    }
    return marks;
  }
}
