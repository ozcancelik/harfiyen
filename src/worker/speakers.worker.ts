/// <reference lib="webworker" />
// Who speaks when (src/diarize), on the CPU: the audio is read and turned into fbank frames
// as it is decoded, then each window of speech gets a voice print.

import { ALL_FORMATS, AudioSampleSink, BlobSource, Input } from "mediabunny";
import * as ort from "onnxruntime-web/webgpu";
import ortWasmUrl from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url";
import ortMjsUrl from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url";
import { diarize, Features, SpeakerEmbedder } from "../diarize";
import type { Word } from "../engine";
import type { Ort } from "../engine/models";
import { packFileUrl, SPEAKER_PACK } from "../models";
import { fetchAll, fetchManifest } from "./modelStore";
import { pcmChunks } from "./pcm";

declare const self: DedicatedWorkerGlobalScope;

/**
 * `file` or, for a file the worker cannot decode, its whole audio as `pcm` (16 kHz mono).
 * The audio of start..end is read; word times are the file's.
 */
export type ToSpeakers =
  | {
      type: "diarize";
      jobId: number;
      file?: File;
      pcm?: Float32Array;
      start: number;
      end: number;
      words: Word[];
      speakers?: number;
    }
  | { type: "cancel"; jobId: number };

export type FromSpeakers =
  | { type: "download"; jobId: number; loaded: number; total: number }
  | { type: "progress"; jobId: number; phase: "read" | "compare"; done: number }
  /** A speaker per word, 0, 1, ... in the order they first speak. */
  | { type: "done"; jobId: number; labels: number[]; elapsed: number }
  | { type: "cancelled"; jobId: number }
  | { type: "error"; jobId: number; message: string; undecodable?: boolean };

/** Approximate; the real size is settled once the download finishes. */
const ORT_WASM_SIZE = 26_800_000;

const post = (m: FromSpeakers) => self.postMessage(m);
const cancelled = new Set<number>();
let embedder: Promise<SpeakerEmbedder> | null = null;
let queue: Promise<void> = Promise.resolve();

class Undecodable extends Error {}

async function load(jobId: number): Promise<SpeakerEmbedder> {
  const { data: cfg } = await fetchManifest<{ files: Record<string, number> }>(
    packFileUrl(SPEAKER_PACK, SPEAKER_PACK.manifest),
  );
  if (!cfg) throw new Error("Konuşmacı modeli bulunamadı. Önce `npm run models` çalıştırılmalı.");
  const [model, wasm] = await fetchAll(
    [
      ...SPEAKER_PACK.files.map((f) => ({ url: packFileUrl(SPEAKER_PACK, f), size: cfg.files[f] })),
      { url: ortWasmUrl, size: ORT_WASM_SIZE, approx: true },
    ],
    (loaded, total) => post({ type: "download", jobId, loaded, total }),
  );
  ort.env.wasm.wasmBinary = wasm.buffer as ArrayBuffer;
  // See asr.worker.ts: wasm threads load this script, not the worker bundle.
  if (import.meta.env.PROD) ort.env.wasm.wasmPaths = { mjs: new URL(ortMjsUrl, self.location.href) };
  ort.env.wasm.numThreads = self.crossOriginIsolated
    ? Math.max(1, Math.min(4, Math.ceil((navigator.hardwareConcurrency || 2) / 2)))
    : 1;
  ort.env.logLevel = "error";
  return SpeakerEmbedder.create(ort as unknown as Ort, model);
}

function getEmbedder(jobId: number) {
  if (!embedder) {
    embedder = load(jobId);
    embedder.catch(() => (embedder = null));
  }
  return embedder;
}

/** Fbank frames of start..end of the file. */
async function readFile(jobId: number, file: File, start: number, end: number): Promise<Features | null> {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    let track;
    try {
      track = await input.getPrimaryAudioTrack();
    } catch {
      throw new Undecodable();
    }
    if (!track) throw new Error("Bu dosyada ses kanalı yok.");
    if (!(await track.canDecode())) throw new Undecodable();
    const audio = new Features();
    let read = 0;
    let shown = 0;
    for await (const pcm of pcmChunks(new AudioSampleSink(track), track.sampleRate, start, end)) {
      if (cancelled.has(jobId)) return null;
      audio.push(pcm);
      read += pcm.length / 16000;
      if (read - shown > 5) {
        shown = read;
        post({ type: "progress", jobId, phase: "read", done: Math.min(1, read / (end - start)) });
      }
    }
    return audio.finish();
  } finally {
    input.dispose();
  }
}

async function run(m: Extract<ToSpeakers, { type: "diarize" }>) {
  const started = performance.now();
  const model = getEmbedder(m.jobId);
  let audio: Features | null;
  if (m.pcm) {
    audio = new Features();
    audio.push(m.pcm.subarray(Math.round(m.start * 16000), Math.round(m.end * 16000)));
    audio.finish();
  } else {
    post({ type: "progress", jobId: m.jobId, phase: "read", done: 0 });
    audio = await readFile(m.jobId, m.file!, m.start, m.end);
  }
  if (!audio) return post({ type: "cancelled", jobId: m.jobId });
  const labels = await diarize(await model, audio, m.start, m.words, {
    speakers: m.speakers,
    onProgress: (done) => post({ type: "progress", jobId: m.jobId, phase: "compare", done }),
    isCancelled: () => cancelled.has(m.jobId),
  });
  if (!labels) return post({ type: "cancelled", jobId: m.jobId });
  post({ type: "done", jobId: m.jobId, labels, elapsed: (performance.now() - started) / 1000 });
}

self.onmessage = (ev: MessageEvent<ToSpeakers>) => {
  const m = ev.data;
  if (m.type === "cancel") {
    cancelled.add(m.jobId);
    return;
  }
  // One job at a time: a new one waits for the cancelled one to stop.
  queue = queue.then(() =>
    run(m)
      .catch((e) =>
        post({
          type: "error",
          jobId: m.jobId,
          message: e instanceof Error ? e.message : String(e),
          ...(e instanceof Undecodable && { undecodable: true }),
        }),
      )
      .finally(() => cancelled.delete(m.jobId)),
  );
};
