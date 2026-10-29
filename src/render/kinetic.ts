// Full-screen kinetic typography stage for audio-only and text-to-speech
// projects. Unlike subtitles (which sit in a small box over a video), kinetic
// typography owns the whole W×H frame: a 3D WebGL2 knot (kinetic3d.ts), an
// airport split-flap board, Matter.js rigid-body physics, a virtual 2D
// camera, editorial poster blocks, mask reveals and a zoom-through tunnel.

import Matter from "matter-js";
import { loudWords } from "../captions/emphasis";
import { captionStack, fontById, type FontId } from "../captions/fonts";
import { BLOCK_W, blockAt, buildCameraWorld, cameraAt, lineAt, REF, type CamState, type CamWorld } from "./kineticCamera";
import type { CaptionImage } from "../captions/renderer";
import type { Word } from "../engine";
import { buildCues, type Cue } from "../lib/cues";
import { hasDottedI, TRANSCRIPT_LANG } from "../lib/lang";
import { speakerColor } from "../lib/speakers";
import type { AuraLevels } from "./aura";
import { Kinetic3DStage } from "./kinetic3d";

export type KineticStyleId =
  | "dugum"
  | "pano"
  | "fizik"
  | "kamera"
  | "poster"
  | "darbe"
  | "maske"
  | "tunel";
export type KineticPaletteId = "gece" | "neon" | "krem" | "mercan" | "firuze";

/**
 * What the kinetic stage is drawn over: "stage" the palette's own ground; "aura" the WebGPU aura;
 * "video" the picture under a veil of the palette's ground; "blur" the picture blurred by the
 * compositor, under a lighter veil. Settings keep "stage" or "aura"; the picture is the project's (`backdropFor`).
 */
export type KineticBackdrop = "stage" | "aura" | "video" | "blur";

export interface KineticSettings {
  /** When on, replaces subtitles with the full-screen kinetic stage. */
  on: boolean;
  style: KineticStyleId;
  palette: KineticPaletteId;
  font: FontId;
  backdrop: KineticBackdrop;
}

/**
 * What the stage goes over: the video's picture when it is shown (as it is, or blurred), else the
 * chosen ground (the aura or the palette's own). `picture` is null without one, or with it left out.
 */
export function backdropFor(k: KineticSettings, picture: "video" | "blur" | null): KineticBackdrop {
  return picture ?? (k.backdrop === "stage" ? "stage" : "aura");
}

/** How much of the palette's ground lies over the picture, so the words read on any footage. */
const VEIL = { video: 0.42, blur: 0.22 } as const;

export const DEFAULT_KINETIC: KineticSettings = {
  on: false,
  style: "dugum",
  palette: "gece",
  font: "montserrat",
  backdrop: "stage",
};

export interface KineticStyleInfo {
  id: KineticStyleId;
  label: string;
  note: string;
}

export const KINETIC_STYLES: KineticStyleInfo[] = [
  {
    id: "dugum",
    label: "3D Düğüm",
    note: "Söylenen satır, kendi etrafında dönen üç yüzlü bir 3D düğümün üzerinde akar; odak düğüm boyunca gezinir. Satırın kendisi önde, net ve okunur durur.",
  },
  {
    id: "pano",
    label: "Pano",
    note: "Havalimanı kalkış panosu: her satır konuşmadan hemen önce tık tık dönerek yerine oturur ve okunurken durur; söylenen kelime yanar, üstte saat akar.",
  },
  {
    id: "fizik",
    label: "Fizik (Matter.js)",
    note: "Gerçek 2D fizik motoru: söylenen her kelime sahneye düşer, alttaki kelimelere çarpar, devrilir ve üst üste yığılır.",
  },
  {
    id: "kamera",
    label: "2D Kamera",
    note: "Her cümle iki yana yaslı bir blok olur; yeni kelime öncekileri iter, küçük kelimeler yan durur. Cümle bitince kamera geri çekilir, dönerek sıradakine geçer.",
  },
  {
    id: "poster",
    label: "Poster",
    note: "Tam ekran editoryal sahne: arkada dev hayalet tipografi, ortada farklı ölçeklerde üst üste dizilen poster bloğu.",
  },
  {
    id: "darbe",
    label: "Darbe",
    note: "Sesin enerjisiyle büyüyen tam ekran kelimeler; dolu, kontur ve ters renkli vurgu şeritleri arasında geçiş yapar.",
  },
  {
    id: "maske",
    label: "Maske",
    note: "Editoryal giriş: her kelimenin harfleri görünmez bir çizginin arkasından sırayla yükselir, söylenen kelimenin altını bir çizgi doldurur.",
  },
  {
    id: "tunel",
    label: "Tünel",
    note: "Kelimeler uzaktan gelir, söylenirken ekranda durur, sonraki kelimeyle birlikte kameranın içinden geçip gider.",
  },
];

export interface KineticPalette {
  id: KineticPaletteId;
  label: string;
  bg: string;
  bgGlow: string;
  text: string;
  accent: string;
  muted: string;
}

export const KINETIC_PALETTES: KineticPalette[] = [
  {
    id: "gece",
    label: "Gece & Altın",
    bg: "#090b10",
    bgGlow: "#1c2541",
    text: "#f8fafc",
    accent: "#ffd60a",
    muted: "rgba(248, 250, 252, 0.22)",
  },
  {
    id: "neon",
    label: "Siyah & Neon",
    bg: "#070908",
    bgGlow: "#132a1a",
    text: "#ffffff",
    accent: "#a3ff12",
    muted: "rgba(255, 255, 255, 0.2)",
  },
  {
    id: "krem",
    label: "Krem & Mürekkep",
    bg: "#f4efe6",
    bgGlow: "#e5dccb",
    text: "#141413",
    accent: "#e03e2d",
    muted: "rgba(20, 20, 19, 0.18)",
  },
  {
    id: "mercan",
    label: "Mercan & Beyaz",
    bg: "#12090c",
    bgGlow: "#38141c",
    text: "#fff5f5",
    accent: "#ff5a5f",
    muted: "rgba(255, 245, 245, 0.22)",
  },
  {
    id: "firuze",
    label: "Çini & Firuze",
    bg: "#071018",
    bgGlow: "#12324a",
    text: "#f0f9ff",
    accent: "#36c2b4",
    muted: "rgba(240, 249, 255, 0.22)",
  },
];

export const kineticPaletteById = (id: KineticPaletteId): KineticPalette =>
  KINETIC_PALETTES.find((p) => p.id === id) ?? KINETIC_PALETTES[0];

export const kineticStyleById = (id: KineticStyleId): KineticStyleInfo =>
  KINETIC_STYLES.find((s) => s.id === id) ?? KINETIC_STYLES[0];

const easeOutCubic = (x: number) => 1 - Math.pow(1 - Math.max(0, Math.min(1, x)), 3);
const easeInOutCubic = (x: number) => {
  const t = Math.max(0, Math.min(1, x));
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
};
const easeOutBack = (x: number) => {
  const t = Math.max(0, Math.min(1, x));
  return 1 + 2.1 * Math.pow(t - 1, 3) + 1.1 * Math.pow(t - 1, 2);
};
const easeOutExpo = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : 1 - Math.pow(2, -10 * x));
const easeInCubic = (x: number) => Math.pow(Math.max(0, Math.min(1, x)), 3);

/** The flap wheel of the "Pano" board, in the order the flaps come round. */
const FLAP_WHEEL = [..." ABCÇDEFGĞHIİJKLMNOÖPQRSŞTUÜVWXYZ0123456789.,:;!?'-&"];
/** Seconds per flap. */
const FLAP_TIME = 0.045;
/** At most this many flaps per change; a longer way round skips letters. */
const MAX_FLAPS = 4;
/** Delay per column, so a change ripples left to right. */
const FLAP_STAGGER = 0.011;
/** A cue's flaps start this long before its first word (if the previous one is done by then). */
const BOARD_LEAD = 0.3;
/** After this long without speech the board clears. */
const BOARD_CLEAR = 2.5;

/** One cue on the board: a character per cell and the word it belongs to (-1: blank). */
interface BoardLayout {
  chars: string[];
  word: Int16Array;
}

/**
 * The flaps a cell goes through from `from` to `to`: the characters in
 * between on the wheel (thinned out past MAX_FLAPS), ending on `to`.
 */
function flapChain(from: string, to: string): string[] {
  if (from === to) return [to];
  const n = FLAP_WHEEL.length;
  const a = FLAP_WHEEL.indexOf(from);
  const b = FLAP_WHEEL.indexOf(to);
  if (a < 0 || b < 0) return [from, FLAP_WHEEL[(a + 7 + n) % n], to];
  const dist = (b - a + n) % n;
  const flaps = Math.min(MAX_FLAPS, dist);
  const chain = [from];
  for (let j = 1; j < flaps; j++) chain.push(FLAP_WHEEL[(a + Math.round((j * dist) / flaps)) % n]);
  chain.push(to);
  return chain;
}

/** Seconds a tunnel step takes to fly in, half of it before its first word. */
const TUNEL_ARRIVE = 0.4;

/** Scratch layer for outlineText. */
const outlineLayer = new OffscreenCanvas(8, 8);
/** outlineText's layer never grows past this (a word rushing past the camera is huge but brief). */
const OUTLINE_MAX = 4096;

/**
 * strokeText without the seams. Variable fonts (and composed letters such as
 * Ç, Ş, Ğ) are built from overlapping contours; strokeText draws every
 * contour, so the overlaps show as lines inside the letters. Here the stroke
 * is drawn twice as wide on a layer and the filled text is cut out of it,
 * leaving only the outer edge, as wide as ctx.lineWidth. Uses ctx's font,
 * alignment, stroke style, transform, alpha and shadow.
 */
