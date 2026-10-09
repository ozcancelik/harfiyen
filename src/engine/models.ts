// Thin wrappers around the ONNX sessions. Works with onnxruntime-web (browser)
// and onnxruntime-node (tests): both expose the same API.

import type * as OrtWeb from "onnxruntime-web";
import type { ModelConfig } from "./config";

export type Ort = typeof OrtWeb;
type Session = OrtWeb.InferenceSession;
type Tensor = OrtWeb.Tensor;

export type EncoderProvider = "webgpu" | "wasm" | "cpu";

export interface Encoder {
  /** Clear the recurrent state for a new stream. */
  reset(): void;
  /** x: chunkSize * featureDim features. Returns [frames, 512]. */
  run(x: Float32Array): Promise<{ data: Float32Array; frames: number }>;
}

/**
 * The model's left-context padding mask, which the original graph derived
 * from the int64 `processed_lens` (see externalize_pad_mask in
 * scripts/prepare_models.py): 1 marks cached frames that do not exist yet.
 */
function padMask(cfg: ModelConfig, processed: number): Int32Array {
  const m = new Int32Array(cfg.padMaskLen);
  for (let k = 0; k < cfg.leftContext; k++) m[k] = processed <= cfg.leftContext - 1 - k ? 1 : 0;
  return m;
}

const staticShape = (shape: readonly (number | string)[]) => shape.map((d) => (typeof d === "number" ? d : 1));

export async function createEncoder(
  ort: Ort,
  bytes: Uint8Array,
  provider: EncoderProvider,
  cfg: ModelConfig,
): Promise<Encoder> {
  // Note: WebGPU graph capture (enableGraphCapture) records fine but fails on
  // replay with onnxruntime-web 1.30 for this model, so it is not used.
  const options: OrtWeb.InferenceSession.SessionOptions = {
    executionProviders: [provider],
    graphOptimizationLevel: "all",
    // ORT warns that it keeps a few shape ops on the CPU; that is intended.
    logSeverityLevel: 3,
  };
  if (provider === "webgpu") {
    // Keep the recurrent states on the GPU between chunks.
    const location: Record<string, OrtWeb.Tensor.DataLocation> = { encoder_out: "cpu" };
    for (const name of cfg.encoderStates) location["new_" + name] = "gpu-buffer";
    options.preferredOutputLocation = location;
  }
  return new TensorEncoder(ort, await ort.InferenceSession.create(bytes, options), cfg);
}

/** Plain session.run() with tensors; works on every execution provider. */
class TensorEncoder implements Encoder {
  private states: Record<string, Tensor> = {};
  private processed = 0;

  constructor(
    private ort: Ort,
    private session: Session,
    private cfg: ModelConfig,
  ) {
    this.reset();
  }

  reset() {
    this.disposeStates();
    this.processed = 0;
    for (const name of this.cfg.encoderStates) {
      const m = this.session.inputMetadata.find((v) => v.name === name);
      if (!m || !m.isTensor) throw new Error(`encoder input ${name} has no metadata`);
      const shape = staticShape(m.shape);
      this.states[name] = new this.ort.Tensor("float32", new Float32Array(shape.reduce((a, b) => a * b, 1)), shape);
    }
  }

  async run(x: Float32Array) {
    const { chunkSize, featureDim } = this.cfg;
    const out = await this.session.run({
      x: new this.ort.Tensor("float32", x, [1, chunkSize, featureDim]),
      pad_mask: new this.ort.Tensor("int32", padMask(this.cfg, this.processed), [1, this.cfg.padMaskLen]),
      ...this.states,
    });
    this.processed += this.cfg.processedPerChunk;
    const prev = this.states;
    this.states = {};
    for (const name of this.cfg.encoderStates) this.states[name] = out["new_" + name];
    for (const t of Object.values(prev)) if (t.location === "gpu-buffer") t.dispose();
    const enc = out["encoder_out"];
    return { data: (await enc.getData()) as Float32Array, frames: enc.dims[1] };
  }

  private disposeStates() {
    for (const t of Object.values(this.states)) if (t.location === "gpu-buffer") t.dispose();
    this.states = {};
  }
}

export class Decoder {
  constructor(
    private ort: Ort,
    private session: Session,
    private contextSize: number,
  ) {}

  /** contexts: one array of contextSize token ids per row. */
  async run(contexts: number[][]): Promise<Float32Array> {
    const n = contexts.length;
    const y = new BigInt64Array(n * this.contextSize);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < this.contextSize; j++) y[i * this.contextSize + j] = BigInt(contexts[i][j]);
    }
    const out = await this.session.run({ y: new this.ort.Tensor("int64", y, [n, this.contextSize]) });
    return out["decoder_out"].data as Float32Array;
  }
}

export class Joiner {
  constructor(
    private ort: Ort,
    private session: Session,
    private dim: number,
  ) {}

  async run(enc: Float32Array, dec: Float32Array, n: number): Promise<Float32Array> {
    const out = await this.session.run({
      encoder_out: new this.ort.Tensor("float32", enc, [n, this.dim]),
      decoder_out: new this.ort.Tensor("float32", dec, [n, this.dim]),
    });
    return out["logit"].data as Float32Array;
  }
}

export interface LmOut {
  scores: Float32Array;
  h: Float32Array;
  c: Float32Array;
}

export class RnnLm {
  constructor(
    private ort: Ort,
    private session: Session,
    private cfg: ModelConfig["lm"],
  ) {}

  zeroState(): Float32Array {
    return new Float32Array(this.cfg.numLayers * this.cfg.hiddenSize);
  }

  /** Feed one token (batch 1, as sherpa-onnx does for shallow fusion). */
  async step(token: number, h: Float32Array, c: Float32Array): Promise<LmOut> {
    const s = [this.cfg.numLayers, 1, this.cfg.hiddenSize];
    const out = await this.session.run({
      x: new this.ort.Tensor("int64", BigInt64Array.of(BigInt(token)), [1, 1]),
      h0: new this.ort.Tensor("float32", h, s),
      c0: new this.ort.Tensor("float32", c, s),
    });
    return {
      scores: out["log_softmax"].data as Float32Array,
      h: out["next_h0"].data as Float32Array,
      c: out["next_c0"].data as Float32Array,
    };
  }
}
