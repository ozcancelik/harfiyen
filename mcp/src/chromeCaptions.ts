// Captioned video drawn by the web app's own render worker (src/chrome.ts), for the looks ffmpeg and libass cannot
// draw: the glass caption, the aura, kinetic typography. The framing, the dub and the jump cut are worked out here,
// as in captions.ts; the worker does the drawing, the sound mix and the encoding.

import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import type { Corner } from "../../src/captions/style";
import type { Word } from "../../src/engine";
import { cropFor, framing, RATIO, type Crop } from "../../src/lib/crop";
import { keptLength, keptParts, wordsOutside } from "../../src/lib/cuts";
import { labelWords } from "../../src/lib/speakers";
import { wordsIn } from "../../src/lib/trim";
import type { Encode } from "../../src/worker/render.worker";
import type { BurnJob } from "../render-host/host";
import { probe, type MediaInfo } from "./audio";
import { CROP_CENTER, dubFor, type RenderOptions } from "./captions";
import { renderInChrome, type ImageInput, type Inputs } from "./chrome";
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
  kinetic?: { style?: string; palette?: string; backdrop?: "stage" | "aura" };
  /** "video" keeps the picture, "blur" blurs and darkens it, "aura" replaces it with the aura. */
  picture?: "video" | "blur" | "aura";
  /** A TTF, OTF, WOFF or WOFF2 file to draw the captions with. */
  fontFile?: string;
  /** Corner logo image and its placement. */
  logo?: { file: string; corner: Corner; size: number; opacity: number };
  /** Background photo in place of the aura, and whether to blur and darken it. */
  photo?: { file: string; blur?: boolean };
}

const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
};

const VIDEO_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".m4v": "video/x-m4v",
  ".mkv": "video/x-matroska",
};

function readImage(file: string, maxBytes: number, tooBig: string, badExt: string): ImageInput {
  const type = IMAGE_TYPES[extname(file).toLowerCase()];
  if (!type) throw new Error(badExt);
  const bytes = readFileSync(file);
  if (bytes.length > maxBytes) throw new Error(tooBig);
  return { bytes, type };
}

