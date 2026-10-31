// Supertonic 3 (Supertone/supertonic-3, OpenRAIL-M): multilingual text to 44.1 kHz speech, for dubbing in
// English (and Turkish). A port of the model's web example (helper.js): a duration predictor, a text encoder, a
// flow-matching vector estimator run for a few steps from noise, and a vocoder. The voice is one of the ten
// styles shipped with the model.

import type { InferenceSession } from "onnxruntime-web";
import type { MtLang } from "../engine/languages";
import type { Ort } from "../engine/models";

export type SupertonicLang = MtLang;

export interface SupertonicManifest {
  sampleRate: number;
  baseChunkSize: number;
  chunkCompress: number;
  latentDim: number;
  /** Style names in the order styles.bin holds them. */
  styles: string[];
  ttlDims: [number, number];
  dpDims: [number, number];
}

/** Denoising steps; the web example's default. */
const STEPS = 8;
/** The release reads at 1.05 by default; speed is relative to that. */
const BASE_SPEED = 1.05;
/** Longest piece read in one go, in characters. */
const MAX_CHARS = 300;
/** Silence between the pieces of a long line. */
const PIECE_GAP = 0.2;

const TYPOGRAPHY: [RegExp, string][] = [
  [/[–‑—]/g, "-"],
  [/[_[\]|/#→←]/g, " "],
  [/[“”]/g, '"'],
  [/[‘’´`]/g, "'"],
  [/[♥☆♡©\\]/g, ""],
  [/@/g, " at "],
];

/** The model's text preprocessing (helper.js preprocessText), without the language tags. */
function clean(text: string): string {
  text = text.normalize("NFKD").replace(/\p{Extended_Pictographic}/gu, "");
  for (const [re, to] of TYPOGRAPHY) text = text.replace(re, to);
  text = text
    .replace(/ ([,.!?;:'])/g, "$1")
    .replace(/"{2,}/g, '"')
    .replace(/'{2,}/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  if (text && !/[.!?;:,'")\]}…]$/.test(text)) text += ".";
  return text;
}

/** Pieces of at most MAX_CHARS, cut at sentence ends, else at spaces. */
function pieces(text: string): string[] {
  const out: string[] = [];
  let cur = "";
  const words = text.split(/(?<=[.!?…])\s+/).flatMap((s) => (s.length <= MAX_CHARS ? [s] : s.split(" ")));
  for (const w of words) {
    if (cur && cur.length + 1 + w.length > MAX_CHARS) {
      out.push(cur);
      cur = w;
    } else cur = cur ? `${cur} ${w}` : w;
  }
  if (cur) out.push(cur);
  return out;
}

/** A small seeded generator (mulberry32), so a seed always gives the same reading. */
function random(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

export class Supertonic {
  readonly rate: number;
  private styles: Float32Array;

  private constructor(
    private ort: Ort,
    private meta: SupertonicManifest,
    private sessions: Record<"duration" | "text" | "vector" | "vocoder", InferenceSession>,
    private indexer: Int32Array,
    styles: Uint8Array,
  ) {
    this.rate = meta.sampleRate;
    this.styles = new Float32Array(styles.buffer, styles.byteOffset, styles.byteLength / 4);
  }

  /** `files` as VOICE_PACKS.supertonic lists them. Sessions are made one at a time: wasm rejects concurrent ones. */
  static async load(ort: Ort, meta: SupertonicManifest, files: Uint8Array[], opts: InferenceSession.SessionOptions) {
    const [duration, text, vector, vocoder, indexer, styles] = files;
    const sessions = {
      duration: await ort.InferenceSession.create(duration, opts),
      text: await ort.InferenceSession.create(text, opts),
      vector: await ort.InferenceSession.create(vector, opts),
      vocoder: await ort.InferenceSession.create(vocoder, opts),
    };
    const ids = new Int32Array(indexer.buffer.slice(indexer.byteOffset, indexer.byteOffset + indexer.byteLength));
    // Copied so the Float32Array view is aligned.
    return new Supertonic(ort, meta, sessions, ids, styles.slice());
  }

  get styleNames() {
    return this.meta.styles;
  }

  private style(name: string) {
    const [t1, t2] = this.meta.ttlDims;
    const [d1, d2] = this.meta.dpDims;
    const size = t1 * t2 + d1 * d2;
    const at = Math.max(0, this.meta.styles.indexOf(name)) * size;
    return {
      ttl: new this.ort.Tensor("float32", this.styles.subarray(at, at + t1 * t2), [1, t1, t2]),
      dp: new this.ort.Tensor("float32", this.styles.subarray(at + t1 * t2, at + size), [1, d1, d2]),
    };
  }

  /** All of the text as one buffer of audio at `rate`. `speed` above 1 speaks faster. */
  async speak(text: string, lang: SupertonicLang, style: string, speed = 1, seed = 0): Promise<Float32Array> {
    const parts = pieces(clean(text));
    const st = this.style(style);
    const rand = random(seed);
    const out: Float32Array[] = [];
    for (const p of parts) {
      if (out.length) out.push(new Float32Array(Math.round(PIECE_GAP * this.rate)));
      out.push(await this.piece(`<${lang}>${p}</${lang}>`, st, BASE_SPEED * speed, rand));
    }
    const all = new Float32Array(out.reduce((n, c) => n + c.length, 0));
    let o = 0;
    for (const c of out) {
      all.set(c, o);
      o += c.length;
    }
    return all;
  }

  private async piece(
    text: string,
    st: ReturnType<Supertonic["style"]>,
    speed: number,
    rand: () => number,
  ): Promise<Float32Array> {
    const { Tensor } = this.ort;
    const ids = BigInt64Array.from([...text], (c) => {
      const cp = c.codePointAt(0)!;
      return BigInt(cp < this.indexer.length ? this.indexer[cp] : -1);
    });
    const n = ids.length;
    const textIds = new Tensor("int64", ids, [1, n]);
    const textMask = new Tensor("float32", new Float32Array(n).fill(1), [1, 1, n]);

    const { duration } = await this.sessions.duration.run({ text_ids: textIds, style_dp: st.dp, text_mask: textMask });
    const seconds = (duration.data as Float32Array)[0] / speed;
    const { text_emb } = await this.sessions.text.run({ text_ids: textIds, style_ttl: st.ttl, text_mask: textMask });

    const { sampleRate, baseChunkSize, chunkCompress, latentDim } = this.meta;
    const samples = Math.floor(seconds * sampleRate);
    const chunk = baseChunkSize * chunkCompress;
    const dim = latentDim * chunkCompress;
    const len = Math.max(1, Math.ceil(samples / chunk));
    let latent: Float32Array = new Float32Array(dim * len);
    // Gaussian noise (Box–Muller).
    for (let i = 0; i < latent.length; i++)
      latent[i] = Math.sqrt(-2 * Math.log(Math.max(1e-4, rand()))) * Math.cos(2 * Math.PI * rand());
    const latentMask = new Tensor("float32", new Float32Array(len).fill(1), [1, 1, len]);
    const total = new Tensor("float32", Float32Array.of(STEPS), [1]);
    for (let step = 0; step < STEPS; step++) {
      const r = await this.sessions.vector.run({
        noisy_latent: new Tensor("float32", latent, [1, dim, len]),
        text_emb,
        style_ttl: st.ttl,
        latent_mask: latentMask,
        text_mask: textMask,
        current_step: new Tensor("float32", Float32Array.of(step), [1]),
        total_step: total,
      });
      latent = r.denoised_latent.data as Float32Array;
    }
    const { wav_tts } = await this.sessions.vocoder.run({ latent: new Tensor("float32", latent, [1, dim, len]) });
    return (wav_tts.data as Float32Array).slice(0, samples);
  }
}
