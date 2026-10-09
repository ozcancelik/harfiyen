import type { DecodeOptions, ModelConfig } from "./config";
import { LodrFst } from "./lodr";
import { createEncoder, Decoder, Joiner, RnnLm, type Encoder, type EncoderProvider, type Ort } from "./models";
import { Recognizer } from "./recognizer";
import { GreedySearch, ModifiedBeamSearch, type Search } from "./search";
import { SymbolTable } from "./tokens";

export type { DecodeOptions, DecodingMethod, ModelConfig } from "./config";
export type { EncoderProvider } from "./models";
export type { Word } from "./tokens";
export { Recognizer } from "./recognizer";
export { Resampler, downmix } from "./resampler";

export interface ModelFiles {
  config: ModelConfig;
  encoder: Uint8Array;
  decoder: Uint8Array;
  joiner: Uint8Array;
  tokens: string;
  lm?: Uint8Array;
  lodr?: ArrayBuffer;
}

/** Small models run on the CPU: per-frame calls are too tiny for the GPU. */
export type SmallProvider = "wasm" | "cpu";

/** Holds the loaded sessions; creates one Recognizer per transcription. */
export class Engine {
  private constructor(
    readonly config: ModelConfig,
    private encoder: Encoder,
    private decoder: Decoder,
    private joiner: Joiner,
    private syms: SymbolTable,
    private lm: RnnLm | null,
    private lodr: LodrFst | null,
    readonly provider: EncoderProvider,
  ) {}

  static async create(
    ort: Ort,
    files: ModelFiles,
    provider: EncoderProvider,
    small: SmallProvider = "wasm",
  ): Promise<Engine> {
    const cfg = files.config;
    const opts = { executionProviders: [small], graphOptimizationLevel: "all" as const, logSeverityLevel: 3 as const };
    // Sequential on purpose: onnxruntime-web initialises its wasm runtime on
    // the first session and rejects concurrent initialisation.
    const enc = await createEncoder(ort, files.encoder, provider, cfg);
    const dec = await ort.InferenceSession.create(files.decoder, opts);
    const join = await ort.InferenceSession.create(files.joiner, opts);
    const lm = files.lm ? await ort.InferenceSession.create(files.lm, opts) : null;
    return new Engine(
      cfg,
      enc,
      new Decoder(ort, dec, cfg.contextSize),
      new Joiner(ort, join, 512),
      new SymbolTable(files.tokens),
      lm ? new RnnLm(ort, lm, cfg.lm) : null,
      files.lodr ? new LodrFst(files.lodr) : null,
      provider,
    );
  }

  get hasLm() {
    return this.lm !== null;
  }

  /** One recognizer at a time: they share the encoder and its state buffers. */
  createRecognizer(opts: DecodeOptions): Recognizer {
    const cfg = this.config;
    let search: Search;
    if (opts.method === "greedy") {
      search = new GreedySearch(cfg, this.decoder, this.joiner);
    } else {
      const lm =
        opts.method === "beam-lm" && this.lm
          ? { lm: this.lm, lodr: this.lodr, scale: opts.lmScale, lodrScale: opts.lodrScale }
          : null;
      search = new ModifiedBeamSearch(cfg, this.decoder, this.joiner, opts.maxActivePaths, lm);
    }
    this.encoder.reset();
    return new Recognizer(cfg, this.encoder, search, this.syms);
  }
}
