// Transducer search, ported from sherpa-onnx:
//   online-transducer-greedy-search-decoder.cc
//   online-transducer-modified-beam-search-decoder.cc
//   online-rnn-lm.cc (shallow fusion) + lodr-fst.cc

import type { ModelConfig } from "./config";
import type { LodrFst, LodrState } from "./lodr";
import type { Decoder, Joiner, RnnLm } from "./models";

export interface SearchResult {
  tokens: number[];
  /** Encoder frame index of each token (absolute, since start of audio). */
  frames: number[];
}

export interface Search {
  decode(enc: Float32Array, numFrames: number): Promise<void>;
  /** Best hypothesis of the current segment. */
  result(): SearchResult;
  numTrailingBlanks(): number;
  /** Start a new segment, keeping the decoder context (sherpa Reset()). */
  reset(): void;
}

function argmax(v: Float32Array, start: number, n: number): number {
  let best = 0;
  let bestV = v[start];
  for (let i = 1; i < n; i++) {
    if (v[start + i] > bestV) {
      bestV = v[start + i];
      best = i;
    }
  }
  return best;
}

function logSoftmaxRow(v: Float32Array, start: number, n: number) {
  let max = -Infinity;
  for (let i = 0; i < n; i++) if (v[start + i] > max) max = v[start + i];
  let sum = 0;
  for (let i = 0; i < n; i++) sum += Math.exp(v[start + i] - max);
  const lse = max + Math.log(sum);
  for (let i = 0; i < n; i++) v[start + i] -= lse;
}

function logAdd(a: number, b: number): number {
  if (a === -Infinity) return b;
  if (b === -Infinity) return a;
  const m = Math.max(a, b);
  return m + Math.log(Math.exp(a - m) + Math.exp(b - m));
}

/** Indices of the k largest values, largest first. */
function topk(v: Float32Array, k: number): number[] {
  const idx: number[] = [];
  const val: number[] = [];
  for (let i = 0; i < v.length; i++) {
    const x = v[i];
    let p: number;
    if (idx.length < k) {
      p = idx.push(i) - 1;
      val.push(x);
    } else if (x > val[k - 1]) {
      p = k - 1;
      idx[p] = i;
      val[p] = x;
    } else {
      continue;
    }
    // Bubble the new entry up to keep the list sorted, largest first.
    for (; p > 0 && val[p - 1] < val[p]; p--) {
      [val[p - 1], val[p]] = [val[p], val[p - 1]];
      [idx[p - 1], idx[p]] = [idx[p], idx[p - 1]];
    }
  }
  return idx;
}

function emptyContext(contextSize: number): number[] {
  const ys = new Array<number>(contextSize).fill(-1);
  ys[contextSize - 1] = 0;
  return ys;
}

export class GreedySearch implements Search {
  private ys: number[];
  private frames: number[] = [];
  private trailing = 0;
  private decOut: Float32Array | null = null;
  private frameOffset = 0;

  constructor(
    private cfg: ModelConfig,
    private decoder: Decoder,
    private joiner: Joiner,
  ) {
    this.ys = emptyContext(cfg.contextSize);
  }

  async decode(enc: Float32Array, numFrames: number) {
    const { contextSize: ctx, vocabSize: V, unkId } = this.cfg;
    const D = enc.length / numFrames;
    if (!this.decOut) this.decOut = await this.decoder.run([this.ys.slice(-ctx)]);
    for (let t = 0; t < numFrames; t++) {
      const logit = await this.joiner.run(enc.subarray(t * D, (t + 1) * D), this.decOut, 1);
      const y = argmax(logit, 0, V);
      if (y !== 0 && y !== unkId) {
        this.ys.push(y);
        this.frames.push(t + this.frameOffset);
        this.trailing = 0;
        this.decOut = await this.decoder.run([this.ys.slice(-ctx)]);
      } else {
        this.trailing++;
      }
    }
    this.frameOffset += numFrames;
  }

  result(): SearchResult {
    return { tokens: this.ys.slice(this.cfg.contextSize), frames: this.frames.slice() };
  }

  numTrailingBlanks() {
    return this.trailing;
  }

  reset() {
    // The decoder output only depends on the last context tokens, keep it.
    this.ys = this.ys.slice(-this.cfg.contextSize);
    this.frames = [];
    this.trailing = 0;
  }
}

/** Lazily evaluated RNN LM state: scores for the token after `token`. */
interface LmNode {
  parent: LmNode | null;
  token: number;
  out: { scores: Float32Array; h: Float32Array; c: Float32Array } | null;
  pending: Promise<void> | null;
}

interface Hyp {
  ys: number[];
  key: string;
  frames: number[];
  /** Acoustic log-prob (the LM part lives in lmLogProb under shallow fusion). */
  logProb: number;
  lmLogProb: number;
  trailing: number;
  /** Decoder output for ys' last context tokens, shared until a token is added. */
  dec: Float32Array | null;
  lm: LmNode | null;
  lodr: LodrState | null;
}

export interface LanguageModel {
  lm: RnnLm;
  lodr: LodrFst | null;
  scale: number;
  lodrScale: number;
}

export class ModifiedBeamSearch implements Search {
  private hyps = new Map<string, Hyp>();
  private frameOffset = 0;
  private lmRoot: LmNode | null = null;

