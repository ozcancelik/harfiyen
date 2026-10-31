/** What differs between exports of the same streaming weights. */
export interface EncoderShape {
  /** Feature frames fed to the encoder per call (T in the ONNX metadata). */
  chunkSize: number;
  /** Feature frames the window advances per call (decode_chunk_len). */
  chunkShift: number;
  /** Left-context frames covered by the pad_mask input. */
  leftContext: number;
  padMaskLen: number;
  /** How much the model's processed_lens advances per chunk. */
  processedPerChunk: number;
}

export interface ModelConfig extends EncoderShape {
  name: string;
  sampleRate: number;
  featureDim: number;
  subsampling: number;
  frameShiftMs: number;
  contextSize: number;
  vocabSize: number;
  blankId: number;
  unkId: number;
  /** Recurrent encoder state inputs; outputs are named "new_" + name. */
  encoderStates: string[];
  /**
   * The export with long chunks and left context (seda-v0.2 final/), for
   * files: more accurate, no live text needed. Same weights and states.
   */
  final?: EncoderShape;
  lm?: {
    sosId: number;
    numLayers: number;
    hiddenSize: number;
    scale: number;
    lodrScale: number;
  };
  files: Record<string, number>;
}

export type DecodingMethod = "greedy" | "beam" | "beam-lm";

import type { SpeechLang } from "./languages";
export type { SpeechLang };

export interface DecodeOptions {
  /** Missing in jobs and projects from before there was a choice: Turkish. */
  lang?: SpeechLang;
  method: DecodingMethod;
  /** Beam size for modified beam search. */
  maxActivePaths: number;
  lmScale: number;
  lodrScale: number;
}

/** Beam size of the final export, as sedalib's accurate mode. */
export const FINAL_BEAM = 8;

/**
 * With a VAD, a segment ends at a chunk boundary that falls in a pause of
 * `minSilence` seconds after `minSpeech` of speech (sedalib's EndOfSpeech
 * values). Past `maxSegment` seconds any pause will do, and past twice that
 * the segment is cut where it is. The final export's boundaries are 5.12 s
 * apart and fall in a pause less often, so it gets a longer limit.
 */
export const VAD_ENDPOINT = { minSpeech: 0.25, minSilence: 0.25, maxSegment: { streaming: 20, final: 60 } };

/** sherpa-onnx's default endpoint rules, used here to split long audio without a VAD. */
export const ENDPOINT_RULES = [
  { mustContainNonSilence: false, minTrailingSilence: 2.4, minUtteranceLength: 0 },
  { mustContainNonSilence: true, minTrailingSilence: 1.2, minUtteranceLength: 0 },
  { mustContainNonSilence: false, minTrailingSilence: 0, minUtteranceLength: 20 },
];
