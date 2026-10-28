// Captioned video drawn by the web app's own render worker (src/chrome.ts), for the looks ffmpeg and libass cannot
// draw: the glass caption, the aura, kinetic typography. The framing, the dub and the jump cut are worked out here,
// as in captions.ts; the worker does the drawing, the sound mix and the encoding.

import { readFileSync } from "node:fs";
import type { Word } from "../../src/engine";
import { cropFor, framing, RATIO, type Crop } from "../../src/lib/crop";
import { keptLength, keptParts } from "../../src/lib/cuts";
import { labelWords } from "../../src/lib/speakers";
import type { Encode } from "../../src/worker/render.worker";
import type { BurnJob } from "../render-host/host";
import { probe, type MediaInfo } from "./audio";
import { dubFor, type RenderOptions } from "./captions";
import { renderInChrome, type Inputs } from "./chrome";
import { dubWavPath } from "./dub";
import { planCuts, waveformOf, type Progress } from "./pipeline";
import type { Transcript } from "./transcript";

/** The looks only the app's renderer draws, and the settings to start from. All of it is the app's own vocabulary. */
export interface ChromeStyle {
  /** The project's caption settings as the app saved them. */
  settings?: Record<string, unknown>;
  /** One of the app's presets (klasik, karaoke, dolgu, akis, odak, vurgu, pop, tek, netles, sade, cam). */
  preset?: string;
  /** Settings asked for by hand, in the app's field names. */
  patch: Record<string, unknown>;
  /** Kinetic typography in place of the captions; missing keeps the captions (or the project's kinetic). */
  kinetic?: { style?: string; palette?: string };
  /** "aura": the aura in place of the video's picture. */
  picture?: "video" | "aura";
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/** The frame, the slice and the fitted picture for the worker, the way the app's export builds them (src/lib/crop.ts). */
function frameFor(o: RenderOptions, info: MediaInfo, noPicture: boolean): Pick<Encode, "size" | "crop" | "fit"> & { out: { width: number; height: number } } {
  const scaled = (size: { width: number; height: number }) =>
    o.width ? { width: even(o.width), height: even((o.width * size.height) / size.width) } : size;
  if (noPicture) {
    // No picture to cut: the aura (or the kinetic stage) is drawn on a frame of the shape, 1080 on its short side.
    const ratio = o.aspect ? RATIO[o.aspect] : 16 / 9;
    const size = scaled(ratio >= 1 ? { width: even(1080 * ratio), height: 1080 } : { width: 1080, height: even(1080 / ratio) });
    return { size: o.aspect || o.width ? size : null, crop: null, fit: null, out: size };
  }
  const own = { width: even(info.width), height: even(info.height) };
  let crop: Crop | null = null;
  if (o.cropBox && o.fit === "fill") {
    crop = { aspect: o.aspect ?? "free", ...o.cropBox, fit: "fill", backdrop: "blur" };
  } else if (o.aspect) {
    crop = { ...cropFor(o.aspect, info.width, info.height), fit: o.fit, backdrop: o.backdrop ?? "blur" };
  }
  if (!crop) return { size: o.width ? scaled(own) : null, crop: null, fit: null, out: scaled(own) };
  const frame = framing(crop, info.width, info.height);
  const size = scaled(frame.size);
  if (frame.none && !o.width) return { size: null, crop: null, fit: null, out: own };
  return { size, crop: frame.crop, fit: frame.crop ? null : frame.placement, out: size };
}

/** Bitrate for the encoder from the tool's crf: 0.1 bits a pixel at crf 20, double for every 6 below. */
function bitrateFor(out: { width: number; height: number }, crf: number, hevc: boolean) {
  const bpp = 0.1 * 2 ** ((20 - crf) / 6) * (hevc ? 0.7 : 1);
  return Math.round(Math.min(80e6, Math.max(500e3, out.width * out.height * 30 * bpp)));
}

export async function renderChrome(
  t: Transcript,
  o: RenderOptions,
  c: ChromeStyle,
  progress: Progress,
): Promise<{ output: string; seconds: number; cuts: number; size: string; dubbed: boolean; notes: string[]; gpu: string }> {
  if (!t.source) throw new Error("Video için transkriptin bir ses ya da video dosyası olmalı.");
  const info = await probe(t.source);
  if (!info.hasAudio) throw new Error("Bu dosyada ses kanalı yok.");
  const span = t.range ?? { start: 0, end: t.duration };
  let words: Word[] = t.words;
  if (o.language === "translation") {
    if (!t.translation) throw new Error("Bu transkriptin çevirisi yok; önce translate çalıştırılmalı.");
    words = t.translation.words;
  }
  words = labelWords(words, t.speakers);

  const notes: string[] = [];
  const heard = dubFor(t, o, words, notes);
  const dub = heard.dub;
  words = heard.words;

  progress(0, "kesimler aranıyor");
  // What the dub says is not cut out, as in the app.
  const keep = dub ? dub.clips.map((x) => ({ start: x.start, end: x.start + x.seconds })) : [];
  const cuts = o.jumpCut ? await planCuts(t, o.jumpCut, keep) : [];
  const parts = keptParts(span, cuts);
  if (!parts.length) throw new Error("Kesimlerden sonra videoda bir şey kalmıyor.");

  // A sound file, or a video used for its sound, is drawn as an audio project is: on the aura (or the kinetic stage).
  const noPicture = !info.hasVideo || c.picture === "aura" || (c.settings as { picture?: string } | undefined)?.picture === "hidden";
  const patch: Record<string, unknown> = { ...c.patch, ...(noPicture && { picture: "hidden" }), ...(o.emphasis && { voiceEmphasis: true }) };
  const kineticOn = !!c.kinetic || (c.settings as { kinetic?: { on?: boolean } } | undefined)?.kinetic?.on === true;
  // The aura and the kinetic stage move with the voice; "Sesle vurgula" needs the loudness (not with captions timed to a voice).
  const loud = !!(patch.voiceEmphasis ?? (c.settings as { voiceEmphasis?: boolean } | undefined)?.voiceEmphasis) && !heard.followed;
  if (heard.followed && o.emphasis) notes.push("Sesle vurgula seslendirmeye hizalı altyazıda kullanılmadı: kelimelerin zamanı sesten gelmiyor.");
  const wantBands = noPicture || kineticOn;

  const inputs: Inputs = { source: t.source };
  if (wantBands || loud) {
    const wave = await waveformOf(t.source, t.duration, (s) => progress(s * 0.15, "ses okunuyor"));
    inputs.bands = wave.bands;
    inputs.loudness = wave.loudness;
  }
  // 44-byte WAV header, then 16-bit mono PCM at 48 kHz.
  if (dub) inputs.dub = readFileSync(dubWavPath(t.id)).subarray(44);

  const frame = frameFor(o, info, noPicture);
  const hevc = o.codec === "hevc";
  const names = o.speakerNames === false ? null : (t.speakers?.names ?? null);
  const job = (encoder: Encode["encoder"]): BurnJob => ({
    name: "source.mp4",
    words,
    settings: c.settings as BurnJob["settings"],
    preset: c.preset as BurnJob["preset"],
    patch: patch as BurnJob["patch"],
    kinetic: c.kinetic as BurnJob["kinetic"],
    lang: o.language === "translation" ? (t.lang === "tr" ? "en" : "tr") : t.lang,
    speakers: names,
    dub: dub ? { original: Math.min(0.5, Math.max(0, o.original ?? 0)) } : undefined,
    bands: wantBands,
    loudness: loud,
    encode: {
      codec: hevc ? "hevc" : "avc",
      bitrate: bitrateFor(frame.out, o.crf, hevc),
      encoder,
      size: frame.size,
      crop: frame.crop,
      fit: frame.fit,
      trim: t.range ? { start: span.start, end: span.end } : null,
      cuts: cuts.length ? cuts : null,
    },
  });

  const writing = (s: number, m?: string) => progress(0.15 + 0.85 * s, m);
  let result;
  try {
    result = await renderInChrome(job("hardware"), inputs, o.output, writing);
  } catch (e) {
    // No hardware encoder for this size or codec: the browser's own choice, which may be the processor's.
    if (!/encod|codec|hardware/i.test(e instanceof Error ? e.message : String(e))) throw e;
    notes.push("Donanım kodlayıcı kullanılamadı; tarayıcının kendi seçimiyle yazıldı (daha yavaş olabilir).");
    result = await renderInChrome(job(null), inputs, o.output, writing);
  }
  progress(1);
  const size = frame.out;
  return { output: o.output, seconds: keptLength(parts), cuts: cuts.length, size: `${size.width}x${size.height}`, dubbed: !!dub, notes, gpu: result.gpu };
}