  constructor(
    private cfg: ModelConfig,
    private decoder: Decoder,
    private joiner: Joiner,
    private maxActivePaths: number,
    private lm: LanguageModel | null = null,
  ) {
    this.addHyp(this.hyps, this.blankHyp(emptyContext(cfg.contextSize), 0));
  }

  private blankHyp(ys: number[], logProb: number): Hyp {
    return {
      ys,
      key: ys.join("-"),
      frames: [],
      logProb,
      lmLogProb: 0,
      trailing: 0,
      dec: null,
      lm: null,
      lodr: null,
    };
  }

  private addHyp(map: Map<string, Hyp>, h: Hyp) {
    const old = map.get(h.key);
    if (old) old.logProb = logAdd(old.logProb, h.logProb);
    else map.set(h.key, h);
  }

  private async lmRootNode(): Promise<LmNode> {
    if (!this.lmRoot) {
      const lm = this.lm!.lm;
      const out = await lm.step(this.cfg.lm.sosId, lm.zeroState(), lm.zeroState());
      this.lmRoot = { parent: null, token: this.cfg.lm.sosId, out, pending: null };
    }
    return this.lmRoot;
  }

  private async ensure(node: LmNode): Promise<void> {
    if (node.out) return;
    if (!node.pending) {
      node.pending = (async () => {
        const parent = node.parent!;
        await this.ensure(parent);
        node.out = await this.lm!.lm.step(node.token, parent.out!.h, parent.out!.c);
        node.pending = null;
      })();
    }
    await node.pending;
  }

  /** Shallow fusion for the token just appended to h (ComputeLMScoreSF). */
  private async scoreLm(h: Hyp) {
    const lm = this.lm!;
    const token = h.ys[h.ys.length - 1];
    if (!h.lm) {
      h.lm = await this.lmRootNode();
      h.lodr = lm.lodr ? lm.lodr.initialState() : null;
    }
    await this.ensure(h.lm);
    h.lmLogProb += h.lm.out!.scores[token] * lm.scale;
    if (lm.lodr && h.lodr) {
      const next = lm.lodr.forward(h.lodr, token);
      h.lmLogProb += (lm.lodr.score(next) - lm.lodr.score(h.lodr)) * lm.lodrScale;
      h.lodr = next;
    }
    h.lm = { parent: h.lm, token, out: null, pending: null };
  }

  async decode(enc: Float32Array, numFrames: number) {
    const { contextSize: ctx, vocabSize: V, unkId } = this.cfg;
    const D = enc.length / numFrames;
    const useLm = this.lm !== null;

    for (let t = 0; t < numFrames; t++) {
      const prev = [...this.hyps.values()];
      const n = prev.length;

      const missing = prev.filter((h) => !h.dec);
      if (missing.length) {
        const out = await this.decoder.run(missing.map((h) => h.ys.slice(-ctx)));
        missing.forEach((h, i) => (h.dec = out.slice(i * D, (i + 1) * D)));
      }

      const encRep = new Float32Array(n * D);
      const decStack = new Float32Array(n * D);
      const frame = enc.subarray(t * D, (t + 1) * D);
      for (let i = 0; i < n; i++) {
        encRep.set(frame, i * D);
        decStack.set(prev[i].dec!, i * D);
      }
      const logit = await this.joiner.run(encRep, decStack, n);
      for (let i = 0; i < n; i++) {
        logSoftmaxRow(logit, i * V, V);
        const base = prev[i].logProb + (useLm ? prev[i].lmLogProb : 0);
        for (let k = 0; k < V; k++) logit[i * V + k] += base;
      }

      const next = new Map<string, Hyp>();
      for (const k of topk(logit, this.maxActivePaths)) {
        const src = prev[Math.floor(k / V)];
        const token = k % V;
        const h: Hyp = { ...src };
        const prevLmLogProb = src.lmLogProb;
        if (token !== 0 && token !== unkId) {
          h.ys = [...src.ys, token];
          h.key = src.key + "-" + token;
          h.frames = [...src.frames, t + this.frameOffset];
          h.trailing = 0;
          h.dec = null;
          if (useLm) await this.scoreLm(h);
        } else {
          h.trailing = src.trailing + 1;
        }
        h.logProb = useLm ? logit[k] - prevLmLogProb : logit[k];
        this.addHyp(next, h);
      }
      this.hyps = next;
    }
    this.frameOffset += numFrames;
  }

  private best(): Hyp {
    let best: Hyp | null = null;
    let bestScore = -Infinity;
    for (const h of this.hyps.values()) {
      const s = (h.logProb + h.lmLogProb) / h.ys.length;
      if (best === null || s > bestScore) {
        best = h;
        bestScore = s;
      }
    }
    return best!;
  }

  result(): SearchResult {
    const b = this.best();
    return { tokens: b.ys.slice(this.cfg.contextSize), frames: b.frames.slice() };
  }

  numTrailingBlanks() {
    return this.best().trailing;
  }

  reset() {
    const ctx = this.cfg.contextSize;
    const next = new Map<string, Hyp>();
    if (this.best().ys.length > ctx) {
      for (const h of this.hyps.values()) {
        const nh = this.blankHyp(h.ys.slice(-ctx), h.logProb);
        nh.dec = h.dec;
        this.addHyp(next, nh);
      }
    } else {
      this.addHyp(next, this.blankHyp(emptyContext(ctx), 0));
    }
    this.hyps = next;
  }
}
