/// <reference lib="webworker" />
// Writes captions into a video.
//
// Video files: mediabunny decodes and re-encodes (WebCodecs, hardware H.264
// or HEVC where available, at the bitrate chosen in the export menu), the compositor (WebGPU, else 2D canvas) draws every frame with its caption,
// and the audio track is copied over untouched. A slice that fills the frame (upright, for Reels, say) is cut
// out while decoding; a picture fitted into the frame is scaled down while decoding and placed by the compositor.
//
// Audio files and recordings: the picture is the audio-reactive aura (the
// same one the player shows), rendered at 1080p30; the audio is re-encoded
// to AAC (or Opus) for the MP4.
//
// With a dub, the sound in either case is the synthetic voice over the file's
// own audio, which is turned down to the chosen level (or out).
//
// With a trim only that part is written, its first moment at 0:00. Captions,
// the aura and the dub are looked up at the file's own time (output time plus
// the trim's start).
//
// With a jump cut the frames and sound inside the cuts are dropped and what
// follows is moved up to close the gap; the sound fades over a few
// milliseconds at each cut, so it does not click.
//
// The MP4 is written to disk as it is encoded (sink.ts): into the file the
// user picked, or onto the browser's private disk, so hours of video never
// sit in memory.

import {
  ALL_FORMATS,
  AudioSample,
  AudioSampleSink,
  AudioSampleSource,
  BlobSource,
  CanvasSource,
  Conversion,
  getFirstEncodableAudioCodec,
  Input,
  Mp4OutputFormat,
  Output,
  Quality,
  QUALITY_HIGH,
  VideoSample,
} from "mediabunny";
import { historyAt, levelsAt, paletteById, usesHistory } from "../render/aura";
import { addUserFont, loadCaptionFont, type UserFont } from "../captions/fonts";
import { CaptionRenderer } from "../captions/renderer";
import { shownPhoto, shownPicture, type CaptionSettings } from "../captions/style";
import type { Word } from "../engine";
import { isKept, keptLength, keptParts, toFile, toOutput, type Kept } from "../lib/cuts";
import { AUDIO_VIDEO, type Encoder, type OutputCodec } from "../lib/videoOutput";
import type { Placement } from "../lib/crop";
import { createCompositor } from "../render/compositor";
import { backdropFor, KineticRenderer } from "../render/kinetic";
import type { LogoLayer } from "../render/logoLayer";
import { DUB_RATE, dubAt, type DubMix } from "../tts/dub";
import { clearRenders, openSink, type Sink } from "./sink";

declare const self: DedicatedWorkerGlobalScope;

export type ToRender =
  | {
      type: "burn";
      jobId: number;
      file: File;
      words: Word[];
      settings: CaptionSettings;
      /** The caption font, when the user added it (the worker has no access to their fonts). */
      userFont: UserFont | null;
      bands: Float32Array;
      /** Speech loudness, for "Sesle vurgula". */
      loudness: Float32Array;
      /** Language of the words; decides how they are uppercased. */
      lang: string;
      /** The speakers' names to show over the captions; null not to. */
      speakers: string[] | null;
      dub: DubMix | null;
      /** The user's logo, a copy of the player's (transferred). */
      logo: LogoLayer | null;
      /** The user's photo, a copy of the player's (transferred); null when this project does not use it. */
      photo: ImageBitmap | null;
      encode: Encode;
      /** The file the user picked to save into; null renders to the private disk (or memory). */
      handle: FileSystemFileHandle | null;
    }
  | { type: "cancel"; jobId: number };

export type FromRender =
  | { type: "progress"; jobId: number; progress: number; fps: number }
  | {
      type: "done";
      jobId: number;
      /** The video to download; null when it was saved into the picked file (`saved`). */
      file: File | null;
      saved: string | null;
      size: number;
      elapsed: number;
    }
  | { type: "cancelled"; jobId: number }
  | { type: "error"; jobId: number; message: string };

/**
 * Video codec, bitrate, encoder and size. No bitrate (the file could not be read
 * beforehand) is mediabunny's high quality; no known encoder lets the browser pick.
 */
