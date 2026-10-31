/// <reference lib="webworker" />
// Translation: the transcript's sentences, one at a time, on the CPU: Turkish to English with opus-mt-tc-big-tr-en,
// English to Turkish with opus-mt-tc-big-en-tr.

import * as ort from "onnxruntime-web/webgpu";
import ortWasmUrl from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url";
import ortMjsUrl from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url";
import type { Ort } from "../engine/models";
import { MT_PACKS, packFileUrl, type MtPair } from "../models";
import { Translator, type MtConfig, type MtVocab } from "../mt/translator";
import { fetchAll, fetchManifest } from "./modelStore";

declare const self: DedicatedWorkerGlobalScope;

export type ToMt =
  | { type: "translate"; jobId: number; pair: MtPair; sentences: string[] }
  | { type: "cancel"; jobId: number };

export type FromMt =
  | { type: "download"; jobId: number; loaded: number; total: number }
  | { type: "progress"; jobId: number; done: number; total: number }
  | { type: "done"; jobId: number; texts: string[]; elapsed: number }
  | { type: "cancelled"; jobId: number }
  | { type: "error"; jobId: number; message: string };

/** Approximate; the real size is settled once the download finishes. */
const ORT_WASM_SIZE = 26_800_000;

const post = (m: FromMt) => self.postMessage(m);
const cancelled = new Set<number>();
const translators = new Map<MtPair, Promise<Translator>>();
/** The runtime is set up once, with the first model. */
let runtime = false;
let queue: Promise<void> = Promise.resolve();

async function load(jobId: number, pair: MtPair): Promise<Translator> {
  const MT_PACK = MT_PACKS[pair];
  const { data: cfg } = await fetchManifest<MtConfig>(packFileUrl(MT_PACK, MT_PACK.manifest));
  if (!cfg) throw new Error("Çeviri modeli bulunamadı. Önce `npm run models` çalıştırılmalı.");
  const [encoder, decoder, spm, wasm] = await fetchAll(
    [
      ...MT_PACK.files.map((f) => ({ url: packFileUrl(MT_PACK, f), size: cfg.files[f] })),
      ...(runtime ? [] : [{ url: ortWasmUrl, size: ORT_WASM_SIZE, approx: true }]),
    ],
    (loaded, total) => post({ type: "download", jobId, loaded, total }),
  );
  if (!runtime) setUpRuntime(wasm);
  const vocab: MtVocab = JSON.parse(new TextDecoder().decode(spm));
  return Translator.create(ort as unknown as Ort, encoder, decoder, vocab, cfg);
}

function setUpRuntime(wasm: Uint8Array) {
  runtime = true;
  ort.env.wasm.wasmBinary = wasm.buffer as ArrayBuffer;
  // See asr.worker.ts: wasm threads load this script, not the worker bundle.
  if (import.meta.env.PROD) ort.env.wasm.wasmPaths = { mjs: new URL(ortMjsUrl, self.location.href) };
  ort.env.wasm.numThreads = self.crossOriginIsolated
    ? Math.max(1, Math.min(4, Math.ceil((navigator.hardwareConcurrency || 2) / 2)))
    : 1;
  ort.env.logLevel = "error";
}

/** Each direction loaded on first use and kept. */
function getTranslator(jobId: number, pair: MtPair) {
  let t = translators.get(pair);
  if (!t) {
    t = load(jobId, pair);
    translators.set(pair, t);
    t.catch(() => translators.delete(pair));
  }
  return t;
}

async function translate(jobId: number, pair: MtPair, sentences: string[]) {
  const started = performance.now();
  const mt = await getTranslator(jobId, pair);
  const texts: string[] = [];
  for (let i = 0; i < sentences.length; i++) {
    if (cancelled.has(jobId)) return post({ type: "cancelled", jobId });
    post({ type: "progress", jobId, done: i, total: sentences.length });
    texts.push(await mt.translate(sentences[i]));
  }
  post({ type: "done", jobId, texts, elapsed: (performance.now() - started) / 1000 });
}

self.onmessage = (ev: MessageEvent<ToMt>) => {
  const m = ev.data;
  if (m.type === "cancel") {
    cancelled.add(m.jobId);
    return;
  }
  // One job at a time: a new one waits for the cancelled one to stop.
  queue = queue.then(() =>
    translate(m.jobId, m.pair, m.sentences)
      .catch((e) => post({ type: "error", jobId: m.jobId, message: e instanceof Error ? e.message : String(e) }))
      .finally(() => cancelled.delete(m.jobId)),
  );
};
