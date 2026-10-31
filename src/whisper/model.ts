// Whisper encoder and KV-cached decoder (onnx-community "merged" export with
// cross-attention outputs). Works with onnxruntime-web and onnxruntime-node.
// On WebGPU the encoder output and the KV cache stay on the GPU.

import type * as OrtWeb from "onnxruntime-web";
import type { SpeechLang } from "../engine/config";
import { LANG_TOKEN } from "../engine/languages";
import type { EncoderProvider, Ort } from "../engine/models";

type Session = OrtWeb.InferenceSession;
type Tensor = OrtWeb.Tensor;

export interface WhisperConfig {
  name: string;
  numMel: number;
  decoderLayers: number;
  heads: number;
  headDim: number;
  maxTargetPositions: number;
  tokens: {
    sot: number;
    eot: number;
    language: number;
    transcribe: number;
    noTimestamps: number;
    noSpeech: number;
    timestampBegin: number;
  };
  suppress: number[];
  beginSuppress: number[];
  /** [decoder layer, head] pairs whose cross-attention follows the audio. */
  alignmentHeads: [number, number][];
  medianFilterWidth: number;
  maxInitialTimestampIndex: number;
  files: Record<string, number>;
}

export interface Generation {
  /** Generated tokens, text and timestamps, without the end-of-text. */
  tokens: number[];
  noSpeechProb: number;
  avgLogprob: number;
  /** Stopped because the output started repeating itself. */
  looped: boolean;
}

/** Repeats of a tail block that count as a loop, by block length. */
const loopRepeats = (len: number) => (len <= 2 ? 8 : 4);


export class WhisperModel {
  /** The language token the prompt asks for; Turkish unless a recognizer says otherwise. */
  language: number;

  private constructor(
    private ort: Ort,
    readonly config: WhisperConfig,
    private encoder: Session,
    private decoder: Session,
    readonly provider: EncoderProvider,
    private suppressMask: Uint8Array,
  ) {
    this.language = config.tokens.language;
  }

  /** Transcribe `lang` from now on. */
  setLanguage(lang: SpeechLang) {
    this.language = this.config.tokens.sot + LANG_TOKEN[lang];
  }

  static async create(
    ort: Ort,
    config: WhisperConfig,
    encoder: Uint8Array,
    decoder: Uint8Array,
    provider: EncoderProvider,
  ): Promise<WhisperModel> {
    const base = { executionProviders: [provider], graphOptimizationLevel: "all" as const, logSeverityLevel: 3 as const };
    const gpu = provider === "webgpu";
    const enc = await ort.InferenceSession.create(encoder, {
      ...base,
      ...(gpu && { preferredOutputLocation: { last_hidden_state: "gpu-buffer" as const } }),
    });
    const location: Record<string, OrtWeb.Tensor.DataLocation> = { logits: "cpu" };
    for (let l = 0; l < config.decoderLayers; l++) {
      for (const kind of ["decoder", "encoder"]) {
        location[`present.${l}.${kind}.key`] = "gpu-buffer";
        location[`present.${l}.${kind}.value`] = "gpu-buffer";
      }
      location[`cross_attentions.${l}`] = "cpu";
    }
    const dec = await ort.InferenceSession.create(decoder, {
      ...base,
      ...(gpu && { preferredOutputLocation: location }),
    });
    const t = config.tokens;
    const mask = new Uint8Array(t.timestampBegin + 1501);
    for (const id of config.suppress) mask[id] = 1;
    // Every special token except end-of-text: prompt, languages, tasks, no-timestamps.
    for (let id = t.eot + 1; id < t.timestampBegin; id++) mask[id] = 1;
    return new WhisperModel(ort, config, enc, dec, provider, mask);
  }

  get prompt(): number[] {
    const t = this.config.tokens;
    return [t.sot, this.language, t.transcribe];
  }

  /** mel: [numMel, 3000]. The result must be released with release(). */
  async encode(mel: Float32Array): Promise<Tensor> {
    const x = new this.ort.Tensor("float32", mel, [1, this.config.numMel, 3000]);
    const out = await this.encoder.run({ input_features: x });
    return out.last_hidden_state;
  }

  release(...tensors: (Tensor | null | undefined)[]) {
    for (const t of tensors) if (t && t.location === "gpu-buffer") t.dispose();
  }