export interface Encode {
  codec: OutputCodec;
  bitrate: number | null;
  encoder: Encoder;
  /** Picture size of the output; null keeps the file's own, or the crop's (1080p for auras). */
  size: { width: number; height: number } | null;
  /** Part of the video picture to keep, in displayed pixels; null keeps all of it. Ignored for audio files. */
  crop: { left: number; top: number; width: number; height: number } | null;
  /** The whole picture fitted into a frame of another shape (`size` is the frame); null fills the frame. */
  fit: Placement | null;
  /** The part of the file to write, in seconds; null for all of it. */
  trim: { start: number; end: number } | null;
  /** Stretches taken out of it (jump cut), sorted, in file seconds; null for none. */
  cuts: { start: number; end: number }[] | null;
}

// The browser's own choice when the hardware encoder is not there: the processor's.
const acceleration = (encode: Encode) => (encode.encoder === "hardware" ? "prefer-hardware" : "no-preference");

const quality = (encode: Encode) => (encode.bitrate ? new Quality({ bitrate: encode.bitrate }) : QUALITY_HIGH);

const post = (m: FromRender) => self.postMessage(m);

const running = new Map<number, { cancel(): Promise<void> }>();
const sinks = new Map<number, Sink>();
const cancelled = new Set<number>();

/** Closes the output on disk and reports it. */
async function finish(jobId: number, sink: Sink, handle: FileSystemFileHandle | null, started: number) {
  const file = await sink.finish();
  const size = file?.size ?? (await handle!.getFile()).size;
  post({ type: "done", jobId, file, saved: file ? null : handle!.name, size, elapsed: (performance.now() - started) / 1000 });
}

/**
 * The sample with the dub mixed in, on every channel, and the file's own sound turned down to `dub.original`.
 * `t0` is where the output starts in the file: the sample is at output time, the dub at the file's.
 */
function mixDub(sample: AudioSample, dub: DubMix, t0: number): AudioSample {
  const n = sample.numberOfFrames;
  const channels = sample.numberOfChannels;
  const voice = dubAt(dub.clips, sample.timestamp + t0, n, sample.sampleRate);
  const out = new Float32Array(n * channels);
  for (let c = 0; c < channels; c++) {
    const plane = out.subarray(c * n, (c + 1) * n);
    if (dub.original > 0) sample.copyTo(plane, { planeIndex: c, format: "f32-planar" });
    for (let i = 0; i < n; i++) plane[i] = Math.max(-1, Math.min(1, plane[i] * dub.original + voice[i]));
  }
  return new AudioSample({
    data: out,
    format: "f32-planar",
    numberOfChannels: channels,
    sampleRate: sample.sampleRate,
    timestamp: sample.timestamp,
  });
}

/** How long the sound crossfades across a cut, seconds. */
const CUT_FADE = 0.015;

interface CutClock {
  frames: number;
  /** Faded-out audio frames right after the previous cut's start, mixed into the next kept segment's head. */
  tail?: Float32Array[];
}

/**
 * The kept parts of a sample, one after another from `clock.frames` (output
 * frames written so far), crossfaded at the cuts. `t0` is where the sample's
 * timestamps start in the file. The sample itself is not closed.
 */