function outlineText(ctx: OffscreenCanvasRenderingContext2D, text: string, x: number, y: number) {
  const lw = ctx.lineWidth;
  const m = ctx.measureText(text);
  const left = x - m.actualBoundingBoxLeft - lw;
  const top = y - m.actualBoundingBoxAscent - lw;
  const right = x + m.actualBoundingBoxRight + lw;
  const bottom = y + m.actualBoundingBoxDescent + lw;
  // Draw the layer at the device resolution of ctx's transform.
  const tr = ctx.getTransform();
  let sx = Math.hypot(tr.a, tr.b);
  let sy = Math.hypot(tr.c, tr.d);
  const fit = Math.min(1, OUTLINE_MAX / Math.max(1, (right - left) * sx, (bottom - top) * sy));
  sx *= fit;
  sy *= fit;
  const w = Math.ceil((right - left) * sx) + 2;
  const h = Math.ceil((bottom - top) * sy) + 2;
  if (w <= 2 || h <= 2) return;
  if (outlineLayer.width < w) outlineLayer.width = w;
  if (outlineLayer.height < h) outlineLayer.height = h;

  const l = outlineLayer.getContext("2d")!;
  l.setTransform(1, 0, 0, 1, 0, 0);
  l.clearRect(0, 0, w, h);
  l.setTransform(sx, 0, 0, sy, 1 - left * sx, 1 - top * sy);
  l.font = ctx.font;
  l.textAlign = ctx.textAlign;
  l.textBaseline = ctx.textBaseline;
  l.lineJoin = ctx.lineJoin;
  l.strokeStyle = ctx.strokeStyle;
  l.lineWidth = lw * 2;
  l.strokeText(text, x, y);
  l.globalCompositeOperation = "destination-out";
  l.fillStyle = "#000";
  l.fillText(text, x, y);
  l.globalCompositeOperation = "source-over";
  ctx.drawImage(outlineLayer, 0, 0, w, h, left - 1 / sx, top - 1 / sy, w / sx, h / sy);
}

/** "#rrggbb" with an alpha, as rgba(). */
function withAlpha(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

/** Greedy line breaks: the word indices of each line, no line wider than maxW. */
function wrapWords(widths: number[], space: number, maxW: number): number[][] {
  const lines: number[][] = [];
  let line: number[] = [];
  let lineW = 0;
  widths.forEach((w, i) => {
    if (line.length && lineW + space + w > maxW) {
      lines.push(line);
      line = [];
      lineW = 0;
    }
    lineW += (line.length ? space : 0) + w;
    line.push(i);
  });
  if (line.length) lines.push(line);
  return lines;
}

function contrastText(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  const l = 0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255);
  return l > 150 ? "#0c0e12" : "#ffffff";
}

/**
 * Half the height of a box around an uppercase word, centred on the capital
 * height as captions are: the same for every word of a size, whatever its
 * letters, with room for the dots of İ Ö Ü Ğ and the tails of Ç Ş. `ctx`
 * must hold the font.
 */
function capBoxHalf(ctx: OffscreenCanvasRenderingContext2D, capH: number, pad: number) {
  const above = ctx.measureText("İÖÜĞ").actualBoundingBoxAscent || capH;
  const below = ctx.measureText("ÇŞ").actualBoundingBoxDescent || 0;
  return Math.max(above - capH / 2, capH / 2 + below) + pad;
}

/** Pre-baked Matter.js word metadata and per-frame (x, y, angle) trajectories. */
interface BakedPhysicsWord {
  text: string;
  start: number;
  end: number;
  px: number;
  w: number;
  h: number;
  /** Baseline Y offset from the box center: half the capital height, so capitals sit centred as in captions. */
  baselineY: number;
  /** Height of the spoken word's pill: room for İ's dot and Ç's tail, the same for every word of a size. */
  pillH: number;
  loud: boolean;
  /** First simulation frame where this word exists. */
  firstFrame: number;
  /** Last simulation frame where this word is still on screen. */
  lastFrame: number;
  /** Interleaved [x, y, angle] for frames firstFrame..lastFrame. */
  frames: Float32Array;
}

const PHYS_FPS = 60;

/**
 * The last fall worked out for each word list, with what else it depends on. The preview builds a
 * new renderer for every settings change, and the style cards have word lists of their own.
 */
const physicsCache = new WeakMap<
  Word[],
  { W: number; H: number; font: FontId; lang: string; loudness: Float32Array | null; baked: BakedPhysicsWord[] }
>();
const MAX_ACTIVE_BODIES = 7;

let sharedStage3D: Kinetic3DStage | null = null;
function getStage3D(): Kinetic3DStage {
  return (sharedStage3D ??= new Kinetic3DStage());
}

let nextKineticId = 1;

export class KineticRenderer {
  private readonly id = nextKineticId++;
  private canvas = new OffscreenCanvas(8, 8);
  private loud: Set<Word>;
  private loudness: Float32Array | null;
  private cameraGroups: Cue[];
  private posterGroups: Cue[];
  private darbeGroups: Cue[];
  private tunelGroups: Cue[];
  private threeGroups: Cue[];
  private boardGroups: Cue[];
  /** Board size in cells: columns and text rows (a clock row sits above them). */
  private boardCols: number;
  private boardRows: number;
  private boardLayouts = new Map<number, BoardLayout>();
  private bakedPhysics: BakedPhysicsWord[] | null = null;
  /** Kamera's world, laid out on first use (it measures with the canvas). */
  private camWorld: CamWorld | null = null;
  /** Who speaks when, for the name in the corner; empty when no names are shown. */
  private turns: { start: number; end: number; speaker: number }[] = [];

  constructor(
    private words: Word[],
    private k: KineticSettings,
    private W: number,
    private H: number,
    loudness: Float32Array | null = null,
    private lang: string = TRANSCRIPT_LANG,
    /** The speakers' names to show (the words carry `speaker`); null not to. One speaker needs no name. */
    private speakers: string[] | null = null,
  ) {
    this.loudness = loudness;
    if (speakers && speakers.length > 1) {
      for (const w of words) {
        const last = this.turns.at(-1);
        if (w.speaker === undefined || w.speaker >= speakers.length) continue;
        if (last?.speaker === w.speaker) last.end = w.end;
        else this.turns.push({ start: w.start, end: w.end, speaker: w.speaker });
      }
    }
    this.loud = loudness ? loudWords(words, loudness) : new Set();
    this.cameraGroups = buildCues(words, { gap: 0.7, maxDuration: 4.8, maxChars: 56, maxWords: 7 });
    this.posterGroups = buildCues(words, { gap: 0.55, maxDuration: 3.2, maxChars: 38, maxWords: 5 });
    this.darbeGroups = buildCues(words, { gap: 0.4, maxDuration: 1.8, maxChars: 22, maxWords: 2, minDuration: 0.22 });
    // One word per step of the tunnel; fast words travel together, so it moves at phrase pace.
    this.tunelGroups = buildCues(words, { gap: 0.4, maxDuration: 1.6, maxChars: 18, maxWords: 1, minDuration: 0.38 });
    // Narrow frames get shorter lines, so the type on the 3D meshes stays large.
    const upright = W < H;
    this.boardCols = upright ? 10 : W === H ? 14 : 20;
    this.boardRows = upright ? 6 : W === H ? 5 : 3;
    this.boardGroups = buildCues(words, {
      gap: 0.7,
      maxDuration: 5,
      maxChars: Math.floor(this.boardCols * this.boardRows * 0.55),
      maxWords: upright ? 5 : 6,
    });
    this.threeGroups = buildCues(words, {
      gap: 0.75,
      maxDuration: 4.5,
      maxChars: upright ? 20 : W === H ? 28 : 36,
      maxWords: upright ? 3 : 5,
    });
    if (k.style === "fizik" && words.length) {
      this.bakedPhysics = this.cachedPhysics();
    }
  }

  frame(t: number, levels: AuraLevels = { low: 0, mid: 0, high: 0 }): CaptionImage | null {
    if (!this.words.length) return null;
    const { W, H, k } = this;
    if (this.canvas.width !== W) this.canvas.width = W;
    if (this.canvas.height !== H) this.canvas.height = H;
    const ctx = this.canvas.getContext("2d")!;
    ctx.clearRect(0, 0, W, H);

    const pal = kineticPaletteById(k.palette);
    const energy = (levels.low + levels.mid + levels.high) / 3;
    const punch = levels.punch ?? 0;

    if (k.backdrop === "stage") {
      this.drawStageBackground(ctx, pal, t, energy);
    } else if (k.backdrop === "video" || k.backdrop === "blur") {
      ctx.fillStyle = withAlpha(pal.bg, VEIL[k.backdrop]);
      ctx.fillRect(0, 0, W, H);
    }
    if (k.style === "dugum") {
      this.draw3DScene(ctx, pal, t, energy, punch);
      this.drawKnotLine(ctx, pal, t, punch);
    } else {
      if (k.style === "pano") {
        this.drawBoardScene(ctx, pal, t, punch);
      } else if (k.style === "fizik") {
        this.drawMatterPhysicsScene(ctx, pal, t, energy, punch);
      } else if (k.style === "kamera") {
        this.drawCameraScene(ctx, pal, t, energy, punch);
      } else if (k.style === "poster") {
        this.drawPosterScene(ctx, pal, t, energy, punch);
      } else if (k.style === "maske") {
        this.drawMaskeScene(ctx, pal, t, punch);
      } else if (k.style === "tunel") {
        this.drawTunelScene(ctx, pal, t, energy);
      } else {
        this.drawDarbeScene(ctx, pal, t, energy, punch);
      }
    }
    this.drawSpeaker(ctx, pal, t);

    const tick = Math.floor(t * 240);
    return {
      source: this.canvas,
      key: `kin|${this.id}|${k.style}|${k.palette}|${k.backdrop}|${W}x${H}|${tick}`,
      x: 0,
      y: 0,
      w: W,
      h: H,
      scale: 1,
      panel: null,
      frameW: W,
      frameH: H,
    };
  }

