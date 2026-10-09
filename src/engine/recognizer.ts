// Streaming recognizer: fbank -> chunked encoder -> transducer search, with
// sherpa-onnx endpointing to keep hypotheses short on long recordings.

import { ENDPOINT_RULES, type ModelConfig } from "./config";
import { OnlineFbank } from "./fbank";
import type { Encoder } from "./models";
import type { Search } from "./search";
import { tokensToWords, type SymbolTable, type Word } from "./tokens";

/** Silence appended at the end so the last chunk gets decoded (as in the model card). */
const TAIL_PADDING_SEC = 1;

export class Recognizer {
  private fbank: OnlineFbank;
  private feats: Float32Array;
  /** Absolute index of the frame stored at feats[0]. */
  private featStart = 0;
  private featCount = 0;
  /** Absolute feature frame where the next encoder chunk starts. */
  private processed = 0;
  private segmentStart = 0;
  private finished = false;
  /** Milliseconds spent in the encoder and in the search, for diagnostics. */
  readonly timing = { encoder: 0, search: 0, chunks: 0 };
  /** Called with every 80-dim log-mel frame (10 ms), e.g. for visualisation. */
  onFeature: ((f: Float32Array) => void) | null = null;

  // Tokens of the word that may still continue in the next segment.
  private carryTokens: number[] = [];
  private carryFrames: number[] = [];
  private committed: Word[] = [];

  constructor(
    private cfg: ModelConfig,
    private encoder: Encoder,
    private search: Search,
    private syms: SymbolTable,
  ) {
    this.fbank = new OnlineFbank(cfg.featureDim);
    this.feats = new Float32Array(cfg.featureDim * 1024);
  }

  /** Seconds of audio covered by decoded chunks so far. */
  get decodedSeconds() {
    return (this.processed * this.cfg.frameShiftMs) / 1000;
  }

  acceptWaveform(samples: Float32Array) {
    this.fbank.acceptWaveform(samples);
    this.pullFeatures();
  }

  inputFinished() {
    if (this.finished) return;
    this.finished = true;
    this.fbank.acceptWaveform(new Float32Array(this.cfg.sampleRate * TAIL_PADDING_SEC));
    this.fbank.inputFinished();
    this.pullFeatures();
  }

  isReady() {
    return this.processed + this.cfg.chunkSize < this.featCount;
  }

  /** Decode one encoder chunk. Call while isReady(). */
  async decodeChunk() {
    const { chunkSize, chunkShift, featureDim: F } = this.cfg;
    const from = (this.processed - this.featStart) * F;
    const x = this.feats.slice(from, from + chunkSize * F);
    this.processed += chunkShift;
    const t0 = performance.now();
    const out = await this.encoder.run(x);
    const t1 = performance.now();
    await this.search.decode(out.data, out.frames);
    this.timing.encoder += t1 - t0;
    this.timing.search += performance.now() - t1;
    this.timing.chunks++;
    if (this.isEndpoint()) {
      this.commit(this.search.result(), false);
      this.search.reset();
      this.segmentStart = this.processed;
    }
  }

  /** After the last decodeChunk() of a finished stream. */
  flush() {
    this.commit(this.search.result(), true);
    this.search.reset();
  }

  /** Words that are final, returned once. */
  takeCommitted(): Word[] {
    const w = this.committed;
    this.committed = [];
    return w;
  }

  /** Words of the current, still changing segment. */
  tentative(): Word[] {
    const r = this.search.result();
    return this.words([...this.carryTokens, ...r.tokens], [...this.carryFrames, ...r.frames]);
  }

  private words(tokens: number[], frames: number[]): Word[] {
    const sec = (this.cfg.subsampling * this.cfg.frameShiftMs) / 1000;
    return tokensToWords(this.syms, tokens, frames.map((f) => f * sec));
  }

  private commit(r: { tokens: number[]; frames: number[] }, all: boolean) {
    const tokens = [...this.carryTokens, ...r.tokens];
    const frames = [...this.carryFrames, ...r.frames];
    // The segment's last word may continue after the reset (rule 3 cuts at
    // 20 s even mid-word), so hold it back until the next segment starts.
    let cut = tokens.length;
    if (!all) {
      cut = 0;
      for (let i = tokens.length - 1; i >= 0; i--) {
        if (this.syms.get(tokens[i]).startsWith("▁")) {
          cut = i;
          break;
        }
      }
    }
    this.committed.push(...this.words(tokens.slice(0, cut), frames.slice(0, cut)));
    this.carryTokens = tokens.slice(cut);
    this.carryFrames = frames.slice(cut);
  }

  private isEndpoint(): boolean {
    const shift = this.cfg.frameShiftMs / 1000;
    const utterance = (this.processed - this.segmentStart) * shift;
    const trailing = this.search.numTrailingBlanks() * this.cfg.subsampling * shift;
    return ENDPOINT_RULES.some(
      (r) =>
        (utterance > trailing || !r.mustContainNonSilence) &&
        trailing >= r.minTrailingSilence &&
        utterance >= r.minUtteranceLength,
    );
  }

  private pullFeatures() {
    const F = this.cfg.featureDim;
    this.fbank.compute((f) => {
      this.onFeature?.(f);
      // Drop frames no future chunk will read, then grow if still full.
      let used = this.featCount - this.featStart;
      if ((used + 1) * F > this.feats.length) {
        const drop = this.processed - this.featStart;
        if (drop > 0) {
          this.feats.copyWithin(0, drop * F, used * F);
          this.featStart += drop;
          used -= drop;
        }
        if ((used + 1) * F > this.feats.length) {
          const next = new Float32Array(this.feats.length * 2);
          next.set(this.feats.subarray(0, used * F));
          this.feats = next;
        }
      }
      this.feats.set(f, used * F);
      this.featCount++;
    });
  }
}
