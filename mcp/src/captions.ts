// Captioned video with ffmpeg and libass. The web app draws its eleven styles on the GPU; here nine of them, without the glass and the
// kinetic ones, are written as an ASS file and burned in, optionally with the jump cut and a crop to a social aspect ratio.

import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Word } from "../../src/engine";
import { buildCues, SUBTITLE_RULES } from "../../src/lib/cues";
import { keptLength, keptParts, wordsThrough, type Kept } from "../../src/lib/cuts";
import { loudWords } from "../../src/captions/emphasis";
import { labelWords } from "../../src/lib/speakers";
import { ffmpeg, probe } from "./audio";
import { dubKey, dubWavPath, loadDub, timeToDub, type DubMeta } from "./dub";
import { prepareFontsDir, resolveFont } from "./fonts";
import { loudnessOf, planCuts, type Progress } from "./pipeline";
import type { Transcript } from "./transcript";
import type { JumpCut } from "../../src/lib/cuts";

export type CaptionStyle = "klasik" | "sade" | "karaoke" | "akis" | "odak" | "vurgu" | "pop" | "netles" | "tek-kelime";
export type Aspect = "9:16" | "4:5" | "1:1" | "16:9";
export type Position = "alt" | "orta" | "ust";
export type CropPosition = "orta" | "sol" | "sag" | "ust" | "alt";

export const CROP_CENTER: Record<CropPosition, { cx: number; cy: number }> = {
  orta: { cx: 0.5, cy: 0.5 },
  sol: { cx: 0, cy: 0.5 },
  sag: { cx: 1, cy: 0.5 },
  ust: { cx: 0.5, cy: 0 },
  alt: { cx: 0.5, cy: 1 },
};

export interface CaptionOptions {
  style: CaptionStyle;
  font: string;
  /** Bold cut; false for single-weight display fonts (Anton, Bangers...), which libass would smear. */
  bold?: boolean;
  /** Turkish capitals (i → İ); missing: on for fonts that only have capitals. */
  uppercase?: boolean;
  /**
   * Text size as a share of the frame height, times the style's own scale (the big styles are bigger). With
   * `sizeBasis: "short"` it is the web app's size: a share of the shorter side, final as it is.
   */
  size: number;
  sizeBasis?: "short";
  /** Missing: the style's own (the one-word styles in the middle, the rest at the bottom). */
  position?: Position;
  /** What the text stands on; missing: a box for klasik, an outline for the rest. */
  background?: "box" | "outline" | "shadow";
  /** "#RRGGBB" */
  color: string;
  accent: string;
}

export const DEFAULT_CAPTIONS: CaptionOptions = {
  style: "sade",
  font: "Montserrat",
  size: 0.045,
  color: "#FFFFFF",
  accent: "#FFD400",
};

/** "#RRGGBB" as ASS's &HAABBGGRR (alpha 00 is opaque). */
const assColor = (hex: string, alpha = 0) => {
  const h = hex.replace("#", "").padEnd(6, "0");
  const a = alpha.toString(16).padStart(2, "0").toUpperCase();
  return `&H${a}${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}`.toUpperCase();
};