function cutAudio(sample: AudioSample, t0: number, kept: Kept[], span: { start: number; end: number }, clock: CutClock): AudioSample[] {
  const rate = sample.sampleRate;
  const n = sample.numberOfFrames;
  const channels = sample.numberOfChannels;
  const from = sample.timestamp + t0;
  const to = from + n / rate;
  const fadeFrames = Math.max(1, Math.round(CUT_FADE * rate));
  const out: AudioSample[] = [];
  for (const k of kept) {
    if (k.end <= from) continue;
    if (k.start >= to) break;
    const a = Math.max(0, Math.round((k.start - from) * rate));
    const b = Math.min(n, Math.round((k.end - from) * rate));
    if (b <= a) continue;
    const len = b - a;
    const data = new Float32Array(len * channels);
    // Fades only where a cut is: the span's own ends are written as they are.
    const fadeIn = k.start > span.start + 1e-3;
    const fadeOut = k.end < span.end - 1e-3;
    const tailLen = fadeOut ? Math.min(fadeFrames, Math.max(0, n - b)) : 0;
    const nextTail: Float32Array[] | undefined = tailLen > 0 ? [] : undefined;

    for (let c = 0; c < channels; c++) {
      const plane = data.subarray(c * len, (c + 1) * len);
      sample.copyTo(plane, { planeIndex: c, format: "f32-planar", frameOffset: a, frameCount: len });
      if (fadeIn || fadeOut) {
        for (let i = 0; i < len; i++) {
          const t = from + (a + i) / rate;
          const gIn = fadeIn ? Math.min(1, Math.max(0, (t - k.start) / CUT_FADE)) : 1;
          // When we have post-cut tail frames to overlap into the next part, only micro-taper the last 3ms here.
          const outWindow = tailLen > 0 ? 0.003 : CUT_FADE;
          const gOut = fadeOut ? Math.min(1, Math.max(0, (k.end - t) / outWindow)) : 1;
          const g = Math.min(gIn, gOut);
          if (g < 1) plane[i] *= Math.sin(g * (Math.PI / 2));
        }
      }
      // Mix in the overlapping tail from the previous cut for a true crossfade.
      const prevTail = fadeIn && a === Math.max(0, Math.round((k.start - from) * rate)) ? clock.tail?.[c] : undefined;
      if (prevTail && Math.abs(from + a / rate - k.start) < 2 / rate) {
        const mixLen = Math.min(len, prevTail.length);
        for (let i = 0; i < mixLen; i++) {
          plane[i] = Math.max(-1, Math.min(1, plane[i] + prevTail[i]));
        }
      }
      if (nextTail && tailLen > 0) {
        const tPlane = new Float32Array(tailLen);
        sample.copyTo(tPlane, { planeIndex: c, format: "f32-planar", frameOffset: b, frameCount: tailLen });
        for (let i = 0; i < tailLen; i++) {
          const g = 1 - (i + 0.5) / tailLen;
          tPlane[i] *= Math.sin(g * (Math.PI / 2));
        }
        nextTail.push(tPlane);
      }
    }
    if (fadeIn && Math.abs(from + a / rate - k.start) < 2 / rate) clock.tail = undefined;
    if (nextTail) clock.tail = nextTail;
    out.push(
      new AudioSample({
        data,
        format: "f32-planar",
        numberOfChannels: channels,
        sampleRate: rate,
        timestamp: clock.frames / rate,
      }),
    );
    clock.frames += len;
  }
  return out;
}

/**
 * What is written over the picture: the kinetic stage when it is on (its font loaded), else the captions.
 * `picture` is the video's picture or the photo as drawn, null for the aura.
 */
async function textLayer(
  words: Word[],
  settings: CaptionSettings,
  width: number,
  height: number,
  loudness: Float32Array,
  lang: string,
  speakers: string[] | null,
  picture: "video" | "blur" | null,
) {
  const k = settings.kinetic?.on ? { ...settings.kinetic, backdrop: backdropFor(settings.kinetic, picture) } : null;
  if (!k) return { captions: new CaptionRenderer(words, settings, width, height, loudness, lang, speakers), kinetic: null };
  await loadCaptionFont(k.font, self.fonts);
  return { captions: null, kinetic: new KineticRenderer(words, k, width, height, loudness, lang, speakers) };
}

