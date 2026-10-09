// Engine check against sherpa-onnx references, using onnxruntime-node.
//
//   npx tsx tests/engine.node.ts <dir with *.wav, *.<method>.json, t1.feats.f32>
//
// Test audio: t1.wav, t2.wav (16 kHz mono), optionally t3.wav and a 44.1 kHz
// stereo long.wav made of t1+t2. References come from sherpa-onnx with the
// original int8 model: python scripts/make_test_refs.py <dir>
// Exits non-zero on mismatch.

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import * as ort from "onnxruntime-node";
import { Engine, Resampler, type DecodingMethod, type ModelConfig } from "../src/engine";
import { OnlineFbank } from "../src/engine/fbank";

const dir = process.argv[2];
if (!dir) throw new Error("usage: tsx tests/engine.node.ts <ref-dir>");
const models = join(import.meta.dirname, "..", "public", "models", "seda-v0.1");

function readWav(path: string): { sampleRate: number; samples: Float32Array } {
  const b = readFileSync(path);
  let p = 12;
  let sampleRate = 0;
  let channels = 1;
  let bits = 16;
  while (p < b.length) {
    const id = b.toString("ascii", p, p + 4);
    const size = b.readUInt32LE(p + 4);
    if (id === "fmt ") {
      channels = b.readUInt16LE(p + 10);
      sampleRate = b.readUInt32LE(p + 12);
      bits = b.readUInt16LE(p + 22);
    } else if (id === "data") {
      if (bits !== 16) throw new Error("only 16-bit wav");
      const n = size / 2 / channels;
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        let s = 0;
        for (let c = 0; c < channels; c++) s += b.readInt16LE(p + 8 + (i * channels + c) * 2);
        out[i] = s / channels / 32768;
      }
      return { sampleRate, samples: out };
    }
    p += 8 + size + (size & 1);
  }
  throw new Error("no data chunk");
}

let failed = false;
const check = (ok: boolean, msg: string) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${msg}`);
  if (!ok) failed = true;
};

// 1. Features vs kaldi-native-fbank.
{
  const { samples } = readWav(join(dir, "t1.wav"));
  const ref = new Float32Array(readFileSync(join(dir, "t1.feats.f32")).buffer.slice(0));
  const fb = new OnlineFbank(80);
  // Feed in odd-sized pieces to exercise the streaming path.
  for (let i = 0; i < samples.length; i += 1234) fb.acceptWaveform(samples.subarray(i, i + 1234));
  fb.inputFinished();
  const got: number[] = [];
  fb.compute((f) => got.push(...f));
  let maxErr = 0;
  for (let i = 0; i < ref.length; i++) maxErr = Math.max(maxErr, Math.abs(ref[i] - got[i]));
  check(got.length === ref.length && maxErr < 1e-3, `fbank frames=${got.length / 80}/${ref.length / 80} maxErr=${maxErr.toExponential(2)}`);
}

// 2. Transcripts.
const cfg: ModelConfig = JSON.parse(readFileSync(join(models, "model.json"), "utf8"));
const bytes = (f: string) => new Uint8Array(readFileSync(join(models, f)));
const lodrBuf = readFileSync(join(models, "lodr.bin"));
const engine = await Engine.create(
  ort as unknown as Parameters<typeof Engine.create>[0],
  {
    config: cfg,
    encoder: bytes("encoder.webgpu.onnx"),
    decoder: bytes("decoder.onnx"),
    joiner: bytes("joiner.int8.onnx"),
    tokens: readFileSync(join(models, "tokens.txt"), "utf8"),
    lm: bytes("rnnlm.int8.onnx"),
    lodr: lodrBuf.buffer.slice(lodrBuf.byteOffset, lodrBuf.byteOffset + lodrBuf.byteLength),
  },
  "cpu",
  "cpu",
);

async function transcribe(samples: Float32Array, sampleRate: number, method: DecodingMethod) {
  const rec = engine.createRecognizer({ method, maxActivePaths: 4, lmScale: 0.6, lodrScale: -0.5 });
  const rs = new Resampler(sampleRate, 16000);
  const words = [];
  const step = Math.round(sampleRate * 0.37);
  for (let i = 0; i < samples.length; i += step) {
    const last = i + step >= samples.length;
    rec.acceptWaveform(rs.process(samples.subarray(i, i + step), last));
    while (rec.isReady()) await rec.decodeChunk();
    words.push(...rec.takeCommitted());
  }
  rec.inputFinished();
  while (rec.isReady()) await rec.decodeChunk();
  rec.flush();
  words.push(...rec.takeCommitted());
  return words;
}

for (const name of ["t1", "t2", "t3"]) {
  if (!existsSync(join(dir, `${name}.wav`))) continue;
  const { samples, sampleRate } = readWav(join(dir, `${name}.wav`));
  for (const method of ["greedy", "beam", "lm"] as const) {
    const refPath = join(dir, `${name}.${method}.json`);
    if (!existsSync(refPath)) continue;
    const ref = JSON.parse(readFileSync(refPath, "utf8"));
    const t0 = performance.now();
    const words = await transcribe(samples, sampleRate, method === "lm" ? "beam-lm" : method);
    const sec = (performance.now() - t0) / 1000;
    const text = words.map((w) => w.text).join(" ");
    const rtf = sec / (samples.length / sampleRate);
    check(text === ref.text.trim(), `${name} ${method} rtf=${rtf.toFixed(3)}\n      got: ${text}\n      ref: ${ref.text.trim()}`);
  }
}

// 3. Long input at 44.1 kHz stereo (resampler + endpoint resets).
if (existsSync(join(dir, "long.wav"))) {
  const { samples, sampleRate } = readWav(join(dir, "long.wav"));
  const words = await transcribe(samples, sampleRate, "beam-lm");
  const text = words.map((w) => w.text).join(" ");
  const ref = ["t1", "t2"].map((n) => JSON.parse(readFileSync(join(dir, `${n}.lm.json`), "utf8")).text.trim()).join(" ");
  check(text === ref, `long 44.1k beam-lm (${words.length} words)\n      got: ${text}`);
  const monotonic = words.every((w, i) => w.start <= w.end && (i === 0 || words[i - 1].start <= w.start));
  check(monotonic, `word timestamps monotonic, last word at ${words.at(-1)?.start.toFixed(2)}s`);
}

process.exit(failed ? 1 : 0);
