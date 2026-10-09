/// <reference lib="webworker" />
// Writes captions into a video.
//
// Video files: mediabunny decodes and re-encodes (WebCodecs, hardware H.264
// where available), the WebGPU compositor draws every frame with its caption,
// and the audio track is copied over untouched.
//
// Audio files and recordings: the picture is the audio-reactive aura (the
// same one the player shows), rendered at 1080p30; the audio is re-encoded
// to AAC (or Opus) for the MP4.

import {
  ALL_FORMATS,
  AudioSampleSink,
  AudioSampleSource,
  BlobSource,
  BufferTarget,
  CanvasSource,
  Conversion,
  getFirstEncodableAudioCodec,
  Input,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
} from "mediabunny";
import { levelsAt, paletteById } from "../render/aura";
import { loadCaptionFont } from "../captions/fonts";
import { CaptionRenderer } from "../captions/renderer";
import type { CaptionSettings } from "../captions/style";
import type { Word } from "../engine";
import { createCompositor } from "../render/compositor";

declare const self: DedicatedWorkerGlobalScope;

export type ToRender =
  | { type: "burn"; jobId: number; file: File; words: Word[]; settings: CaptionSettings; bands: Float32Array }
  | { type: "cancel"; jobId: number };

export type FromRender =
  | { type: "progress"; jobId: number; progress: number; fps: number }
  | { type: "done"; jobId: number; blob: Blob; elapsed: number }
  | { type: "cancelled"; jobId: number }
  | { type: "error"; jobId: number; message: string };

const post = (m: FromRender) => self.postMessage(m);

const running = new Map<number, { cancel(): Promise<void> }>();
const cancelled = new Set<number>();

async function burn(jobId: number, file: File, words: Word[], settings: CaptionSettings, bands: Float32Array) {
  const started = performance.now();
  // The 2D canvas in a worker only sees fonts registered on the worker.
  await loadCaptionFont(settings.font, self.fonts);
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  const track = await input.getPrimaryVideoTrack();
  if (!track) return burnAudio(jobId, input, words, settings, bands, started);
  if (!(await track.canDecode())) throw new Error(`Video kodeki (${track.codec ?? "bilinmiyor"}) bu tarayıcıda çözülemiyor.`);

  // Rotation is baked into the frames (allowRotationMetadata: false below),
  // so the canvas uses the displayed size. Encoders want even dimensions.
  const width = track.displayWidth & ~1;
  const height = track.displayHeight & ~1;
  const canvas = new OffscreenCanvas(width, height);
  const compositor = await createCompositor(canvas, false);
  const captions = new CaptionRenderer(words, settings, width, height);

  const target = new BufferTarget();
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: "in-memory" }), target });
  let frames = 0;
  const conversion = await Conversion.init({
    input,
    output,
    tracks: "primary",
    video: {
      codec: "avc",
      bitrate: QUALITY_HIGH,
      forceTranscode: true,
      allowRotationMetadata: false,
      hardwareAcceleration: "prefer-hardware",
      width,
      height,
      fit: "fill",
      processedWidth: width,
      processedHeight: height,
      process: (sample) => {
        const frame = sample.toVideoFrame();
        try {
          compositor.render(frame, captions.frame(sample.timestamp));
        } finally {
          frame.close();
        }
        frames++;
        return canvas;
      },
    },
  });
  if (!conversion.isValid) {
    const why = conversion.discardedTracks.map((d) => d.reason).join(", ");
    compositor.destroy();
    throw new Error(`Bu video dönüştürülemiyor (${why}).`);
  }
  conversion.onProgress = (progress) => {
    const sec = (performance.now() - started) / 1000;
    post({ type: "progress", jobId, progress, fps: frames / sec });
  };
  running.set(jobId, conversion);
  if (cancelled.has(jobId)) await conversion.cancel();
  try {
    await conversion.execute();
  } finally {
    running.delete(jobId);
    compositor.destroy();
    input.dispose();
  }
  if (conversion.state === "canceled") {
    post({ type: "cancelled", jobId });
    return;
  }
  const blob = new Blob([target.buffer!], { type: "video/mp4" });
  post({ type: "done", jobId, blob, elapsed: (performance.now() - started) / 1000 });
}