  private emptyPast() {
    const { decoderLayers, heads, headDim } = this.config;
    const feeds: Record<string, Tensor> = {};
    const empty = new this.ort.Tensor("float32", new Float32Array(0), [1, heads, 0, headDim]);
    for (let l = 0; l < decoderLayers; l++) {
      for (const kind of ["decoder", "encoder"]) {
        feeds[`past_key_values.${l}.${kind}.key`] = empty;
        feeds[`past_key_values.${l}.${kind}.value`] = empty;
      }
    }
    return feeds;
  }

  private ids(tokens: number[]) {
    return new this.ort.Tensor("int64", BigInt64Array.from(tokens, BigInt), [1, tokens.length]);
  }

  private flag(on: boolean) {
    return new this.ort.Tensor("bool", Uint8Array.of(on ? 1 : 0), [1]);
  }

  private names(kinds: string[]) {
    const out: string[] = [];
    for (let l = 0; l < this.config.decoderLayers; l++) {
      for (const kind of kinds) out.push(`present.${l}.${kind}.key`, `present.${l}.${kind}.value`);
    }
    return out;
  }

  /** Greedy decoding of one 30 s window with timestamp tokens. */
  async generate(enc: Tensor, maxNew = this.config.maxTargetPositions - 8): Promise<Generation> {
    const cfg = this.config;
    const prompt = this.prompt;
    const decoderKv = this.names(["decoder"]);
    const encoderKv = this.names(["encoder"]);

    // First call: the whole prompt, which also computes the cross-attention cache.
    let out = await this.decoder.run(
      { input_ids: this.ids(prompt), encoder_hidden_states: enc, use_cache_branch: this.flag(false), ...this.emptyPast() },
      ["logits", ...decoderKv, ...encoderKv],
    );
    const crossKv: Record<string, Tensor> = {};
    for (const n of encoderKv) crossKv[n.replace("present", "past_key_values")] = out[n];
    let selfKv: Record<string, Tensor> = {};
    const takeSelf = () => {
      const next: Record<string, Tensor> = {};
      for (const n of decoderKv) next[n.replace("present", "past_key_values")] = out[n];
      this.release(...Object.values(selfKv));
      selfKv = next;
    };
    takeSelf();

    const V = out.logits.dims[2];
    const all = out.logits.data as Float32Array;
    const noSpeechProb = softmaxAt(all.subarray(0, V), cfg.tokens.noSpeech);
    let logits = all.subarray((prompt.length - 1) * V, prompt.length * V);

    const tokens: number[] = [];
    let sumLogprob = 0;
    let looped = false;
    try {
      for (let step = 0; step < maxNew; step++) {
        const scores = Float32Array.from(logits);
        this.applyRules(scores, tokens);
        const { id, logprob } = argmaxWithLogprob(scores);
        if (id === cfg.tokens.eot) break;
        tokens.push(id);
        sumLogprob += logprob;
        const loop = repeatedTail(tokens);
        if (loop) {
          tokens.length -= loop;
          looped = true;
          break;
        }
        if (step === maxNew - 1) break;
        out = await this.decoder.run(
          {
            input_ids: this.ids([id]),
            encoder_hidden_states: enc,
            use_cache_branch: this.flag(true),
            ...selfKv,
            ...crossKv,
          },
          ["logits", ...decoderKv],
        );
        takeSelf();
        logits = out.logits.data as Float32Array;
      }
    } finally {
      this.release(...Object.values(selfKv), ...Object.values(crossKv));
    }
    return { tokens, noSpeechProb, avgLogprob: tokens.length ? sumLogprob / tokens.length : 0, looped };
  }