  /**
   * The name of who speaks, small in the top left corner, the same in every style: the styles'
   * own layouts are left alone. It fades in as their turn starts and out after it.
   */
  private drawSpeaker(ctx: OffscreenCanvasRenderingContext2D, pal: KineticPalette, t: number) {
    const ts = this.turns;
    if (!ts.length) return;
    let lo = 0;
    let hi = ts.length - 1;
    let i = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (ts[mid].start - 0.15 <= t) {
        i = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    if (i < 0) return;
    const turn = ts[i];
    // Held a moment past the turn, unless the next one has started.
    const until = Math.min(turn.end + 0.6, ts[i + 1] ? ts[i + 1].start - 0.15 : Infinity);
    const alpha = Math.min(1, (t - (turn.start - 0.15)) / 0.2, (until - t) / 0.3);
    if (alpha <= 0) return;
    const { W, H } = this;
    const font = fontById(this.k.font);
    const px = Math.max(10, Math.round(Math.min(W, H) * 0.03));
    const name = hasDottedI(this.lang) ? this.speakers![turn.speaker].toLocaleUpperCase(this.lang) : this.speakers![turn.speaker].toUpperCase();
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.font = `${font.weight} ${px}px ${captionStack(font.id)}`;
    // The scenes leave their own text settings behind.
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    ctx.shadowColor = "transparent";
    ctx.filter = "none";
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const dot = Math.round(px * 0.55);
    const padX = px * 0.7;
    const gap = px * 0.5;
    const w = padX * 2 + dot + gap + ctx.measureText(name).width;
    const h = px * 1.9;
    // Clear of phone UI on vertical video.
    const x = Math.round(W * 0.05);
    const y = Math.round(H * (H > W ? 0.07 : 0.06));
    ctx.fillStyle = withAlpha(pal.bg, 0.62);
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, h / 2);
    ctx.fill();
    ctx.fillStyle = speakerColor(turn.speaker);
    ctx.beginPath();
    ctx.arc(x + padX + dot / 2, y + h / 2, dot / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = pal.text;
    ctx.fillText(name, x + padX + dot + gap, y + h / 2 + ctx.measureText("H").actualBoundingBoxAscent / 2);
    ctx.restore();
  }

  private draw3DScene(
    ctx: OffscreenCanvasRenderingContext2D,
    pal: KineticPalette,
    t: number,
    energy: number,
    punch: number,
  ) {
    if (!this.threeGroups.length) return;
    const gi = this.groupAt(this.threeGroups, t, 0.8);
    const ci = gi >= 0 ? gi : 0;
    const g = this.threeGroups[ci];
    let active = 0;
    for (let i = 0; i < g.words.length && g.words[i].start <= t; i++) active = i;
    getStage3D().render(
      ctx,
      this.W,
      this.H,
      g,
      active,
      t,
      energy,
      punch,
      this.k.font,
      pal,
      this.lang,
      this.loud,
    );
  }

  /** The cue's text laid out on the board: words wrapped to the columns, each line centred, the block centred. */
  private boardLayout(gi: number): BoardLayout {
    const hit = this.boardLayouts.get(gi);
    if (hit) return hit;
    const cols = this.boardCols;
    const rows = this.boardRows;
    const chars: string[] = new Array(cols * rows).fill(" ");
    const word = new Int16Array(cols * rows).fill(-1);
    const lines: { ch: string; w: number }[][] = [];
    let line: { ch: string; w: number }[] = [];
    this.boardGroups[gi].words.forEach((wd, wi) => {
      const text = hasDottedI(this.lang) ? wd.text.toLocaleUpperCase(this.lang) : wd.text.toUpperCase();
      let glyphs = [...text];
      // A word longer than a row is cut across rows.
      while (glyphs.length) {
        const need = glyphs.length + (line.length ? 1 : 0);
        if (line.length && line.length + need > cols) {
          lines.push(line);
          line = [];
          continue;
        }
        if (line.length) line.push({ ch: " ", w: -1 });
        const take = glyphs.slice(0, cols - line.length);
        glyphs = glyphs.slice(take.length);
        line.push(...take.map((ch) => ({ ch, w: wi })));
        if (glyphs.length) {
          lines.push(line);
          line = [];
        }
      }
    });
    if (line.length) lines.push(line);
    const shown = lines.slice(0, rows);
    const top = Math.floor((rows - shown.length) / 2);
    shown.forEach((ln, r) => {
      const left = Math.floor((cols - ln.length) / 2);
      ln.forEach((c, k) => {
        const i = (top + r) * cols + left + k;
        chars[i] = c.ch;
        word[i] = c.w;
      });
    });
    const layout = { chars, word };
    this.boardLayouts.set(gi, layout);
    return layout;
  }

  /**
   * "Pano": an airport split-flap board. Like a real one it changes once and
   * then holds still: a cue's whole text flaps in, rippling left to right,
   * just before its first word, so it is settled and readable while it is
   * said; the spoken word then lights up in the accent without a flap. The
   * board clears after a long pause. A clock row on top ticks the time; its
   * lamp flashes with the voice. Everything is a function of t: a cell's last
   * change, its flap chain and the flap in progress come from the cues.
   */
  private drawBoardScene(ctx: OffscreenCanvasRenderingContext2D, pal: KineticPalette, t: number, punch: number) {
    const { W, H, k, boardCols: cols, boardRows: rows } = this;
    const gs = this.boardGroups;
    // A cue takes the board when its flaps start: ahead of its first word,
    // but not before the previous cue's last word is out (so this only grows with i).
    const flipStart = (i: number) => gs[i].start - Math.min(BOARD_LEAD, i > 0 ? gs[i].start - gs[i - 1].end : BOARD_LEAD);
    let gi = -1;
    for (let lo = 0, hi = gs.length - 1; lo <= hi; ) {
      const mid = (lo + hi) >> 1;
      if (flipStart(mid) <= t) {
        gi = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }

    // Geometry: tall cells with a small gap, a wider gap under the clock row.
    const all = rows + 1;
    let cellW = (W * 0.9) / (cols + (cols - 1) * 0.08);
    let cellH = cellW * 1.38;
    const fitH = (H * 0.86) / (all + (all - 1) * 0.08 * (cellW / cellH) + 0.35);
    if (cellH > fitH) {
      cellW *= fitH / cellH;
      cellH = fitH;
    }
    const gap = cellW * 0.08;
    const headGap = cellH * 0.35;
    const boardW = cols * cellW + (cols - 1) * gap;
    const boardH = all * cellH + (all - 1) * gap + headGap;
    const x0 = (W - boardW) / 2;
    const y0 = (H - boardH) / 2;
    const cellX = (c: number) => x0 + c * (cellW + gap);
    const cellY = (r: number) => y0 + r * (cellH + gap) + (r > 0 ? headGap : 0);

    // Over a picture or an aura the board is glass: a faint frame, empty cells barely there, the
    // cells in use half see-through and their letters solid. On the plain ground it is solid.
    const glass = k.backdrop !== "stage";
    const pad = gap * 3;
    ctx.save();
    ctx.fillStyle = withAlpha(pal.bg, glass ? 0.18 : 0.9);
    ctx.strokeStyle = pal.muted;
    ctx.lineWidth = Math.max(1, cellW * 0.02);
    ctx.beginPath();
    ctx.roundRect(x0 - pad, y0 - pad, boardW + pad * 2, boardH + pad * 2, pad);
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    const font = fontById(k.font);
    ctx.font = `${font.weight} ${Math.round(cellH * 0.62)}px ${captionStack(font.id)}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    const capH = ctx.measureText("H").actualBoundingBoxAscent || cellH * 0.45;
    const radius = cellW * 0.1;

    /**
     * Half a flap (0 top, 1 bottom) showing `ch`, folded towards the axis by sy; shade darkens it as it turns.
     * On glass a turning flap is nearly solid, so the letter behind it does not show through.
     */
    const half = (ch: string, color: string, x: number, y: number, which: 0 | 1, sy: number, shade: number, turning = false) => {
      const mid = y + cellH / 2;
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, which ? mid : y, cellW, cellH / 2);
      ctx.clip();
      ctx.translate(0, mid);
      ctx.scale(1, sy);
      ctx.translate(0, -mid);
      ctx.fillStyle = glass ? withAlpha(pal.bgGlow, turning ? 0.92 : ch === " " ? 0.12 : 0.62) : pal.bgGlow;
      ctx.beginPath();
      ctx.roundRect(x, y, cellW, cellH, radius);
      ctx.fill();
      if (ch !== " ") {
        ctx.fillStyle = color;
        ctx.fillText(ch, x + cellW / 2, mid + capH / 2);
      }
      // The lower flap sits a touch in shadow, as on a real board.
      const dark = shade + (which ? 0.1 : 0);
      if (dark > 0) {
        ctx.fillStyle = `rgba(0, 0, 0, ${Math.min(0.7, dark)})`;
        ctx.fillRect(x, y, cellW, cellH);
      }
      ctx.restore();
    };

    /** A cell flapping through `chain` from time `at` on. */
    const cell = (chain: string[], colors: [string, string], x: number, y: number, at: number) => {
      const e = (t - at) / FLAP_TIME;
      const last = chain.length - 1;
      const colorOf = (j: number) => (j === last ? colors[1] : j === 0 ? colors[0] : pal.text);
      if (e <= 0 || e >= last) {
        const j = e <= 0 ? 0 : last;
        half(chain[j], colorOf(j), x, y, 0, 1, 0);
        half(chain[j], colorOf(j), x, y, 1, 1, 0);
      } else {
        const j = Math.floor(e);
        const p = e - j;
        const a = chain[j];
        const b = chain[j + 1];
        // Behind: the next letter's top, the old letter's bottom. In front: the falling flap.
        half(b, colorOf(j + 1), x, y, 0, 1, 0);
        half(a, colorOf(j), x, y, 1, 1, 0);
        const c = Math.cos(p * Math.PI);
        if (p < 0.5) half(a, colorOf(j), x, y, 0, c, 0.5 * (1 - c), true);
        else half(b, colorOf(j + 1), x, y, 1, -c, 0.4 * (1 + c), true);
      }
      // The split between the flaps.
      ctx.fillStyle = glass ? withAlpha(pal.bg, 0.45) : pal.bg;
      ctx.fillRect(x, y + cellH / 2 - Math.max(1, cellH * 0.012), cellW, Math.max(2, cellH * 0.024));
    };

    // Clock row: mm:ss on the right, each digit flapping on its own change.
    const clock = (s: number) => {
      const v = Math.max(0, Math.floor(s));
      return `${String(Math.floor(v / 60) % 100).padStart(2, "0")}:${String(v % 60).padStart(2, "0")}`;
    };
    const now = clock(t);
    const before = clock(t - 1);
    const sec = Math.floor(t);
    for (let c = 0; c < cols; c++) {
      const ci = c - (cols - now.length);
      if (ci < 0) {
        cell([" "], [pal.text, pal.text], cellX(c), cellY(0), 0);
        continue;
      }
      cell(flapChain(before[ci], now[ci]), [pal.muted, pal.muted], cellX(c), cellY(0), sec + ci * FLAP_STAGGER);
    }
    // The lamp: lit with the voice.
    const lampR = cellW * 0.16;
    ctx.save();
    ctx.globalAlpha = 0.35 + 0.65 * punch;
    ctx.fillStyle = pal.accent;
    ctx.shadowColor = pal.accent;
    ctx.shadowBlur = lampR * 3 * punch;
    ctx.beginPath();
    ctx.arc(cellX(0) + cellW / 2, cellY(0) + cellH / 2, lampR, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // Text rows.
    const cur = gi >= 0 ? this.boardLayout(gi) : null;
    const prev = gi > 0 ? this.boardLayout(gi - 1) : null;
    const g = gi >= 0 ? gs[gi] : null;
    // The previous cue was cleared if a long pause came before this one.
    const prevCleared = !!g && gi > 0 && g.start - gs[gi - 1].end > BOARD_CLEAR;
    const next = gi + 1 < gs.length ? gs[gi + 1] : null;
    const clearAt = g && (!next || next.start - g.end > BOARD_CLEAR) ? g.end + BOARD_CLEAR : Infinity;
    let active = -1;
    if (g) for (let i = 0; i < g.words.length && g.words[i].start <= t; i++) active = i;
    const flipAt = gi >= 0 ? flipStart(gi) : 0;
    const colorFor = (layout: BoardLayout | null, gIdx: number, i: number, isCurrent: boolean) => {
      const w = layout ? layout.word[i] : -1;
      if (w < 0) return pal.text;
      const wd = gs[gIdx].words[w];
      return (isCurrent && w === active) || this.loud.has(wd) ? pal.accent : pal.text;
    };

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        const x = cellX(c);
        const y = cellY(r + 1);
        if (!cur || !g) {
          cell([" "], [pal.text, pal.text], x, y, 0);
          continue;
        }
        const old = prev && !prevCleared ? prev.chars[i] : " ";
        const oldColor = prev && !prevCleared ? colorFor(prev, gi - 1, i, false) : pal.text;
        const lag = c * FLAP_STAGGER;
        if (t >= clearAt + lag) {
          cell(flapChain(cur.chars[i], " "), [colorFor(cur, gi, i, false), pal.text], x, y, clearAt + lag);
        } else {
          cell(flapChain(old, cur.chars[i]), [oldColor, colorFor(cur, gi, i, true)], x, y, flipAt + lag);
        }
      }
    }
  }

  /**
   * The knot's line again, in front and in focus: on the knot the type is
   * decoration, this is what is read. The whole line is there from the start
   * (unsaid words dimmed, so the eye can read ahead), the spoken word is in
   * the accent, and a soft scrim in the palette's ground keeps it clear of the
   * knot behind. The line comes into focus from slightly larger, like the DoF.
   */
  private drawKnotLine(ctx: OffscreenCanvasRenderingContext2D, pal: KineticPalette, t: number, punch: number) {
    const gi = this.groupAt(this.threeGroups, t, 0.6);
    if (gi < 0) return;
    const g = this.threeGroups[gi];
    let active = 0;
    for (let i = 0; i < g.words.length && g.words[i].start <= t; i++) active = i;

    const next = this.threeGroups[gi + 1];
    const until = Math.min(g.end + 0.6, next ? next.start : Infinity);
    const inP = easeOutCubic((t - g.start + 0.05) / 0.35);
    const vis = inP * (1 - easeInCubic((t - (until - 0.22)) / 0.22));
    if (vis <= 0) return;

    const { W, H, k } = this;
    const short = Math.min(W, H);
    const font = fontById(k.font);
    const css = (sz: number) => `${font.weight} ${Math.round(sz)}px ${captionStack(font.id)}`;
    const texts = g.words.map((w) =>
      hasDottedI(this.lang) ? w.text.toLocaleUpperCase(this.lang) : w.text.toUpperCase(),
    );

    const maxW = W * 0.8;
    let px = Math.max(16, Math.round(short * 0.075));
    ctx.font = css(px);
    const longest = Math.max(...texts.map((tx) => ctx.measureText(tx).width));
    if (longest > maxW) {
      px = Math.floor((px * maxW) / longest);
      ctx.font = css(px);
    }
    const widths = texts.map((tx) => ctx.measureText(tx).width);
    const space = px * 0.28;
    const lines = wrapWords(widths, space, maxW);
    const lineWidth = (ln: number[]) => ln.reduce((a, i, n) => a + widths[i] + (n ? space : 0), 0);
    const capH = ctx.measureText("H").actualBoundingBoxAscent || px * 0.72;
    const lineH = px * 1.18;
    const blockH = lines.length * lineH;
    const top = (H - blockH) / 2;

    // Scrim: an ellipse of the ground colour behind the block.
    const rx = Math.max(...lines.map(lineWidth)) * 0.62 + px;
    const ry = blockH * 0.75 + px;
    ctx.save();
    ctx.translate(W / 2, H / 2);
    ctx.scale(1, ry / rx);
    const scrim = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
    scrim.addColorStop(0, withAlpha(pal.bg, 0.78 * vis));
    scrim.addColorStop(0.6, withAlpha(pal.bg, 0.5 * vis));
    scrim.addColorStop(1, withAlpha(pal.bg, 0));
    ctx.fillStyle = scrim;
    ctx.fillRect(-rx, -rx, rx * 2, rx * 2);
    ctx.restore();

    ctx.save();
    const enter = 1 + 0.06 * (1 - inP);
    ctx.translate(W / 2, H / 2);
    ctx.scale(enter, enter);
    ctx.translate(-W / 2, -H / 2);
    ctx.textBaseline = "alphabetic";
    ctx.textAlign = "left";
    ctx.font = css(px);
    // A glow in the ground colour, so the type holds on light and dark palettes alike.
    ctx.shadowColor = pal.bg;
    ctx.shadowBlur = px * 0.35;
    lines.forEach((ln, li) => {
      const base = top + li * lineH + (lineH + capH) / 2;
      let x = (W - lineWidth(ln)) / 2;
      for (const wi of ln) {
        const wd = g.words[wi];
        const said = wd.start <= t;
        const isActive = wi === active && said;
        ctx.save();
        ctx.globalAlpha = vis * (said ? 1 : 0.3);
        ctx.fillStyle = isActive || (said && this.loud.has(wd)) ? pal.accent : pal.text;
        if (isActive) {
          // The spoken word pops a little as it lands, and with the voice.
          const pop = 1 + 0.1 * (1 - easeOutCubic((t - wd.start) / 0.22)) + punch * 0.05;
          const cx = x + widths[wi] / 2;
          const cy = base - capH / 2;
          ctx.translate(cx, cy);
          ctx.scale(pop, pop);
          ctx.translate(-cx, -cy);
        }
        ctx.fillText(texts[wi], x, base);
        ctx.restore();
        x += widths[wi] + space;
      }
    });
    ctx.restore();
  }

  /**
   * Pre-bakes a real Matter.js 2D rigid-body simulation across the entire word
   * list at 60 Hz so timeline scrubbing and MP4 export are 100% deterministic.
   */
  /** The fall as last worked out, when only what does not move the words changed (the palette, say). */
  private cachedPhysics(): BakedPhysicsWord[] {
    const { words, W, H, loudness, lang } = this;
    const font = this.k.font;
    const c = physicsCache.get(words);
    if (c && c.W === W && c.H === H && c.font === font && c.lang === lang && c.loudness === loudness) return c.baked;
    const baked = this.bakeMatterPhysics();
    physicsCache.set(words, { W, H, font, lang, loudness, baked });
    return baked;
  }

  private bakeMatterPhysics(): BakedPhysicsWord[] {
    const { W, H, k, words } = this;
    const short = Math.min(W, H);
    const font = fontById(k.font);
    const css = (sz: number) => `${font.weight} ${Math.round(sz)}px ${captionStack(font.id)}`;
    const ctx = this.canvas.getContext("2d")!;
    const basePx = Math.max(22, Math.round(short * 0.11));

    const endT = Math.min(600, (words.at(-1)?.end ?? 0) + 1.2);
    const totalFrames = Math.max(1, Math.ceil(endT * PHYS_FPS));

    const engine = Matter.Engine.create({
      gravity: { x: 0, y: (short / 900) * 1.65, scale: 0.001 },
    });
    const world = engine.world;

    // Stage floor and side walls (category 0x0001).
    const floorY = H * 0.82;
    const wallT = 120;
    const wallPad = W * 0.05;
    const floor = Matter.Bodies.rectangle(W / 2, floorY + wallT / 2, W * 2, wallT, {
      isStatic: true,
      restitution: 0.4,
      friction: 0.2,
      collisionFilter: { category: 0x0001, mask: 0x0002 },
    });
    const leftWall = Matter.Bodies.rectangle(wallPad - wallT / 2, H / 2, wallT, H * 3, {
      isStatic: true,
      restitution: 0.4,
      friction: 0.05,
      collisionFilter: { category: 0x0001, mask: 0x0002 },
    });
    const rightWall = Matter.Bodies.rectangle(W - wallPad + wallT / 2, H / 2, wallT, H * 3, {
      isStatic: true,
      restitution: 0.4,
      friction: 0.05,
      collisionFilter: { category: 0x0001, mask: 0x0002 },
    });
    Matter.Composite.add(world, [floor, leftWall, rightWall]);

    interface SimItem {
      meta: BakedPhysicsWord;
      body: Matter.Body;
      spawnFrame: number;
      released: boolean;
      history: number[];
    }

    const items: SimItem[] = words.map((wd, i) => {
      const text = hasDottedI(this.lang) ? wd.text.toLocaleUpperCase(this.lang) : wd.text.toUpperCase();
      const loud = this.loud.has(wd);
      const len = [...text].length;
      const scale = loud ? 1.28 : len <= 3 ? 0.85 : len >= 9 ? 0.88 : 1.05;
      const px = Math.min(basePx * scale, (W * 0.72) / Math.max(1, len * 0.62));
      ctx.font = css(px);
      const m = ctx.measureText(text);
      const tw = m.width;
      const capH = ctx.measureText("H").actualBoundingBoxAscent || px * 0.72;
      // Centred on the capitals, as captions are; İ's dot and Ç's tail reach
      // into the padding. The collider hugs the capitals, so a word with an İ
      // does not stand off the word above it.
      const baselineY = capH / 2;
      const w = tw + px * 0.34;
      const h = capH + px * 0.28;
      const pillH = Math.max(h, capBoxHalf(ctx, capH, px * 0.1) * 2);

      const seed = Math.sin((i * 37 + 13) * 12.9898) * 43758.5453;
      const frac = seed - Math.floor(seed) - 0.5;
      const maxOffset = Math.max(20, (W - wallPad * 2 - w) * 0.38);
      const x0 = W / 2 + frac * maxOffset * 2;
      const y0 = -h * 0.7;

      const body = Matter.Bodies.rectangle(x0, y0, w, h, {
        restitution: 0.45,
        friction: 0.12,
        frictionAir: 0.012,
        density: 0.002,
        chamfer: { radius: Math.min(w, h) * 0.18 },
        collisionFilter: { category: 0x0002, mask: 0x0001 | 0x0002 },
      });
      Matter.Body.setAngle(body, frac * 0.34);
      Matter.Body.setVelocity(body, { x: -frac * (short * 0.008), y: short * 0.012 });
      Matter.Body.setAngularVelocity(body, -frac * 0.06);

      const spawnFrame = Math.max(0, Math.min(totalFrames - 1, Math.floor(wd.start * PHYS_FPS)));
      return {
        meta: {
          text,
          start: wd.start,
          end: wd.end,
          px,
          w,
          h,
          baselineY,
          pillH,
          loud,
          firstFrame: spawnFrame,
          lastFrame: spawnFrame,
          frames: new Float32Array(0),
        },
        body,
        spawnFrame,
        released: false,
        history: [],
      };
    });

    const spawned: SimItem[] = [];
    let nextIdx = 0;

    for (let f = 0; f < totalFrames; f++) {
      const simT = f / PHYS_FPS;
      while (nextIdx < items.length && items[nextIdx].spawnFrame <= f) {
        const it = items[nextIdx++];
        // Also drop older words if there was a pause (> 1.1s) before this word.
        const prevWord = nextIdx >= 2 ? items[nextIdx - 2] : null;
        const pauseBreak = prevWord && it.meta.start - prevWord.meta.end >= 1.1;
        if (pauseBreak) {
          for (const old of spawned) {
            if (!old.released) {
              old.released = true;
              old.body.collisionFilter.mask = 0;
              Matter.Body.setVelocity(old.body, { x: old.body.velocity.x, y: short * 0.01 });
            }
          }
        }
        Matter.Composite.add(world, it.body);
        spawned.push(it);

        // Release oldest words when the pile exceeds MAX_ACTIVE_BODIES so the stage stays clean.
        const activeOnStage = spawned.filter((s) => !s.released);
        while (activeOnStage.length > MAX_ACTIVE_BODIES) {
          const oldest = activeOnStage.shift()!;
          oldest.released = true;
          oldest.body.collisionFilter.mask = 0;
          Matter.Body.setVelocity(oldest.body, { x: oldest.body.velocity.x, y: short * 0.008 });
        }

        // Loud word shockwave jolts nearby resting words.
        if (it.meta.loud) {
          for (const other of activeOnStage) {
            if (other !== it) {
              Matter.Body.setVelocity(other.body, {
                x: other.body.velocity.x + (other.body.position.x < it.body.position.x ? -3 : 3),
                y: other.body.velocity.y - short * 0.011,
              });
            }
          }
        }
      }

      Matter.Engine.update(engine, 1000 / PHYS_FPS);

      for (let i = 0; i < spawned.length; i++) {
        const it = spawned[i];
        // Fallen off the stage and said: out of the world, so the simulation stays as small as the pile on screen.
        if (it.body.position.y - it.meta.h > H * 1.25 && simT > it.meta.end + 0.5) {
          Matter.Composite.remove(world, it.body);
          spawned.splice(i--, 1);
          continue;
        }
        it.history.push(it.body.position.x, it.body.position.y, it.body.angle);
        it.meta.lastFrame = f;
      }
    }

    for (const it of items) {
      it.meta.frames = new Float32Array(it.history);
    }
    return items.map((it) => it.meta);
  }

  private drawMatterPhysicsScene(
    ctx: OffscreenCanvasRenderingContext2D,
    pal: KineticPalette,
    t: number,
    energy: number,
    punch: number,
  ) {
    const baked = (this.bakedPhysics ??= this.cachedPhysics());
    if (!baked.length) return;

    const { W, H, k } = this;
    const short = Math.min(W, H);
    const font = fontById(k.font);
    const css = (sz: number) => `${font.weight} ${Math.round(sz)}px ${captionStack(font.id)}`;

    let active = -1;
    for (let i = 0; i < baked.length && baked[i].start <= t; i++) active = i;
    if (active < 0) return;

    // Subtle glowing stage floor line.
    const floorY = H * 0.82;
    const wallPad = W * 0.05;
    ctx.strokeStyle = pal.muted;
    ctx.lineWidth = Math.max(2, Math.round(short / 420));
    ctx.beginPath();
    ctx.moveTo(wallPad, floorY);
    ctx.lineTo(W - wallPad, floorY);
    ctx.stroke();

    const exactFrame = t * PHYS_FPS;
    const f0 = Math.floor(exactFrame);
    const frac = exactFrame - f0;

    ctx.textBaseline = "alphabetic";
    ctx.textAlign = "center";

    for (let i = 0; i <= active; i++) {
      const bw = baked[i];
      if (f0 < bw.firstFrame || f0 > bw.lastFrame || !bw.frames.length) continue;
      const idx0 = Math.min(bw.lastFrame - bw.firstFrame, Math.max(0, f0 - bw.firstFrame)) * 3;
      const idx1 = Math.min(bw.frames.length - 3, idx0 + 3);
      const x = bw.frames[idx0] + (bw.frames[idx1] - bw.frames[idx0]) * frac;
      const y = bw.frames[idx0 + 1] + (bw.frames[idx1 + 1] - bw.frames[idx0 + 1]) * frac;
      const angle = bw.frames[idx0 + 2] + (bw.frames[idx1 + 2] - bw.frames[idx0 + 2]) * frac;

      if (y - bw.h > H * 1.1) continue;

      const isCurrent = i === active;
      const pulse = isCurrent ? 1 + energy * 0.06 + punch * 0.08 : 1;

      // Squash on impact: the sharpest recent drop in falling speed, fading over a few frames.
      const yAt = (f: number) => bw.frames[(f - bw.firstFrame) * 3 + 1];
      let squash = 0;
      for (let d = 0; d < 6; d++) {
        const f = f0 - d;
        if (f - 2 < bw.firstFrame || f > bw.lastFrame) continue;
        const decel = yAt(f - 1) - yAt(f - 2) - (yAt(f) - yAt(f - 1));
        if (decel > 0) squash = Math.max(squash, decel * Math.exp(-d / 2.5));
      }
      squash = Math.min(0.18, (squash / short) * 6);

      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(angle);
      ctx.scale(pulse * (1 + squash), pulse * (1 - squash));
      ctx.font = css(bw.px);

      if (isCurrent) {
        // Active spoken word gets a bold accent sticker pill.
        ctx.shadowColor = "rgba(0, 0, 0, 0.55)";
        ctx.shadowBlur = bw.px * 0.32;
        ctx.shadowOffsetY = bw.px * 0.08;
        ctx.fillStyle = pal.accent;
        ctx.beginPath();
        ctx.roundRect(-bw.w / 2, -bw.pillH / 2, bw.w, bw.pillH, bw.px * 0.18);
        ctx.fill();
        ctx.shadowColor = "transparent";
        ctx.fillStyle = contrastText(pal.accent);
        ctx.fillText(bw.text, 0, bw.baselineY);
      } else {
        // Settled words render as pure giant bold typography colliding letter-to-letter.
        ctx.shadowColor = "rgba(0, 0, 0, 0.65)";
        ctx.shadowBlur = bw.px * 0.22;
        ctx.shadowOffsetY = bw.px * 0.05;
        ctx.fillStyle = bw.loud ? pal.accent : pal.text;
        ctx.fillText(bw.text, 0, bw.baselineY);
      }
      ctx.restore();
    }
  }

  private drawStageBackground(
    ctx: OffscreenCanvasRenderingContext2D,
    pal: KineticPalette,
    t: number,
    energy: number,
  ) {
    const { W, H } = this;
    ctx.fillStyle = pal.bg;
    ctx.fillRect(0, 0, W, H);

    // Audio-reactive radial glow drifting slowly in the center.
    const gx = W * (0.5 + 0.14 * Math.sin(t * 0.35));
    const gy = H * (0.5 + 0.12 * Math.cos(t * 0.28));
    const r = Math.max(W, H) * (0.55 + 0.18 * energy);
    const grad = ctx.createRadialGradient(gx, gy, 0, gx, gy, r);
    grad.addColorStop(0, pal.bgGlow);
    grad.addColorStop(1, "transparent");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);

    // Subtle editorial frame lines.
    const inset = Math.round(Math.min(W, H) * 0.045);
    ctx.strokeStyle = pal.muted;
    ctx.lineWidth = Math.max(1, Math.round(Math.min(W, H) / 720));
    ctx.strokeRect(inset, inset, W - inset * 2, H - inset * 2);
  }

  private groupAt(gs: Cue[], t: number, hold = 0.45): number {
    let lo = 0;
    let hi = gs.length - 1;
    let i = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (gs[mid].start <= t) {
        i = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    if (i < 0) return -1;
    const until = Math.min(gs[i].end + hold, i + 1 < gs.length ? gs[i + 1].start : Infinity);
    return t < until ? i : -1;
  }

  /**
   * "Kamera": words are placed in a 2D world with scale hierarchy and 90° turns;
   * a virtual camera pans, zooms and rotates to center the active word while
   * keeping earlier words in view around it.
   */
  private drawCameraScene(
    ctx: OffscreenCanvasRenderingContext2D,
    pal: KineticPalette,
    t: number,
    energy: number,
    punch: number,
  ) {
    const { W, H, k } = this;
    const font = fontById(k.font);
    const css = (sz: number) => `${font.weight} ${Math.round(sz * 100) / 100}px ${captionStack(font.id)}`;
    const world = (this.camWorld ??= buildCameraWorld(
      this.cameraGroups,
      {
        width: (text) => {
          ctx.font = css(REF);
          return ctx.measureText(text).width;
        },
        cap: (() => {
          ctx.font = css(REF);
          return ctx.measureText("H").actualBoundingBoxAscent || REF * 0.72;
        })(),
      },
      (text) => (hasDottedI(this.lang) ? text.toLocaleUpperCase(this.lang) : text.toUpperCase()),
      this.loud,
      this.lang,
      W,
      H,
    ));
    const cur = blockAt(world, t);
    if (cur < 0) return;
    const last = world.blocks[world.blocks.length - 1];
    // Gone a while after the last phrase.
    const fade = 1 - Math.max(0, Math.min(1, (t - last.end - 3) / 0.5));
    if (fade <= 0) return;

    const short = Math.min(W, H);
    const cam = cameraAt(world, t);
    // A stressed syllable gently shakes the camera (smoothly interpolated so it never teleports between frames).
    const jolt = punch * short * 0.009;
    const rnd = (x: number) => {
      const v = Math.sin(x * 12.9898) * 43758.5453;
      return v - Math.floor(v) - 0.5;
    };
    const smoothRnd = (x: number) => {
      const i = Math.floor(x);
      const f = x - i;
      const u = f * f * (3 - 2 * f);
      return rnd(i) + (rnd(i + 1) - rnd(i)) * u;
    };
    const jx = smoothRnd(t * 14) * jolt;
    const jy = smoothRnd(t * 14 + 7.3) * jolt;
    const view = (c: CamState) => {
      const zoom = c.zoom * (1 + energy * 0.03);
      ctx.translate(W / 2 + jx, H / 2 + jy);
      ctx.scale(zoom, zoom);
      ctx.rotate(-c.angle);
      ctx.translate(-c.x, -c.y);
      return zoom;
    };

    ctx.save();
    const zoom = view(cam);
    // A dot grid fixed to the world, so every pan, zoom and turn of the camera is felt. Its spacing
    // doubles as the camera pulls back, so there are never more than a few hundred dots.
    const minStep = (short * 0.09) / zoom;
    const step = BLOCK_W * 0.06 * Math.pow(2, Math.max(0, Math.ceil(Math.log2(minStep / (BLOCK_W * 0.06)))));
    const reach = Math.hypot(W, H) / zoom / 2;
    const dot = Math.max(1.5, short / 420) / zoom;
    ctx.globalAlpha = fade;
    ctx.fillStyle = pal.muted;
    for (let gx = Math.floor((cam.x - reach) / step) * step; gx <= cam.x + reach; gx += step) {
      for (let gy = Math.floor((cam.y - reach) / step) * step; gy <= cam.y + reach; gy += step) {
        ctx.fillRect(gx - dot / 2, gy - dot / 2, dot, dot);
      }
    }
    ctx.restore();

    // Motion blur without a filter: on a fast move the words are drawn again, fainter, where the
    // camera was a moment ago.
    const before = cameraAt(world, t - 1 / 30);
    const moved =
      Math.hypot(cam.x - before.x, cam.y - before.y) * cam.zoom +
      Math.abs(cam.angle - before.angle) * short * 0.5 +
      Math.abs(Math.log(cam.zoom / before.zoom)) * short;
    const smear = Math.min(1, Math.max(0, (moved - short * 0.02) / (short * 0.06)));
    if (smear > 0) {
      ctx.save();
      view(cameraAt(world, t - 1 / 35));
      this.drawCameraWords(ctx, pal, world, cur, t, fade * 0.28 * smear, css);
      ctx.restore();
    }
    ctx.save();
    view(cam);
    this.drawCameraWords(ctx, pal, world, cur, t, fade, css);
    ctx.restore();
  }

  /** Kamera's words in the world (the camera already applied): the block being said, and up to three before it, faint. */
  private drawCameraWords(
    ctx: OffscreenCanvasRenderingContext2D,
    pal: KineticPalette,
    world: CamWorld,
    cur: number,
    t: number,
    alpha: number,
    css: (px: number) => string,
  ) {
    ctx.textBaseline = "alphabetic";
    const cap = world.capRef;
    // The word being said: the last one started in the current block.
    let said: Word | null = null;
    for (const l of world.blocks[cur].lines) for (const it of l.items) if (it.word.start <= t) said = it.word;
    const b0 = world.blocks[cur];
    const travelIn = Math.max(0, Math.min(1, (t - b0.enter) / Math.max(0.2, b0.start - b0.enter)));

    for (let bi = Math.max(0, cur - 3); bi <= cur; bi++) {
      const b = world.blocks[bi];
      // Phrases left behind stay in the world, faint.
      const dim = bi === cur ? 1 : bi === cur - 1 ? 1 - 0.78 * travelIn : 0.22;
      ctx.save();
      ctx.translate(b.ox, b.oy);
      ctx.rotate(b.angle);
      for (const line of b.lines) {
        const placed = lineAt(line, t);
        if (!placed) continue;
        const baseline = line.top + placed.h;
        for (const p of placed.items) {
          const it = p.item;
          const px = REF * it.f;
          const current = bi === cur && it.word === said;
          ctx.save();
          ctx.globalAlpha = alpha * dim * p.enter * (it.stop ? 0.78 : 1);
          ctx.font = css(px);
          if (it.tag) {
            // Sideways at the head of the line, reading upwards from the baseline.
            ctx.translate(p.x + cap * it.f * p.s, baseline);
            ctx.rotate(-Math.PI / 2);
            ctx.scale(p.s, p.s);
            ctx.fillStyle = current ? pal.accent : pal.text;
            ctx.fillText(it.text, 0, 0);
            ctx.restore();
            continue;
          }
          // A new word slides in from the right and grows into place.
          const w = it.w * p.s;
          const capH = cap * it.f * p.s;
          const grow = 0.55 + 0.45 * p.enter;
          ctx.translate(p.x + w / 2 + (1 - p.enter) * REF * 0.5 * p.s, baseline - capH / 2);
          ctx.scale(p.s * grow, p.s * grow);
          ctx.translate(-it.w / 2, (cap * it.f) / 2);
          if (current && it.loud && !it.stop) {
            const padX = px * 0.2;
            const padY = px * 0.14;
            ctx.fillStyle = pal.accent;
            ctx.beginPath();
            ctx.roundRect(-padX, -cap * it.f - padY, it.w + padX * 2, cap * it.f + padY * 2, px * 0.16);
            ctx.fill();
            ctx.fillStyle = contrastText(pal.accent);
          } else {
            // No shadow: a blurred shadow costs more than everything else in the scene put together.
            ctx.fillStyle = current || (it.loud && it.word.start <= t) ? pal.accent : pal.text;
          }
          ctx.fillText(it.text, 0, 0);
          ctx.restore();
        }
      }
      ctx.restore();
    }
  }

  /**
   * "Poster": giant background ghost word + multi-scale justified poster stack
   * in the center of the stage.
   */
  private drawPosterScene(
    ctx: OffscreenCanvasRenderingContext2D,
    pal: KineticPalette,
    t: number,
    energy: number,
    punch: number,
  ) {
    const gi = this.groupAt(this.posterGroups, t, 0.45);
    if (gi < 0) return;
    const g = this.posterGroups[gi];
    let active = 0;
    for (let i = 0; i < g.words.length && g.words[i].start <= t; i++) active = i;

    const { W, H, k } = this;
    const short = Math.min(W, H);
    const font = fontById(k.font);
    const css = (sz: number) => `${font.weight} ${Math.round(sz)}px ${captionStack(font.id)}`;
    const texts = g.words.map((w) =>
      hasDottedI(this.lang) ? w.text.toLocaleUpperCase(this.lang) : w.text.toUpperCase(),
    );

    const ghostText = texts[active] ?? texts[0];
    if (ghostText) {
      ctx.save();
      const ghostPx = Math.round(short * (0.34 + energy * 0.04 + punch * 0.03));
      ctx.font = css(ghostPx);
      ctx.textBaseline = "middle";
      ctx.textAlign = "center";
      ctx.strokeStyle = pal.muted;
      ctx.lineWidth = Math.max(2, ghostPx * 0.025);
      const drift = Math.sin(t * 0.8) * W * 0.03;
      outlineText(ctx, ghostText, W / 2 + drift, H / 2);
      ctx.restore();
    }

    const rows: number[][] = [];
    for (let i = 0; i < g.words.length; ) {
      const len = [...texts[i]].length;
      const left = g.words.length - i;
      if (i + 1 < g.words.length && (len <= 3 || (rows.length >= 2 && left >= 2))) {
        rows.push([i, i + 1]);
        i += 2;
      } else {
        rows.push([i]);
        i++;
      }
    }

    const basePx = Math.max(16, Math.round(short * 0.09));
    const targetW = Math.min(W * 0.76, basePx * 6.0);
    const wordRel = g.words.map((w, i) => {
      if (this.loud.has(w)) return 1.25;
      return [...texts[i]].length <= 3 && g.words.length > 1 ? 0.84 : 1;
    });

    const rowMetrics = rows.map((row) => {
      const gap = basePx * 0.28;
      const natW = row.reduce((acc, i, idx) => {
        ctx.font = css(basePx * wordRel[i]);
        return acc + ctx.measureText(texts[i]).width + (idx ? gap : 0);
      }, 0);
      const fit = natW > 0 ? targetW / natW : 1;
      const scale = Math.min((W * 0.82) / Math.max(1, natW), Math.max(0.82, Math.min(1.52, fit)));
      const px = basePx * scale;
      const wordGap = px * 0.26;
      const widths = row.map((i) => {
        ctx.font = css(px * wordRel[i]);
        return ctx.measureText(texts[i]).width;
      });
      const totalW = widths.reduce((a, b) => a + b, 0) + wordGap * Math.max(0, row.length - 1);
      const maxWordPx = px * Math.max(...row.map((i) => wordRel[i]));
      const rowH = Math.round(maxWordPx * 1.15);
      return { row, px, wordGap, widths, totalW, rowH };
    });

    let visibleH = 0;
    const rowPresence = rowMetrics.map((m) => {
      const firstIdx = m.row[0];
      if (firstIdx > active) return 0;
      const e = easeOutCubic((t - g.words[firstIdx].start) / 0.22);
      visibleH += m.rowH * e;
      return e;
    });

    ctx.textBaseline = "alphabetic";
    ctx.textAlign = "left";
    let curY = (H - visibleH) / 2;

    rowMetrics.forEach((m, ri) => {
      const presence = rowPresence[ri];
      if (presence <= 0) return;
      const cy = curY + (m.rowH * presence) / 2;
      curY += m.rowH * presence;

      let x = (W - m.totalW) / 2;
      m.row.forEach((wi, kIdx) => {
        const wWidth = m.widths[kIdx];
        if (wi <= active) {
          const wd = g.words[wi];
          const dt = Math.max(0, t - wd.start);
          const p = Math.min(1, dt / 0.24);
          const e = easeOutCubic(p);
          const spring = easeOutBack(p);
          const isCurrent = wi === active;
          const wPx = m.px * wordRel[wi];
          const wcx = x + wWidth / 2;

          ctx.save();
          ctx.font = css(wPx);
          const capH = ctx.measureText("H").actualBoundingBoxAscent || wPx * 0.72;
          const slideY = (1 - e) * m.rowH * 0.5;
          const scale = (0.72 + 0.28 * spring) * (isCurrent ? 1 + energy * 0.06 + punch * 0.05 : 1);

          ctx.globalAlpha = Math.min(1, e * 1.2) * (isCurrent ? 1 : 0.88);
          ctx.translate(wcx, cy + slideY);
          ctx.scale(scale, scale);
          ctx.translate(-wcx, -cy);

          // Block reveal: an accent bar wipes in over the word, then wipes off to uncover it.
          const rp = (t - wd.start) / 0.34;
          if (rp < 1) {
            const a = easeInOutCubic(Math.min(1, rp * 2));
            const b = easeInOutCubic(Math.max(0, rp * 2 - 1));
            const barH = capH * 1.3;
            ctx.fillStyle = pal.accent;
            ctx.fillRect(x + wWidth * b, cy - barH / 2, wWidth * (a - b), barH);
          }
          if (rp >= 0.5) {
            ctx.shadowColor = "rgba(0, 0, 0, 0.5)";
            ctx.shadowBlur = wPx * 0.24;
            ctx.fillStyle = isCurrent || this.loud.has(wd) ? pal.accent : pal.text;
            ctx.fillText(texts[wi], x, cy + capH / 2);
          }
          ctx.restore();
        }
        x += wWidth + m.wordGap;
      });
    });
  }

  /**
   * "Darbe": full-screen rhythmic kinetic cuts with alternating inverted bars,
   * outline echoes, and beat-reactive scale slams.
   */
  private drawDarbeScene(
    ctx: OffscreenCanvasRenderingContext2D,
    pal: KineticPalette,
    t: number,
    energy: number,
    punch: number,
  ) {
    const gi = this.groupAt(this.darbeGroups, t, 0.35);
    if (gi < 0) return;
    const g = this.darbeGroups[gi];
    let active = 0;
    for (let i = 0; i < g.words.length && g.words[i].start <= t; i++) active = i;

    const { W, H, k } = this;
    const short = Math.min(W, H);
    const font = fontById(k.font);
    const css = (sz: number) => `${font.weight} ${Math.round(sz)}px ${captionStack(font.id)}`;
    const texts = g.words.map((w) =>
      hasDottedI(this.lang) ? w.text.toLocaleUpperCase(this.lang) : w.text.toUpperCase(),
    );

    const basePx = Math.round(short * 0.15);
    const rows = texts.map((txt, i) => {
      ctx.font = css(basePx);
      const natW = Math.max(1, ctx.measureText(txt).width);
      const px = Math.min(basePx * 1.35, Math.max(short * 0.065, (basePx * (W * 0.78)) / natW));
      ctx.font = css(px);
      const w = ctx.measureText(txt).width;
      const capH = ctx.measureText("H").actualBoundingBoxAscent || px * 0.72;
      const rowH = Math.round(capH * 1.45);
      return { txt, i, px, w, capH, rowH };
    });

    const totalH = rows.reduce((a, r) => a + r.rowH, 0);
    let curY = (H - totalH) / 2;
    ctx.textBaseline = "alphabetic";
    ctx.textAlign = "center";

    // A stressed syllable shakes the whole frame for a moment (a function of t, so export matches).
    ctx.save();
    if (punch > 0.05) {
      const amp = short * 0.012 * punch;
      ctx.translate(Math.sin(t * 93) * amp, Math.cos(t * 71) * amp);
    }

    rows.forEach((r) => {
      const cy = curY + r.rowH / 2;
      curY += r.rowH;
      if (r.i > active) return;

      const wd = g.words[r.i];
      const dt = Math.max(0, t - wd.start);
      const p = Math.min(1, dt / 0.18);
      const spring = easeOutBack(p);
      const isCurrent = r.i === active;
      const scale = (1.42 - 0.42 * spring) * (isCurrent ? 1 + energy * 0.08 + punch * 0.1 : 1);
      const invertBand = isCurrent && (gi + r.i) % 2 === 1;

      ctx.save();
      ctx.translate(W / 2, cy);
      ctx.scale(scale, scale);
      ctx.font = css(r.px);
      // Centred on the capitals, as captions are, so a word with an İ does not sit lower.
      const ty = r.capH / 2;

      if (invertBand) {
        // The same height for every word of a size, with room for İ's dot and Ç's tail.
        const bandH = capBoxHalf(ctx, r.capH, r.px * 0.08) * 2;
        const bandW = Math.min(W * 0.88, r.w + r.px * 0.65);
        ctx.fillStyle = pal.accent;
        ctx.beginPath();
        ctx.roundRect(-bandW / 2, -bandH / 2, bandW, bandH, r.px * 0.14);
        ctx.fill();
        ctx.fillStyle = contrastText(pal.accent);
        ctx.fillText(r.txt, 0, ty);
      } else if (!isCurrent) {
        ctx.strokeStyle = pal.text;
        ctx.globalAlpha = 0.55;
        ctx.lineWidth = Math.max(2, r.px * 0.04);
        outlineText(ctx, r.txt, 0, ty);
      } else {
        if (punch > 0.15) {
          // Glitch: offset copies split off the word on a stressed syllable.
          const off = r.px * 0.06 * punch;
          ctx.save();
          ctx.globalAlpha = 0.75 * punch;
          ctx.fillStyle = pal.text;
          ctx.fillText(r.txt, -off, ty - off * 0.3);
          ctx.fillStyle = pal.muted;
          ctx.fillText(r.txt, off, ty + off * 0.3);
          ctx.restore();
        }
        ctx.shadowColor = "rgba(0, 0, 0, 0.6)";
        ctx.shadowBlur = r.px * 0.25;
        ctx.fillStyle = pal.accent;
        ctx.fillText(r.txt, 0, ty);
      }
      ctx.restore();
    });
    ctx.restore();
  }

  /**
   * "Maske": editorial mask reveal. The group is laid out once (so lines never
   * reflow), then each word's letters rise one after another from behind an
   * invisible line as it is spoken; a bar under the spoken word fills with its
   * duration. Before the next group the letters leave upwards the same way.
   */
  private drawMaskeScene(ctx: OffscreenCanvasRenderingContext2D, pal: KineticPalette, t: number, punch: number) {
    const gi = this.groupAt(this.posterGroups, t, 0.5);
    if (gi < 0) return;
    const g = this.posterGroups[gi];
    let active = 0;
    for (let i = 0; i < g.words.length && g.words[i].start <= t; i++) active = i;

    const { W, H, k } = this;
    const short = Math.min(W, H);
    const font = fontById(k.font);
    const css = (sz: number) => `${font.weight} ${Math.round(sz)}px ${captionStack(font.id)}`;
    const texts = g.words.map((w) =>
      hasDottedI(this.lang) ? w.text.toLocaleUpperCase(this.lang) : w.text.toUpperCase(),
    );

    const maxW = W * 0.8;
    let px = Math.max(16, Math.round(short * 0.12));
    ctx.font = css(px);
    const longest = Math.max(...texts.map((tx) => ctx.measureText(tx).width));
    if (longest > maxW) {
      px = Math.floor((px * maxW) / longest);
      ctx.font = css(px);
    }
    const widths = texts.map((tx) => ctx.measureText(tx).width);
    const space = px * 0.28;
    const lines = wrapWords(widths, space, maxW);

    const capH = ctx.measureText("H").actualBoundingBoxAscent || px * 0.72;
    const lineH = px * 1.14;
    const top = (H - lines.length * lineH) / 2;

    // Leave before the next group (or the end of the hold) takes the stage.
    const next = this.posterGroups[gi + 1];
    const until = Math.min(g.end + 0.5, next ? next.start : Infinity);
    const exitDur = Math.max(0.12, Math.min(0.3, until - g.end));
    const exitStart = until - exitDur;

    ctx.textBaseline = "alphabetic";
    ctx.textAlign = "left";
    lines.forEach((ln, li) => {
      const base = top + li * lineH + (lineH + capH) / 2;
      const total = ln.reduce((a, i, n) => a + widths[i] + (n ? space : 0), 0);
      let x = (W - total) / 2;

      ctx.save();
      // The mask: letters exist only inside their own line's band.
      ctx.beginPath();
      ctx.rect(0, base - lineH * 0.95, W, lineH * 1.2);
      ctx.clip();
      for (const wi of ln) {
        const wx = x;
        x += widths[wi] + space;
        if (wi > active) continue;
        const wd = g.words[wi];
        const chars = [...texts[wi]];
        const loud = this.loud.has(wd);
        ctx.font = css(px);
        ctx.fillStyle = loud ? pal.accent : pal.text;
        // Exit stagger is squeezed into exitDur, so the last letter is gone when the group changes.
        const leaveAt = (ci: number) => exitStart + exitDur * 0.45 * ((wi + ci / chars.length) / g.words.length);
        chars.forEach((ch, ci) => {
          const enter = easeOutExpo((t - wd.start + 0.04 - ci * 0.024) / 0.42);
          const leave = easeInCubic((t - leaveAt(ci)) / (exitDur * 0.55));
          if (enter <= 0 || leave >= 1) return;
          const cx = wx + (ci ? ctx.measureText(chars.slice(0, ci).join("")).width : 0);
          ctx.fillText(ch, cx, base + (1 - enter) * lineH - leave * lineH);
        });

        // The spoken word's bar fills over its duration; a punch thickens it.
        const exitY = -easeInCubic((t - leaveAt(0)) / (exitDur * 0.55)) * lineH;
        if (wi === active && exitY > -lineH) {
          const fill = Math.min(1, (t - wd.start) / Math.max(0.12, wd.end - wd.start));
          const barH = Math.max(2, px * 0.055 * (1 + punch * 0.9));
          ctx.fillStyle = pal.accent;
          ctx.fillRect(wx, base + px * 0.15 + exitY, widths[wi] * easeOutCubic(fill), barH);
        }
      }
      ctx.restore();
    });
  }

  /**
   * "Tünel": zoom-through, kept calm. Each step (a word, or two quick ones)
   * drifts in out of focus from the distance, sharpens as it lands and holds
   * while it is said, then grows past the camera only a little, blurring and
   * fading, as the next arrives. The voice moves the echo outlines and the
   * tunnel through the smoothed energy only, so nothing flickers.
   */
  private drawTunelScene(ctx: OffscreenCanvasRenderingContext2D, pal: KineticPalette, t: number, energy: number) {
    const { W, H, k } = this;
    const gs = this.tunelGroups;
    const short = Math.min(W, H);
    const font = fontById(k.font);
    const css = (sz: number) => `${font.weight} ${Math.round(sz)}px ${captionStack(font.id)}`;

    // Depth rings drifting outwards: the tunnel itself.
    ctx.save();
    ctx.strokeStyle = pal.muted;
    ctx.lineWidth = Math.max(1, short / 540);
    for (let n = 0; n < 7; n++) {
      const z = (n / 7 + t * 0.12) % 1;
      const s = 0.06 / (1.02 - z);
      ctx.globalAlpha = Math.min(1, z * 3) * (1 - z) * (0.45 + 0.35 * energy);
      const rw = W * s * 0.9;
      const rh = H * s * 0.9;
      ctx.beginPath();
      ctx.roundRect(W / 2 - rw / 2, H / 2 - rh / 2, rw, rh, short * s * 0.06);
      ctx.stroke();
    }
    ctx.restore();

    let ai = -1;
    for (let lo = 0, hi = gs.length - 1; lo <= hi; ) {
      const mid = (lo + hi) >> 1;
      if (gs[mid].start - TUNEL_ARRIVE / 2 <= t) {
        ai = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }

    const basePx = Math.round(short * 0.15);
    const blurMax = short * 0.018;
    ctx.textBaseline = "alphabetic";
    ctx.textAlign = "left";
    ctx.lineJoin = "round";

    // Far to near: the arriving step, the one being said, then the one leaving.
    for (let i = ai; i >= Math.max(0, ai - 2); i--) {
      const g = gs[i];
      const next = gs[i + 1];
      const leaveAt = Math.max(g.start + 0.15, next ? Math.min(next.start, g.end + 0.7) : g.end + 0.7);
      // Arrival straddles the step's start: faint while the previous one is still held.
      const ap = (t - (g.start - TUNEL_ARRIVE / 2)) / TUNEL_ARRIVE;
      const lp = (t - leaveAt) / 0.45;
      if (ap <= 0 || lp >= 1) continue;

      // Arriving: from small and soft to full size and sharp. Leaving: a little larger, softer, gone.
      let scale = 1;
      let alpha = 1;
      let blur = 0;
      if (lp > 0) {
        scale = 1 + 1.5 * lp * lp;
        alpha = 0.85 * (1 - lp) * (1 - lp);
        blur = blurMax * lp;
      } else if (ap < 1) {
        scale = 0.35 + 0.65 * easeOutCubic(ap);
        alpha = ap * ap;
        blur = blurMax * (1 - ap) * (1 - ap);
      }
      const landed = lp <= 0 && ap >= 1;

      const texts = g.words.map((w) =>
        hasDottedI(this.lang) ? w.text.toLocaleUpperCase(this.lang) : w.text.toUpperCase(),
      );
      const line = texts.join(" ");
      ctx.font = css(basePx);
      const px = Math.min(basePx, (basePx * W * 0.8) / Math.max(1, ctx.measureText(line).width));
      ctx.font = css(px);
      const lineW = ctx.measureText(line).width;
      const space = ctx.measureText(" ").width;
      const capH = ctx.measureText("H").actualBoundingBoxAscent || px * 0.72;
      const ty = capH / 2;
      const x0 = -lineW / 2;

      ctx.save();
      ctx.translate(W / 2, H / 2);
      // A slow sway for the whole tunnel, instead of a turn per word.
      ctx.rotate(0.02 * Math.sin(t * 0.4));
      ctx.scale(scale, scale);
      if (blur > 0.3) ctx.filter = `blur(${blur.toFixed(1)}px)`;

      if (landed) {
        // Echo outlines breathing out behind the line with the voice.
        ctx.strokeStyle = pal.text;
        ctx.lineWidth = Math.max(1, px * 0.016);
        for (let n = 1; n <= 3; n++) {
          const es = 1 + n * 0.06 * (0.5 + energy);
          ctx.save();
          ctx.globalAlpha = Math.min(0.22, (0.1 / n) * (0.6 + energy));
          ctx.scale(es, es);
          outlineText(ctx, line, x0, ty);
          ctx.restore();
        }
      }

      ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
      ctx.shadowColor = "rgba(0, 0, 0, 0.45)";
      ctx.shadowBlur = px * 0.2;
      // In a two-word step, the word being said is in the accent and the one still to come waits dimmed.
      let spoken = -1;
      for (let wi = 0; wi < g.words.length && g.words[wi].start <= t; wi++) spoken = wi;
      const lit = g.words.length > 1 && lp <= 0 ? spoken : -1;
      let x = x0;
      texts.forEach((tx, wi) => {
        const wd = g.words[wi];
        ctx.save();
        if (wi > spoken) ctx.globalAlpha *= 0.4;
        ctx.fillStyle = wi === lit || this.loud.has(wd) ? pal.accent : pal.text;
        ctx.fillText(tx, x, ty);
        ctx.restore();
        x += ctx.measureText(tx).width + space;
      });
      ctx.restore();
    }
  }
}