function readPhotoOrVideo(file: string): ImageInput {
  const ext = extname(file).toLowerCase();
  const imgType = IMAGE_TYPES[ext];
  const vidType = VIDEO_TYPES[ext];
  const type = imgType ?? vidType;
  if (!type) throw new Error("Arka plan medyası fotoğraf (JPEG, PNG, WebP, SVG) ya da video (MP4, WebM, MOV) olmalı.");
  const bytes = readFileSync(file);
  if (vidType && bytes.length > 250 * 1024 * 1024) throw new Error("Video çok büyük (250 MB üstü).");
  if (imgType && bytes.length > 25 * 1024 * 1024) throw new Error("Fotoğraf çok büyük (25 MB üstü).");
  return { bytes, type };
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
    const center = o.cropPosition ? CROP_CENTER[o.cropPosition] : { cx: 0.5, cy: 0.5 };
    crop = { ...cropFor(o.aspect, info.width, info.height, center.cx, center.cy), fit: o.fit, backdrop: o.backdrop ?? "blur" };
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
  const hasManualCuts = t.words.some((w) => w.cut === true || w.cutGap === true);
  const cuts = o.jumpCut ? await planCuts(t, o.jumpCut, keep) : hasManualCuts ? await planCuts(t, { on: false }, keep) : [];
  const parts = keptParts(span, cuts);
  if (!parts.length) throw new Error("Kesimlerden sonra videoda bir şey kalmıyor.");

  // A sound file, or a video used for its sound, is drawn as an audio project is: on the aura, the photo or the kinetic stage.
  const wantNoPicture =
    c.picture === "aura" ||
    !!c.photo ||
    (c.picture === undefined && (!!c.kinetic?.backdrop || !!c.patch.aura || !!c.patch.auraStyle));
  const noPicture =
    !info.hasVideo ||
    wantNoPicture ||
    (c.picture === undefined && (c.settings as { picture?: string } | undefined)?.picture === "hidden");
  const patch: Record<string, unknown> = {
    ...c.patch,
    ...(noPicture ? { picture: "hidden" } : c.picture && { picture: c.picture }),
    ...(c.photo ? { photo: true, ...(c.photo.blur !== undefined && { photoBlur: c.photo.blur }) } : { photo: false }),
    ...(o.hidden !== undefined && { hidden: o.hidden }),
    ...(o.emphasis && { voiceEmphasis: true }),
  };
  const projectKinetic = !c.preset && !o.hidden && (c.settings as { kinetic?: { on?: boolean } } | undefined)?.kinetic?.on === true;
  const kineticOn = !!c.kinetic || projectKinetic;
  // On the aura or a photo, the kinetic stage must not draw its own dark ground over it unless "stage" was asked for.
  const wantAuraBackdrop = !c.kinetic?.backdrop && (c.picture === "aura" || !!c.photo || !!c.patch.aura || !!c.patch.auraStyle);
  const kinetic =
    c.kinetic || (projectKinetic && wantAuraBackdrop ? {} : undefined);
  const jobKinetic = kinetic ? { ...kinetic, ...(wantAuraBackdrop && { backdrop: "aura" as const }) } : undefined;
  // The aura and the kinetic stage move with the voice; "Sesle vurgula" needs the loudness (not with captions timed to a voice).
  const loud = !o.hidden && !!(patch.voiceEmphasis ?? (c.settings as { voiceEmphasis?: boolean } | undefined)?.voiceEmphasis) && !heard.followed;
  if (heard.followed && o.emphasis) notes.push("Sesle vurgula seslendirmeye hizalı altyazıda kullanılmadı: kelimelerin zamanı sesten gelmiyor.");
  const wantBands = kineticOn || (noPicture && !c.photo);

  const inputs: Inputs = { source: t.source };
  if (c.logo) {
    inputs.logo = readImage(
      c.logo.file,
      10 * 1024 * 1024,
      "Logo dosyası çok büyük (10 MB üstü).",
      "Logo resmi PNG, SVG, WebP ya da JPEG olmalı.",
    );
  }
  if (c.photo) {
    inputs.photo = readPhotoOrVideo(c.photo.file);
  }
  if (wantBands || loud) {
    const wave = await waveformOf(t.source, span.end, (s) => progress(s * 0.15, "ses okunuyor"));
    inputs.bands = wave.bands;
    inputs.loudness = wave.loudness;
  }
  // 44-byte WAV header, then 16-bit mono PCM at 48 kHz.
  if (dub) inputs.dub = readFileSync(dubWavPath(t.id)).subarray(44);
  if (c.fontFile) inputs.font = readFileSync(c.fontFile);

  const frame = frameFor(o, info, noPicture);
  const hevc = o.codec === "hevc";
  const names = o.speakerNames === false ? null : (t.speakers?.names ?? null);
  // Only the trimmed part's words (less cut fillers), so no caption line reaches outside it.
  const shownWords = wordsOutside(wordsIn(words, t.range ?? null), cuts);
  const job = (encoder: Encode["encoder"]): BurnJob => ({
    words: shownWords,
    settings: c.settings as BurnJob["settings"],
    preset: c.preset as BurnJob["preset"],
    patch: patch as BurnJob["patch"],
    font: c.fontFile ? { name: basename(c.fontFile) } : undefined,
    logo: c.logo ? { corner: c.logo.corner, size: c.logo.size, opacity: c.logo.opacity } : undefined,
    photo: !!c.photo,
    kinetic: jobKinetic as BurnJob["kinetic"],
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
  if (result.fontMissing) notes.push(`Yazı tipinde şu Türkçe harfler yok: ${result.fontMissing}; bunlar yedek yazı tipiyle çizildi.`);
  const size = frame.out;
  return { output: o.output, seconds: keptLength(parts), cuts: cuts.length, size: `${size.width}x${size.height}`, dubbed: !!dub, notes, gpu: result.gpu };
}