const AUDIO_VIDEO = { width: 1920, height: 1080, fps: 30 };

async function burnAudio(
  jobId: number,
  input: Input,
  words: Word[],
  settings: CaptionSettings,
  bands: Float32Array,
  started: number,
) {
  const audio = await input.getPrimaryAudioTrack();
  if (!audio) throw new Error("Bu dosyada ses yok.");
  if (!(await audio.canDecode())) throw new Error(`Ses kodeki (${audio.codec ?? "bilinmiyor"}) bu tarayıcıda çözülemiyor.`);
  const codec = await getFirstEncodableAudioCodec(["aac", "opus"], {
    numberOfChannels: audio.numberOfChannels,
    sampleRate: audio.sampleRate,
  });
  if (!codec) throw new Error("Bu tarayıcı MP4 için ses kodlayamıyor (AAC veya Opus gerekli).");

  const { width, height, fps } = AUDIO_VIDEO;
  const canvas = new OffscreenCanvas(width, height);
  const compositor = await createCompositor(canvas, false);
  const captions = new CaptionRenderer(words, settings, width, height);
  const palette = paletteById(settings.aura).colors;
  const duration = await input.computeDuration();

  const target = new BufferTarget();
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: "in-memory" }), target });
  const video = new CanvasSource(canvas, { codec: "avc", bitrate: QUALITY_HIGH, keyFrameInterval: 2 });
  const sound = new AudioSampleSource({ codec, bitrate: QUALITY_HIGH });
  output.addVideoTrack(video, { frameRate: fps });
  output.addAudioTrack(sound);
  let stop = false;
  running.set(jobId, {
    cancel: async () => {
      stop = true;
    },
  });

  let frame = 0;
  const totalFrames = Math.ceil(duration * fps);
  const renderUntil = async (t: number) => {
    for (; frame < totalFrames && frame / fps < t && !stop; frame++) {
      const time = frame / fps;
      compositor.render(
        { kind: "aura", time, levels: levelsAt(bands, time), palette },
        captions.frame(time),
      );
      await video.add(time, 1 / fps);
    }
    const sec = (performance.now() - started) / 1000;
    post({ type: "progress", jobId, progress: Math.min(1, frame / totalFrames), fps: frame / sec });
  };

  try {
    await output.start();
    // Interleave: draw the frames up to the end of each audio sample.
    for await (const sample of new AudioSampleSink(audio).samples()) {
      const end = sample.timestamp + sample.duration;
      if (!stop) await sound.add(sample);
      sample.close();
      if (stop) break;
      await renderUntil(end);
    }
    if (!stop) await renderUntil(Infinity);
    if (stop) {
      await output.cancel();
      post({ type: "cancelled", jobId });
      return;
    }
    await output.finalize();
  } finally {
    running.delete(jobId);
    compositor.destroy();
    input.dispose();
  }
  const blob = new Blob([target.buffer!], { type: "video/mp4" });
  post({ type: "done", jobId, blob, elapsed: (performance.now() - started) / 1000 });
}

self.onmessage = (ev: MessageEvent<ToRender>) => {
  const m = ev.data;
  if (m.type === "cancel") {
    cancelled.add(m.jobId);
    void running.get(m.jobId)?.cancel();
    return;
  }
  burn(m.jobId, m.file, m.words, m.settings, m.bands)
    .catch((e) => {
      if (cancelled.has(m.jobId)) post({ type: "cancelled", jobId: m.jobId });
      else post({ type: "error", jobId: m.jobId, message: e instanceof Error ? e.message : String(e) });
    })
    .finally(() => cancelled.delete(m.jobId));
};