async function burn(
  jobId: number,
  file: File,
  words: Word[],
  settings: CaptionSettings,
  bands: Float32Array,
  loudness: Float32Array,
  lang: string,
  speakers: string[] | null,
  dub: DubMix | null,
  logo: LogoLayer | null,
  photo: ImageBitmap | null,
  encode: Encode,
  sink: Sink,
  handle: FileSystemFileHandle | null,
) {
  const started = performance.now();
  // The 2D canvas in a worker only sees fonts registered on the worker.
  await loadCaptionFont(settings.font, self.fonts);
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  const track = await input.getPrimaryVideoTrack();
  // A video used for its sound is drawn as an audio file is.
  if (!track || settings.picture === "hidden") return burnAudio(jobId, input, words, settings, bands, loudness, lang, speakers, dub, logo, photo, encode, sink, handle, started);
  if (!(await track.canDecode())) throw new Error(`Videonun kodlaması (${track.codec ?? "bilinmiyor"}) bu tarayıcıda çözülemiyor.`);

  // Rotation is baked into the frames (allowRotationMetadata: false below),
  // so the canvas uses the displayed size (or the crop's), or the chosen smaller one
  // (mediabunny rotates, crops and resizes the frames before process). Encoders want even dimensions.
  const { crop, fit } = encode;
  const width = encode.size?.width ?? crop?.width ?? track.displayWidth & ~1;
  const height = encode.size?.height ?? crop?.height ?? track.displayHeight & ~1;
  // A fitted picture is decoded at the size it takes up in the frame.
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  const pictureW = fit ? even(fit.dst.w * width) : width;
  const pictureH = fit ? even(fit.dst.h * height) : height;
  const canvas = new OffscreenCanvas(width, height);
  const compositor = await createCompositor(canvas);
  compositor.setPlacement(fit);
  compositor.setLogo(logo);
  const picture = shownPicture(settings, true);
  const { captions, kinetic } = await textLayer(words, settings, width, height, loudness, lang, speakers, picture);
  compositor.setBlur(picture === "blur");

  const output = new Output({ format: new Mp4OutputFormat({ fastStart: sink.fastStart }), target: sink.target });
  // Mono stays mono; anything wider is mixed down to stereo, so the dub is not spread over surround channels.
  const channels = Math.min(2, (await input.getPrimaryAudioTrack())?.numberOfChannels ?? 1);
  let frames = 0;
  // Samples reach process at output time; captions and the dub go by the file's.
  const t0 = encode.trim?.start ?? 0;
  // With a jump cut, what is kept of the trim (or the file), and the output's sound written so far.
  const span = { start: t0, end: encode.trim?.end ?? Infinity };
  const kept = encode.cuts?.length ? keptParts(span, encode.cuts) : null;
  const clock = { frames: 0 };
  const conversion = await Conversion.init({
    input,
    output,
    tracks: "primary",
    ...(encode.trim && { trim: encode.trim }),
    video: {
      codec: encode.codec,
      bitrate: quality(encode),
      forceTranscode: true,
      allowRotationMetadata: false,
      ...(crop && { crop }),
      hardwareAcceleration: acceleration(encode),
      width: pictureW,
      height: pictureH,
      fit: "fill",
      processedWidth: width,
      processedHeight: height,
      process: (sample) => {
        const at = sample.timestamp + t0;
        if (kept && !isKept(at, kept)) return null;
        const frame = sample.toVideoFrame();
        try {
          compositor.render(frame, kinetic ? kinetic.frame(at, levelsAt(bands, at)) : captions!.frame(at));
        } finally {
          frame.close();
        }
        frames++;
        // Moved up past the cuts before it.
        return kept ? new VideoSample(canvas, { timestamp: toOutput(at, kept), duration: sample.duration }) : canvas;
      },
    },
    // The file's audio, resampled to the dub's rate, with the dub mixed in; the cuts taken out.
    audio:
      dub || kept
        ? {
            ...(dub && { numberOfChannels: channels, sampleRate: DUB_RATE }),
            forceTranscode: true,
            process: (sample) => {
              const mixed = dub ? mixDub(sample, dub, t0) : sample;
              if (!kept) return mixed;
              const parts = cutAudio(mixed, t0, kept, span, clock);
              if (mixed !== sample) mixed.close();
              return parts;
            },
          }
        : undefined,
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
    await sink.discard();
    post({ type: "cancelled", jobId });
    return;
  }
  await finish(jobId, sink, handle, started);
}

async function burnAudio(
  jobId: number,
  input: Input,
  words: Word[],
  settings: CaptionSettings,
  bands: Float32Array,
  loudness: Float32Array,
  lang: string,
  speakers: string[] | null,
  dub: DubMix | null,
  logo: LogoLayer | null,
  photo: ImageBitmap | null,
  encode: Encode,
  sink: Sink,
  handle: FileSystemFileHandle | null,
  started: number,
) {
  const audio = await input.getPrimaryAudioTrack();
  if (!audio) throw new Error("Bu dosyada ses yok.");
  if (!(await audio.canDecode())) throw new Error(`Sesin kodlaması (${audio.codec ?? "bilinmiyor"}) bu tarayıcıda çözülemiyor.`);
  const codec = await getFirstEncodableAudioCodec(["aac", "opus"], {
    numberOfChannels: audio.numberOfChannels,
    sampleRate: audio.sampleRate,
  });
  if (!codec) throw new Error("Bu tarayıcı MP4 için ses kodlayamıyor (AAC veya Opus gerekli).");

  const { width, height } = encode.size ?? AUDIO_VIDEO;
  const { fps } = AUDIO_VIDEO;
  const canvas = new OffscreenCanvas(width, height);
  const compositor = await createCompositor(canvas);
  compositor.setLogo(logo);
  // The photo in place of the aura, when it is picked.
  const ground = shownPhoto(settings, !!photo);
  compositor.setBlur(ground === "blur");
  const { captions, kinetic } = await textLayer(words, settings, width, height, loudness, lang, speakers, ground);
  const palette = paletteById(settings.aura).colors;
  // The part written: t0..t1 of the file, written from 0:00, less the cuts.
  const t0 = encode.trim?.start ?? 0;
  const t1 = Math.min(encode.trim?.end ?? Infinity, await input.computeDuration());
  const span = { start: t0, end: t1 };
  const kept = keptParts(span, encode.cuts ?? []);
  const duration = keptLength(kept);

  const output = new Output({ format: new Mp4OutputFormat({ fastStart: sink.fastStart }), target: sink.target });
  const video = new CanvasSource(canvas, {
    codec: encode.codec,
    bitrate: quality(encode),
    keyFrameInterval: 2,
    hardwareAcceleration: acceleration(encode),
  });
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
      const at = toFile(time, kept);
      const levels = levelsAt(bands, at);
      compositor.render(
        ground && photo
          ? { kind: "photo", image: photo }
          : {
              kind: "aura",
              time: at,
              levels,
              palette,
              style: settings.auraStyle ?? "aura",
              history: usesHistory(settings.auraStyle) ? historyAt((s) => levelsAt(bands, s), at) : undefined,
            },
        kinetic ? kinetic.frame(at, levels) : (captions?.frame(at) ?? null),
      );
      await video.add(time, 1 / fps);
    }
    const sec = (performance.now() - started) / 1000;
    post({ type: "progress", jobId, progress: Math.min(1, frame / totalFrames), fps: frame / sec });
  };

  try {
    await output.start();
    // Interleave: draw the frames up to the end of each audio sample.
    const clock = { frames: 0 };
    for await (const sample of new AudioSampleSink(audio).samples(t0, t1)) {
      if (stop) {
        sample.close();
        break;
      }
      // At the file's time (the sink's), the dub mixed in; then cut to the kept parts at the sample
      // (the first may begin before the trim, the last end after it) and timed from 0:00.
      const mixed = dub ? mixDub(sample, dub, 0) : sample;
      const parts = cutAudio(mixed, 0, kept, span, clock);
      if (mixed !== sample) mixed.close();
      sample.close();
      for (const part of parts) {
        await sound.add(part);
        part.close();
      }
      if (parts.length) await renderUntil(clock.frames / parts[0].sampleRate);
    }
    if (!stop) await renderUntil(Infinity);
    if (stop) {
      await output.cancel();
      await sink.discard();
      post({ type: "cancelled", jobId });
      return;
    }
    await output.finalize();
  } finally {
    running.delete(jobId);
    compositor.destroy();
    input.dispose();
  }
  await finish(jobId, sink, handle, started);
}

