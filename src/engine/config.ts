export interface ModelConfig {
  name: string;
  sampleRate: number;
  featureDim: number;
  /** Feature frames fed to the encoder per call (T in the ONNX metadata). */
  chunkSize: number;
  /** Feature frames the window advances per call (decode_chunk_len). */
  chunkShift: number;
  subsampling: number;
  frameShiftMs: number;
  contextSize: number;
  vocabSize: number;
  blankId: number;
  unkId: number;
  /** Recurrent encoder state inputs; outputs are named "new_" + name. */
  encoderStates: string[];
  /** Left-context frames covered by the pad_mask input. */
  leftContext: number;
  padMaskLen: number;
  /** How much the model's processed_lens advances per chunk. */
  processedPerChunk: number;
  lm: {
    sosId: number;
    numLayers: number;
    hiddenSize: number;
    scale: number;
    lodrScale: number;
  };
  files: Record<string, number>;
}

export type DecodingMethod = "greedy" | "beam" | "beam-lm";

export interface DecodeOptions {
  method: DecodingMethod;
  /** Beam size for modified beam search. */
  maxActivePaths: number;
  lmScale: number;
  lodrScale: number;
}

/** sherpa-onnx's default endpoint rules, used here to split long audio. */
export const ENDPOINT_RULES = [
  { mustContainNonSilence: false, minTrailingSilence: 2.4, minUtteranceLength: 0 },
  { mustContainNonSilence: true, minTrailingSilence: 1.2, minUtteranceLength: 0 },
  { mustContainNonSilence: false, minTrailingSilence: 0, minUtteranceLength: 20 },
];
