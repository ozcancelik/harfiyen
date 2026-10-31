// The models, loaded from disk on first use and kept. onnxruntime-node runs them on the CPU.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as ortNode from "onnxruntime-node";
import { SpeakerEmbedder } from "../../src/diarize";
import { DuyuEngine, type DuyuConfig } from "../../src/duyu";
import { Engine, type ModelConfig } from "../../src/engine";
import type { Ort } from "../../src/engine/models";
import type { SpeechEngine } from "../../src/engine/stream";
import { readBytes, readJson, requireUnit, type ModelId, type MtPair } from "./models";
import { Formatter, type FormatterConfig } from "../../src/punct/formatter";
import type { WordPieceVocab } from "../../src/punct/wordpiece";
import { Translator, type MtConfig, type MtVocab } from "../../src/mt/translator";
import { WhisperEngine, type WhisperConfig } from "../../src/whisper";

const ort = ortNode as unknown as Ort;

/** Each model is created once, even when two jobs ask at the same time. */
function once<K, T>(make: (key: K) => Promise<T>) {
  const cache = new Map<K, Promise<T>>();
  return (key: K) => {
    let p = cache.get(key);
    if (!p) {
      p = make(key);
      cache.set(key, p);
      p.catch(() => cache.delete(key));
    }
    return p;
  };
}

async function loadSpeech(id: ModelId): Promise<SpeechEngine> {
  const dir = requireUnit(id);
  const file = (n: string) => join(dir, n);
  if (id === "seda") {
    const lodr = readFileSync(file("lodr.bin"));
    return Engine.create(
      ort,
      {
        config: readJson<ModelConfig>(file("model.json")),
        encoder: readBytes(file("encoder.webgpu.onnx")),
        decoder: readBytes(file("decoder.onnx")),
        joiner: readBytes(file("joiner.int8.onnx")),
        tokens: readFileSync(file("tokens.txt"), "utf8"),
        lm: readBytes(file("rnnlm.int8.onnx")),
        lodr: lodr.buffer.slice(lodr.byteOffset, lodr.byteOffset + lodr.byteLength) as ArrayBuffer,
        final: readBytes(file("encoder.final.webgpu.onnx")),
        vad: readBytes(file("silero_vad.onnx")),
      },
      "cpu",
      "cpu",
    );
  }
  // Mihu is Seda's engine without the language model and the final encoder.
  if (id === "mihu") {
    return Engine.create(
      ort,
      {
        config: readJson<ModelConfig>(file("model.json")),
        encoder: readBytes(file("encoder.webgpu.onnx")),
        decoder: readBytes(file("decoder.int8.onnx")),
        joiner: readBytes(file("joiner.int8.onnx")),
        tokens: readFileSync(file("tokens.txt"), "utf8"),
        vad: readBytes(file("silero_vad.onnx")),
      },
      "cpu",
      "cpu",
    );
  }
  if (id === "duyu") {
    return DuyuEngine.create(
      ort,
      {
        config: readJson<DuyuConfig>(file("model.json")),
        pre: readBytes(file("encoder_pre.onnx")),
        pass: readBytes(file("encoder_pass.onnx")),
        post: readBytes(file("encoder_post.onnx")),
        decoder: readBytes(file("decoder.onnx")),
        fbank: readBytes(file("fbank.bin")),
        pieces: readJson<string[]>(file("tokens.json")),
      },
      "cpu",
    );
  }
  return WhisperEngine.create(
    ort,
    {
      config: readJson<WhisperConfig>(file("model.json")),
      encoder: readBytes(file(id === "whisper-turbo" ? "encoder_model_fp16.onnx" : "encoder_model_q4f16.onnx")),
      decoder: readBytes(file("decoder_model_merged_q4f16.onnx")),
      vocab: readJson<Record<string, number>>(file("vocab.json")),
      vad: readBytes(file("silero_vad.onnx")),
    },
    "cpu",
    "cpu",
  );
}

export const speechEngine = once(loadSpeech);

export const formatter = once(async (_: "punct") => {
  const dir = requireUnit("punct");
  return Formatter.create(
    ort,
    readBytes(join(dir, "formatter.int8.onnx")),
    readJson<WordPieceVocab>(join(dir, "vocab.json")),
    readJson<FormatterConfig>(join(dir, "model.json")),
    "cpu",
  );
});

export const translator = once(async (pair: MtPair) => {
  const dir = requireUnit(`translate-${pair}`);
  return Translator.create(
    ort,
    readBytes(join(dir, "encoder.int8.onnx")),
    readBytes(join(dir, "decoder.int8.onnx")),
    readJson<MtVocab>(join(dir, "spm.json")),
    readJson<MtConfig>(join(dir, "model.json")),
    "cpu",
  );
});

export const speakerEmbedder = once(async (_: "speakers") => {
  const dir = requireUnit("speakers");
  return SpeakerEmbedder.create(ort, readBytes(join(dir, "campplus.onnx")), "cpu");
});