self.onmessage = (ev: MessageEvent<ToRender>) => {
  const m = ev.data;
  if (m.type === "cancel") {
    cancelled.add(m.jobId);
    // Before the encoder stops, so the half-written file is thrown away rather than saved.
    sinks.get(m.jobId)?.cancel();
    void running.get(m.jobId)?.cancel();
    return;
  }
  const run = async () => {
    // The previous render's download link is gone once a new one starts.
    await clearRenders();
    const sink = await openSink(m.handle);
    sinks.set(m.jobId, sink);
    if (cancelled.has(m.jobId)) sink.cancel();
    if (m.userFont) addUserFont(m.userFont);
    try {
      await burn(
        m.jobId,
        m.file,
        m.words,
        m.settings,
        m.bands,
        m.loudness,
        m.lang,
        m.speakers,
        m.dub,
        m.logo,
        m.photo,
        m.encode,
        sink,
        m.handle,
      );
    } finally {
      m.logo?.image.close();
      m.photo?.close();
    }
  };
  run()
    .catch(async (e) => {
      await sinks.get(m.jobId)?.discard();
      if (cancelled.has(m.jobId)) post({ type: "cancelled", jobId: m.jobId });
      else post({ type: "error", jobId: m.jobId, message: e instanceof Error ? e.message : String(e) });
    })
    .finally(() => {
      cancelled.delete(m.jobId);
      sinks.delete(m.jobId);
    });
};