const clock = (t: number) => {
  const cs = Math.max(0, Math.round(t * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`;
};

const escape = (s: string, upper = false) => {
  const t = s.replace(/[{}\\]/g, "").replace(/\n/g, " ");
  return upper ? t.toLocaleUpperCase("tr-TR") : t;
};

/** Where a long line breaks into two balanced ones: the index of the first word of the second line, or -1. */
function breakAt(words: string[], max = 42): number {
  const text = words.join(" ");
  if (text.length <= max || words.length < 2) return -1;
  let best = 1;
  let bestGap = Infinity;
  let at = 0;
  for (let i = 0; i < words.length - 1; i++) {
    at += words[i].length + 1;
    const gap = Math.abs(at - text.length / 2);
    if (gap < bestGap) [best, bestGap] = [i + 1, gap];
  }
  return best;
}

/** A word that "Sesle vurgula" picked (set before the jump cut moves its time). */
export type CaptionWord = Word & { loud?: true };

/** Styles that show one word at a time and the size they are drawn at, against the plain styles' 1. */
const SCALE: Partial<Record<CaptionStyle, number>> = { "tek-kelime": 2, netles: 2, pop: 1.7 };
/** Words per screen for the styles that group them; the rest show a whole caption line. */
const GROUP: Partial<Record<CaptionStyle, number>> = { "tek-kelime": 1, netles: 1, pop: 3 };
const CENTERED = new Set<CaptionStyle>(["tek-kelime", "netles", "pop"]);
/** Styles drawn as one event per word, each showing the line so far. */
const PER_WORD = new Set<CaptionStyle>(["akis", "odak", "vurgu", "pop", "netles", "tek-kelime"]);

/** The ASS file for words at output time on a w x h frame. */
export function toAss(words: CaptionWord[], speakers: string[] | undefined, w: number, h: number, o: CaptionOptions): string {
  const px = o.sizeBasis === "short" ? Math.round(Math.min(w, h) * o.size) : Math.round(h * o.size * (SCALE[o.style] ?? 1));
  const align = { alt: 2, orta: 5, ust: 8 }[o.position ?? (CENTERED.has(o.style) ? "orta" : "alt")];
  const margin = Math.round(h * 0.07);
  const background = o.background ?? (o.style === "klasik" ? "box" : "outline");
  const box = background === "box";
  // Karaoke fills from the secondary to the primary colour.
  const primary = o.style === "karaoke" ? assColor(o.accent) : assColor(o.color);
  const secondary = o.style === "karaoke" ? assColor(o.color) : assColor(o.accent);
  // A shadow without an outline is a soft dark halo; an outline is solid.
  const outline = box ? assColor("#000000", 0x66) : background === "shadow" ? assColor("#000000", 0x99) : assColor("#000000");
  const border = box ? Math.round(px * 0.35) : background === "shadow" ? Math.max(2, Math.round(px * 0.05)) : Math.max(2, Math.round(px * 0.08));
  const shadow = box ? 0 : background === "shadow" ? Math.max(2, Math.round(px * 0.07)) : Math.max(1, Math.round(px * 0.04));
  const black = assColor("#000000");
  const base = assColor(o.color);
  // How many characters fit a line: a bold letter is about 0.6 of the text height wide, and the margins take 12%.
  const perLine = Math.max(12, Math.floor((w * 0.88) / (px * 0.6)));
  const lead = (i: number, cues: ReturnType<typeof buildCues>) => {
    const s = cues[i].words[0]?.speaker;
    return speakers && s !== undefined && (i === 0 || cues[i - 1].words[0]?.speaker !== s) ? `${speakers[s]}: ` : "";
  };

  const events: string[] = [];
  const event = (start: number, end: number, text: string) =>
    events.push(`Dialogue: 0,${clock(start)},${clock(end)},Default,,0,0,0,,${text}`);

  /** A louder word is bigger and, where the style allows, in the accent colour. */
  const loudOn = (x: CaptionWord) =>
    x.loud ? `{\\fscx120\\fscy120${o.style === "karaoke" || o.style === "vurgu" ? "" : `\\1c${assColor(o.accent)}`}}` : "";
  const loudOff = (x: CaptionWord) =>
    x.loud ? `{\\fscx100\\fscy100${o.style === "karaoke" || o.style === "vurgu" ? "" : `\\1c${primary}`}}` : "";

  // What a word does when it is the one being said, in a line of `kind`.
  const entrance = (kind: CaptionStyle): string => {
    switch (kind) {
      case "akis":
        return "{\\alpha&HFF&\\t(0,140,\\alpha&H00&)}";
      case "odak":
      case "netles":
        return "{\\blur14\\alpha&HFF&\\t(0,170,\\blur0\\alpha&H00&)}";
      case "pop":
        return "{\\fscx55\\fscy55\\t(0,90,\\fscx122\\fscy122)\\t(90,190,\\fscx100\\fscy100)}";
      default:
        return "";
    }
  };

  /** The caption `c` as it looks while word `k` is being said (styles with one event per word). */
  const frame = (c: { words: CaptionWord[] }, k: number, lines: boolean): string => {
    const texts = c.words.map((x) => escape(x.text, o.uppercase));
    const brk = lines ? breakAt(texts, perLine) : -1;
    return c.words
      .map((x, j) => {
        let pre = "";
        let post = "";
        if (o.style === "akis" || o.style === "odak" || o.style === "pop") {
          if (j > k) pre = "{\\alpha&HFF&}";
          else if (j === k) pre = entrance(o.style);
        } else if (o.style === "netles") {
          pre = entrance("netles");
        } else if (o.style === "vurgu" && j === k) {
          pre = `{\\1c${assColor("#111111")}\\3c${assColor(o.accent)}\\bord${Math.max(3, Math.round(px * 0.2))}}`;
          post = `{\\1c${base}\\3c${black}\\bord${border}}`;
        }
        const sep = j === 0 ? "" : j === brk ? "\\N" : " ";
        return `${sep}${pre}${loudOn(x)}${texts[j]}${loudOff(x)}${post}`;
      })
      .join("");
  };

  const cues = buildCues(words, { ...SUBTITLE_RULES, maxChars: perLine * 2 }) as { start: number; end: number; first: number; words: CaptionWord[] }[];
  if (PER_WORD.has(o.style)) {
    const size = GROUP[o.style];
    cues.forEach((c, i) => {
      // Styles that group words show 1-3 at a time; the others show the whole caption line.
      const groups = size ? Array.from({ length: Math.ceil(c.words.length / size) }, (_, g) => c.words.slice(g * size, (g + 1) * size)) : [c.words];
      groups.forEach((g, gi) => {
        const groupEnd = size ? Math.min(g[g.length - 1].end + 0.15, groups[gi + 1]?.[0].start ?? c.end + 0.15) : c.end;
        const name = size ? "" : lead(i, cues);
        g.forEach((x, k) => {
          const end = g[k + 1]?.start ?? groupEnd;
          // tek-kelime has no entrance: it only shows the word.
          event(x.start, end, name + (o.style === "tek-kelime" ? `${loudOn(x)}${escape(x.text, o.uppercase)}` : frame({ words: g }, k, !size)));
        });
      });
    });
  } else {
    cues.forEach((c, i) => {
      const texts = c.words.map((x) => escape(x.text, o.uppercase));
      let text: string;
      if (o.style === "karaoke") {
        // \kf in centiseconds per word; the gap before a word belongs to the word before it.
        text = c.words
          .map((x, k) => {
            const until = c.words[k + 1]?.start ?? x.end;
            return `{\\kf${Math.max(1, Math.round((until - x.start) * 100))}}${loudOn(x)}${texts[k]}${loudOff(x)}`;
          })
          .join(" ");
      } else {
        const brk = breakAt(texts, perLine);
        text = c.words.map((x, j) => `${j === 0 ? "" : j === brk ? "\\N" : " "}${loudOn(x)}${texts[j]}${loudOff(x)}`).join("");
      }
      event(c.start, c.end, lead(i, cues) + text);
    });
  }
  return `[Script Info]
ScriptType: v4.00+
PlayResX: ${w}
PlayResY: ${h}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${o.font},${px},${primary},${secondary},${outline},${assColor("#000000", 0x80)},${o.bold ? -1 : 0},0,0,0,100,100,0,0,${box ? 3 : 1},${border},${shadow},${align},${Math.round(w * 0.06)},${Math.round(w * 0.06)},${margin},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${events.join("\n")}
`;
}

export interface RenderOptions {
  output: string;
  captions: CaptionOptions;
  /** Crop or fit to this ratio; missing keeps the file's. */
  aspect?: Aspect;
  /** "fill" crops the picture to the ratio, "fit" keeps all of it with bars. */
  fit: "fill" | "fit";
  /** What shows around a fitted picture. */
  backdrop?: "black" | "blur";
  /** The slice of the picture to keep, as fractions of it (fill); missing crops the middle. */
  cropBox?: { x: number; y: number; w: number; h: number };
  /** Where to place the crop slice when filling an aspect ratio (default: orta). */
  cropPosition?: CropPosition;
  /** Names of the speakers above their lines; false leaves them out. */
  speakerNames?: boolean;
  /** Leave captions out of the video (a dub-only or jump-cut video). */
  hidden?: boolean;
  /** Takes quiet stretches out of the video. */
  jumpCut?: Partial<JumpCut>;
  /** "Sesle vurgula": words said louder than their surroundings are drawn bigger. */
  emphasis: boolean;
  /** A TTF/OTF to draw with instead of `captions.font`; its own family name is used. */
  fontFile?: string;
  /** The transcript's words, or its translation. */
  language: "transcript" | "translation";
  /** The transcript's dub (the dub tool): false leaves it out; missing mixes it in when there is one. */
  dub?: boolean;
  /** How loud the file's own sound stays under the dub, 0 to 0.5. */
  original?: number;
  /** Captions in the dub's language take their times from the voice, as in the app; false keeps the words' own. */
  followDub?: boolean;
  codec: "h264" | "hevc";
  /** Constant rate factor: lower is better. */
  crf: number;
  /** Output width in pixels; missing keeps the source's (or the crop's). */
  width?: number;
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

interface Geometry {
  /** The frame the captions are drawn on. */
  size: { w: number; h: number };
  /** The slice of the picture kept, in pixels; missing: the middle, or all of it. */
  crop?: { x: number; y: number; w: number; h: number };
}

/** Output frame and crop from the source's size and the options. */
function geometry(srcW: number, srcH: number, o: RenderOptions): Geometry {
  if (o.cropBox && o.fit === "fill") {
    const x = Math.min(Math.max(0, Math.round(o.cropBox.x * srcW)), srcW - 2);
    const y = Math.min(Math.max(0, Math.round(o.cropBox.y * srcH)), srcH - 2);
    // Even sizes, inside the picture.
    const w = Math.max(2, Math.min(srcW - x, Math.floor((o.cropBox.w * srcW) / 2) * 2));
    const h = Math.max(2, Math.min(srcH - y, Math.floor((o.cropBox.h * srcH) / 2) * 2));
    return { size: { w, h }, crop: { x, y, w, h } };
  }
  if (!o.aspect) return { size: { w: even(srcW), h: even(srcH) } };
  const [a, b] = o.aspect.split(":").map(Number);
  const r = a / b;
  // Fill crops to the ratio, fit adds bars around the whole picture.
  const crop = (srcW / srcH > r) === (o.fit === "fill");
  const size = crop ? { w: even(srcH * r), h: even(srcH) } : { w: even(srcW), h: even(srcW / r) };
  if (o.fit === "fill" && o.cropPosition && o.cropPosition !== "orta") {
    const { cx, cy } = CROP_CENTER[o.cropPosition];
    const x = Math.min(Math.max(0, Math.round(cx * srcW - size.w / 2)), Math.max(0, srcW - size.w));
    const y = Math.min(Math.max(0, Math.round(cy * srcH - size.h / 2)), Math.max(0, srcH - size.h));
    return { size, crop: { x, y, w: size.w, h: size.h } };
  }
  return { size };
}

/** Filter graph pieces: the kept parts joined, then the picture shaped, then captions. */
/** `mix`: the dub is input `index`; the file's own sound stays at `original` (0 to 1) under it. */
function graph(parts: Kept[], hasVideo: boolean, g: Geometry, out: { w: number; h: number }, o: RenderOptions, ass: string, fonts: string, mix?: { index: number; original: number }) {
  const { size } = g;
  const pieces: string[] = [];
  const joined: string[] = [];
  parts.forEach((p, i) => {
    const t = `start=${p.start.toFixed(3)}:end=${p.end.toFixed(3)}`;
    if (hasVideo) {
      pieces.push(`[0:v]trim=${t},setpts=PTS-STARTPTS[v${i}]`);
      joined.push(`[v${i}]`);
    }
    const len = Math.max(0, p.end - p.start);
    const fadeIn = i > 0 && len > 0.03 ? ",afade=t=in:st=0:d=0.012" : "";
    const fadeOut = i < parts.length - 1 && len > 0.03 ? `,afade=t=out:st=${Math.max(0, len - 0.012).toFixed(3)}:d=0.012` : "";
    pieces.push(`[0:a]atrim=${t},asetpts=PTS-STARTPTS${fadeIn}${fadeOut}[a${i}]`);
    joined.push(`[a${i}]`);
    if (mix) pieces.push(`[${mix.index}:a]atrim=${t},asetpts=PTS-STARTPTS[d${i}]`);
  });
  pieces.push(`${joined.join("")}concat=n=${parts.length}:v=${hasVideo ? 1 : 0}:a=1${hasVideo ? "[vc]" : ""}[ac]`);
  if (mix) {
    pieces.push(`${parts.map((_, i) => `[d${i}]`).join("")}concat=n=${parts.length}:v=0:a=1[dc]`);
    // At 0 the file's sound is gone; above it, it stays under the voice.
    if (mix.original > 0) pieces.push(`[ac]volume=${mix.original.toFixed(3)}[ao]`, `[ao][dc]amix=inputs=2:duration=longest:normalize=0[am]`);
    else pieces.push(`[ac]anullsink`, `[dc]anull[am]`);
  }
  let from = hasVideo ? "[vc]" : "[1:v]";
  const shape: string[] = [];
  if (hasVideo && g.crop) {
    shape.push(`crop=${g.crop.w}:${g.crop.h}:${g.crop.x}:${g.crop.y}`);
  } else if (hasVideo && o.aspect) {
    if (o.fit === "fill") shape.push(`crop=${size.w}:${size.h}`);
    else if (o.backdrop === "blur") {
      // The picture itself, enlarged to cover the frame and blurred, with the whole picture over it.
      const radius = Math.max(4, Math.round(Math.min(size.w, size.h) / 30));
      pieces.push(
        `${from}split=2[bg][fg]`,
        `[bg]scale=${size.w}:${size.h}:force_original_aspect_ratio=increase,crop=${size.w}:${size.h},boxblur=${radius}:3[bb]`,
        `[fg]scale=${size.w}:${size.h}:force_original_aspect_ratio=decrease[ff]`,
        `[bb][ff]overlay=(W-w)/2:(H-h)/2[fit]`,
      );
      from = "[fit]";
    } else {
      shape.push(`scale=${size.w}:${size.h}:force_original_aspect_ratio=decrease`, `pad=${size.w}:${size.h}:(ow-iw)/2:(oh-ih)/2:black`);
    }
  }
  if (out.w !== size.w) shape.push(`scale=${out.w}:${out.h}`);
  if (!o.hidden) {
    const quote = (p: string) => p.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");
    shape.push(`ass='${quote(ass)}':fontsdir='${quote(fonts)}'`);
  }
  pieces.push(`${from}${shape.length ? shape.join(",") : "null"}[v]`);
  return pieces.join(";");
}

/**
 * The transcript's dub as the video uses it: mixed in (`dub: false` leaves it out), and the words in its language
 * given the voice's times so captions follow it. A dub made before the words changed is mixed in but not followed.
 */
export function dubFor(
  t: Transcript,
  o: Pick<RenderOptions, "language" | "dub" | "followDub">,
  words: Word[],
  notes: string[],
): { dub: DubMeta | null; words: Word[]; followed: boolean } {
  const dub = o.dub === false || !existsSync(dubWavPath(t.id)) ? null : loadDub(t.id);
  if (!dub) return { dub, words, followed: false };
  const read = dub.language === "translation" ? t.translation?.words : t.words;
  const span = t.range ?? { start: 0, end: t.duration };
  const inSpan = t.range ? read?.filter((w) => w.end > t.range!.start && w.start < t.range!.end) : read;
  const rangeOk = span.start >= (dub.start ?? 0) - 0.05 && span.end <= dub.end + 0.05;
  if (!read || !rangeOk || (dubKey(read) !== dub.key && (!inSpan || dubKey(inSpan) !== dub.key))) {
    notes.push("Seslendirme eski: metin, çeviri ya da seçili bölüm sonradan değişti. Altyazı seslendirmenin zamanını izlemedi; dub yeniden çalıştırılmalı.");
    return { dub, words, followed: false };
  }
  if (o.followDub !== false && dub.language === o.language) return { dub, words: timeToDub(words, dub.lines, dub.clips), followed: true };
  return { dub, words, followed: false };
}

export async function renderCaptions(
  t: Transcript,
  o: RenderOptions,
  progress: Progress,
): Promise<{ output: string; seconds: number; cuts: number; size: string; dubbed: boolean; notes: string[] }> {
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

  // The dub: mixed in, and the captions in its language follow its voice.
  const notes: string[] = [];
  const heard = dubFor(t, o, words, notes);
  const dub = heard.dub;
  const followed = heard.followed;
  words = heard.words;
  if (followed && o.emphasis) notes.push("Sesle vurgula seslendirmeye hizalı altyazıda kullanılmadı: kelimelerin zamanı sesten gelmiyor.");

  progress(0, "kesimler aranıyor");
  // What the dub says is not cut out, as in the app.
  const keep = dub ? dub.clips.map((c) => ({ start: c.start, end: c.start + c.seconds })) : [];
  const hasManualCuts = t.words.some((w) => w.cut === true || w.cutGap === true);
  const cuts = o.jumpCut ? await planCuts(t, o.jumpCut, keep) : hasManualCuts ? await planCuts(t, { on: false }, keep) : [];
  const parts = keptParts(span, cuts);
  if (!parts.length) throw new Error("Kesimlerden sonra videoda bir şey kalmıyor.");
  const length = keptLength(parts);

  const src = info.hasVideo ? { w: info.width, h: info.height } : { w: 1920, h: 1080 };
  const g = geometry(src.w, src.h, o);
  const size = g.size;
  // The exact ratio, not the crop's rounded one: 720 wide at 9:16 is 1280 high, not 1278.
  const ratio = o.aspect ? o.aspect.split(":").map(Number) : [size.w, size.h];
  const out = o.width ? { w: even(o.width), h: even((o.width * ratio[1]) / ratio[0]) } : size;
  const dir = mkdtempSync(join(tmpdir(), "harfiyen-"));
  const part = `${o.output}.part`;
  let ok = false;
  try {
    const ass = join(dir, "captions.ass");
    const fonts = join(dir, "fonts");
    if (!o.hidden) {
      const font = resolveFont(o.captions.font, o.fontFile, o.captions.bold);
      mkdirSync(fonts);
      prepareFontsDir(fonts, o.fontFile);
      const style = { ...o.captions, font: font.family, bold: font.bold, uppercase: o.captions.uppercase ?? font.caps };
      // The loud words are picked in file time, then carried through the jump cut as a flag.
      let marked: CaptionWord[] = words;
      if (o.emphasis && !followed) {
        progress(0, "vurgulanacak kelimeler aranıyor");
        const loud = loudWords(words, await loudnessOf(t.source, span.end));
        marked = words.map((x) => (loud.has(x) ? { ...x, loud: true as const } : x));
      }
      writeFileSync(ass, toAss(wordsThrough(marked, span, cuts) as CaptionWord[], o.speakerNames === false ? undefined : t.speakers?.names, out.w, out.h, style));
    }
    const mix = dub ? { index: info.hasVideo ? 1 : 2, original: Math.min(0.5, Math.max(0, o.original ?? 0)) } : undefined;
    const filter = graph(parts, info.hasVideo, g, out, o, ass, fonts, mix);
    const script = join(dir, "graph.txt");
    // A jump cut is a filter per part: long graphs go in a file, not on the command line.
    const filterArgs = filter.length > 20_000 ? (writeFileSync(script, filter), ["-/filter_complex", script]) : ["-filter_complex", filter];
    const args = ["-i", t.source];
    // A sound file gets a plain dark picture.
    if (!info.hasVideo) args.push("-f", "lavfi", "-i", `color=c=0x101418:s=${out.w}x${out.h}:r=30:d=${length.toFixed(3)}`);
    if (dub) args.push("-i", dubWavPath(t.id));
    args.push(...filterArgs, "-map", "[v]", "-map", mix ? "[am]" : "[ac]");
    args.push(...(o.codec === "hevc" ? ["-c:v", "libx265", "-tag:v", "hvc1"] : ["-c:v", "libx264"]));
    args.push("-crf", String(o.crf), "-preset", "medium", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", "-t", length.toFixed(3), "-f", "mp4");
    mkdirSync(join(o.output, ".."), { recursive: true });
    args.push(part);
    await ffmpeg(args, (s) => progress(Math.min(1, s / length), "video yazılıyor"));
    ok = true;
  } finally {
    rmSync(dir, { recursive: true, force: true });
    if (ok) renameSync(part, o.output);
    else rmSync(part, { force: true });
  }
  progress(1);
  return { output: o.output, seconds: length, cuts: cuts.length, size: `${out.w}x${out.h}`, dubbed: !!dub, notes };
}