  /**
   * Cross-attention of the alignment heads for the forced sequence
   * prompt + no-timestamps + text + end-of-text, one [rows, 1500] array per head.
   */
  async attention(enc: Tensor, text: number[]): Promise<{ heads: Float32Array[]; rows: number; promptLen: number }> {
    const t = this.config.tokens;
    const prefix = [...this.prompt, t.noTimestamps];
    const seq = [...prefix, ...text, t.eot];
    const layers = [...new Set(this.config.alignmentHeads.map(([l]) => l))];
    const out = await this.decoder.run(
      { input_ids: this.ids(seq), encoder_hidden_states: enc, use_cache_branch: this.flag(false), ...this.emptyPast() },
      layers.map((l) => `cross_attentions.${l}`),
    );
    const rows = seq.length;
    const heads = this.config.alignmentHeads.map(([l, h]) => {
      const a = out[`cross_attentions.${l}`];
      const frames = a.dims[3];
      const data = a.data as Float32Array;
      const head = new Float32Array(rows * 1500);
      for (let r = 0; r < rows; r++) head.set(data.subarray((h * rows + r) * frames, (h * rows + r + 1) * frames), r * 1500);
      return head;
    });
    return { heads, rows, promptLen: prefix.length };
  }

  /** Suppressed tokens and Whisper's timestamp rules (transformers' WhisperTimeStampLogitsProcessor). */
  private applyRules(scores: Float32Array, seq: number[]) {
    const t = this.config.tokens;
    const tsBegin = t.timestampBegin;
    const V = scores.length;
    const mask = this.suppressMask;
    for (let i = 0; i < V && i < mask.length; i++) if (mask[i]) scores[i] = -Infinity;
    if (seq.length === 0) for (const id of this.config.beginSuppress) scores[id] = -Infinity;

    const last = seq.length >= 1 && seq[seq.length - 1] >= tsBegin;
    const penultimate = seq.length < 2 || seq[seq.length - 2] >= tsBegin;
    if (last) {
      if (penultimate) scores.fill(-Infinity, tsBegin);
      else scores.fill(-Infinity, 0, t.eot);
    }
    // Timestamps never go back; after a closing timestamp the next one may repeat it.
    let lastTs = -1;
    for (let i = seq.length - 1; i >= 0; i--) {
      if (seq[i] >= tsBegin) {
        lastTs = seq[i];
        break;
      }
    }
    if (lastTs >= 0) scores.fill(-Infinity, tsBegin, last && !penultimate ? lastTs : lastTs + 1);
    if (seq.length === 0) {
      scores.fill(-Infinity, 0, tsBegin);
      scores.fill(-Infinity, tsBegin + this.config.maxInitialTimestampIndex + 1);
    }
    // If timestamps together are likelier than any text token, emit one.
    let max = -Infinity;
    for (let i = 0; i < V; i++) if (scores[i] > max) max = scores[i];
    let sum = 0;
    for (let i = 0; i < V; i++) sum += Math.exp(scores[i] - max);
    const logZ = max + Math.log(sum);
    let tsSum = 0;
    for (let i = tsBegin; i < V; i++) tsSum += Math.exp(scores[i] - max);
    const tsLogprob = max + Math.log(tsSum) - logZ;
    let textMax = -Infinity;
    for (let i = 0; i < tsBegin; i++) if (scores[i] > textMax) textMax = scores[i];
    if (tsLogprob > textMax - logZ) scores.fill(-Infinity, 0, tsBegin);
  }
}

function softmaxAt(x: Float32Array, k: number) {
  let max = -Infinity;
  for (let i = 0; i < x.length; i++) if (x[i] > max) max = x[i];
  let sum = 0;
  for (let i = 0; i < x.length; i++) sum += Math.exp(x[i] - max);
  return Math.exp(x[k] - max) / sum;
}

function argmaxWithLogprob(x: Float32Array) {
  let id = 0;
  for (let i = 1; i < x.length; i++) if (x[i] > x[id]) id = i;
  let sum = 0;
  for (let i = 0; i < x.length; i++) sum += Math.exp(x[i] - x[id]);
  return { id, logprob: -Math.log(sum) };
}

/** Tokens to drop if the tail is one block repeated too often, else 0. */
function repeatedTail(seq: number[]): number {
  for (let len = 1; len <= 16; len++) {
    const need = loopRepeats(len);
    if (seq.length < len * need) continue;
    let reps = 1;
    while ((reps + 1) * len <= seq.length) {
      const a = seq.length - (reps + 1) * len;
      let same = true;
      for (let i = 0; i < len && same; i++) same = seq[a + i] === seq[seq.length - len + i];
      if (!same) break;
      reps++;
    }
    if (reps >= need) return (reps - 1) * len;
  }
  return 0;
}
