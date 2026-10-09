import type { DecodeOptions, Word } from "../engine";

export type ProviderChoice = "auto" | "webgpu" | "wasm";

export type ToWorker =
  | { type: "init"; provider: ProviderChoice }
  | { type: "transcribe"; jobId: number; file: File; options: DecodeOptions }
  | {
      type: "transcribe-pcm";
      jobId: number;
      pcm: Float32Array;
      sampleRate: number;
      options: DecodeOptions;
    }
  | { type: "cancel"; jobId: number }
  /** Live microphone: audio arrives in chunks until live-stop. */
  | { type: "live-start"; jobId: number; sampleRate: number; options: DecodeOptions }
  | { type: "live-audio"; jobId: number; pcm: Float32Array }
  | { type: "live-stop"; jobId: number }
  /** Punctuate and true-case plain words (one entry per transcript word). */
  | { type: "punctuate"; id: number; words: string[] };

export type ErrorCode = "decode-unsupported" | "no-audio" | "model" | "runtime";

export type FromWorker =
  | { type: "download"; loaded: number; total: number; fromCache: boolean }
  | { type: "compiling" }
  | {
      type: "ready";
      provider: "webgpu" | "wasm";
      gpu: string | null;
      fallbackReason: string | null;
    }
  | { type: "meta"; jobId: number; duration: number }
  | {
      type: "progress";
      jobId: number;
      decoded: number;
      committed: Word[];
      tentative: Word[];
      /** Peak amplitude per PEAK_STEP seconds, appended since the last message. */
      peaks: Float32Array;
      /** Aura bands (low, mid, high interleaved, BAND_RATE per second), appended. */
      bands: Float32Array;
      speed: number;
    }
  | {
      type: "done";
      jobId: number;
      committed: Word[];
      decoded: number;
      elapsed: number;
      bands: Float32Array;
      timing: { encoder: number; search: number; chunks: number };
    }
  | { type: "cancelled"; jobId: number }
  | { type: "punct-progress"; id: number; phase: "download" | "run"; done: number; total: number }
  | { type: "punctuated"; id: number; words: string[] }
  | { type: "punct-error"; id: number; message: string }
  | { type: "error"; jobId: number | null; code: ErrorCode; message: string };

export const PEAK_STEP = 0.1;
export { BAND_RATE } from "../render/aura";
