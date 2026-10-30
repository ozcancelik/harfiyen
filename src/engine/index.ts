import { FINAL_BEAM, VAD_ENDPOINT, type DecodeOptions, type ModelConfig } from "./config";
import { LodrFst } from "./lodr";
import { createEncoder, Decoder, Joiner, RnnLm, type Encoder, type EncoderProvider, type Ort } from "./models";
import { Recognizer } from "./recognizer";
import { GreedySearch, ModifiedBeamSearch, type Search } from "./search";
import { SymbolTable } from "./tokens";
import { SileroVad } from "./vad";

export type { DecodeOptions, DecodingMethod, ModelConfig, SpeechLang } from "./config";
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
  /** The final export's encoder (config.final), used for files. */
  final?: Uint8Array;
  /** Silero VAD: segments end at pauses instead of by sherpa-onnx's rules. */
  vad?: Uint8Array;
}

/** One export of the encoder, with the config it runs with. */
interface Pass {
  config: ModelConfig;
  encoder: Encoder;
}

/** Small models run on the CPU: per-frame calls are too tiny for the GPU. */
export type SmallProvider = "wasm" | "cpu";

/** Holds the loaded sessions; creates one Recognizer per transcription. */
export class Engine {
  private constructor(
    private streaming: Pass,
    private final: Pass | null,
    private decoder: Decoder,
    private joiner: Joiner,
    private syms: SymbolTable,
    private lm: RnnLm | null,
    private lodr: LodrFst | null,
    private vad: SileroVad | null,
    readonly provider: EncoderProvider,
  ) {}

  get config() {
    return this.streaming.config;
  }

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
    let final: Pass | null = null;
    if (files.final && cfg.final) {
      const config = { ...cfg, ...cfg.final };
      final = { config, encoder: await createEncoder(ort, files.final, provider, config) };
    }
    const dec = await ort.InferenceSession.create(files.decoder, opts);
    const join = await ort.InferenceSession.create(files.joiner, opts);
    const lm = files.lm ? await ort.InferenceSession.create(files.lm, opts) : null;
    const vad = files.vad ? await SileroVad.create(ort, files.vad, small) : null;
    return new Engine(
      { config: cfg, encoder: enc },
      final,
      new Decoder(ort, dec, cfg.contextSize),
      new Joiner(ort, join, 512),
      new SymbolTable(files.tokens),
      lm && cfg.lm ? new RnnLm(ort, lm, cfg.lm) : null,
      files.lodr ? new LodrFst(files.lodr) : null,
      vad,
      provider,
    );
  }

  get hasLm() {
    return this.lm !== null;
  }

  /**
   * One recognizer at a time: they share the encoders, their state buffers
   * and the VAD. `live` needs text while the speaker talks: the streaming
   * export; otherwise the final export, if there is one.
   */
  createRecognizer(opts: DecodeOptions, live = false): Recognizer {
    const pass = (!live && this.final) || this.streaming;
    const cfg = pass.config;
    const isFinal = pass === this.final;
    let search: Search;
    if (opts.method === "greedy") {
      search = new GreedySearch(cfg, this.decoder, this.joiner);
    } else {
      const lm =
        opts.method === "beam-lm" && this.lm
          ? { lm: this.lm, lodr: this.lodr, scale: opts.lmScale, lodrScale: opts.lodrScale }
          : null;
      const beam = isFinal ? Math.max(FINAL_BEAM, opts.maxActivePaths) : opts.maxActivePaths;
      search = new ModifiedBeamSearch(cfg, this.decoder, this.joiner, beam, lm);
    }
    pass.encoder.reset();
    const maxSegment = VAD_ENDPOINT.maxSegment[isFinal ? "final" : "streaming"];
    return new Recognizer(cfg, pass.encoder, search, this.syms, this.vad, maxSegment);
  }
}
