// Rasterises the caption for a moment in time into a small canvas. Used by
// both the live preview (2D canvas over the <video>) and the WebGPU burn-in,
// so what you preview is what gets written into the video.

import type { Word } from "../engine";
import { buildCues, type Cue } from "../lib/cues";
import { captionFamily, fontById } from "./fonts";
import { presetById, type CaptionSettings, type Preset } from "./style";

export interface CaptionImage {
  source: OffscreenCanvas;
  /** Changes whenever the pixels change. */
  key: string;
  /** Placement in frame pixels, before scaling around the box centre. */
  x: number;
  y: number;
  w: number;
  h: number;
  scale: number;
  /** Frame size the caption was laid out for. */
  frameW: number;
  frameH: number;
}

const POP_IN = 0.16;
const easeOutBack = (x: number) => 1 + 2.2 * Math.pow(x - 1, 3) + 1.2 * Math.pow(x - 1, 2);

/** Readable text on top of an accent colour. */
function contrastText(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  const l = 0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255);
  return l > 150 ? "#111111" : "#ffffff";
}

let nextRendererId = 1;

export class CaptionRenderer {
  /** Part of every image key: a new renderer (new words or style) never reuses old pixels. */
  private readonly id = nextRendererId++;
  private preset: Preset;
  private groups: Cue[];
  private canvas = new OffscreenCanvas(8, 8);
  private cached: CaptionImage | null = null;

  constructor(
    words: Word[],
    private s: CaptionSettings,
    private W: number,
    private H: number,
  ) {
    this.preset = presetById(s.preset);
    this.groups = buildCues(words, this.preset.grouping);
  }

  /** Caption for time t (seconds), or null when nothing is on screen. */
  frame(t: number): CaptionImage | null {
    const gi = this.groupAt(t);
    if (gi < 0) return null;
    const g = this.groups[gi];
    let active = -1;
    for (let i = 0; i < g.words.length && g.words[i].start <= t; i++) active = i;
    // Effects without per-word state draw the same pixels for the whole group.
    const key = `${this.id}|${gi}|${this.preset.effect === "none" ? 0 : active}`;
    if (this.cached?.key !== key) this.cached = this.draw(g, active, key);
    const since = t - g.start;
    const scale = this.preset.pop && since < POP_IN ? 0.78 + 0.22 * easeOutBack(Math.max(0, since) / POP_IN) : 1;
    return { ...this.cached, scale };
  }

  private groupAt(t: number): number {
    const gs = this.groups;
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
    const holdMax = this.preset.effect === "none" ? 0.6 : 0.3;
    const until = Math.min(gs[i].end + holdMax, i + 1 < gs.length ? gs[i + 1].start : Infinity);
    return t < until ? i : -1;
  }

  private draw(g: Cue, active: number, key: string): CaptionImage {
    const { s, W, H, preset } = this;
    const font = fontById(s.font);
    const px = Math.max(10, Math.round(Math.min(W, H) * s.size));
    const fontCss = `${font.weight} ${px}px "${captionFamily(s.font)}"`;
    const ctx = this.canvas.getContext("2d")!;
    ctx.font = fontCss;

    const texts = g.words.map((w) => (s.uppercase ? w.text.toLocaleUpperCase("tr-TR") : w.text));
    const widths = texts.map((t) => ctx.measureText(t).width);
    const space = ctx.measureText(" ").width;
    const stroke = s.background === "outline" ? Math.max(2, px * 0.12) : 0;
    const wordPad = preset.effect === "box" ? px * 0.16 : 0;
    const padX = s.background === "box" ? px * 0.5 : stroke + px * 0.35 + wordPad;
    const padY = s.background === "box" ? px * 0.24 : stroke + px * 0.25;
    const lineH = Math.round(px * 1.24);

    // Greedy wrap into lines no wider than 86% of the frame.
    const maxW = W * 0.86 - padX * 2;
    const lines: number[][] = [[]];
    let lineW = 0;
    widths.forEach((w, i) => {
      const cur = lines[lines.length - 1];
      const add = (cur.length ? space + wordPad * 2 : 0) + w + wordPad * 2;
      if (cur.length && lineW + add > maxW) {
        lines.push([i]);
        lineW = w + wordPad * 2;
      } else {
        cur.push(i);
        lineW += add;
      }
    });
    const lineWidths = lines.map((l) => l.reduce((a, i, k) => a + widths[i] + wordPad * 2 + (k ? space : 0), 0));
    const w = Math.ceil(Math.max(...lineWidths) + padX * 2);
    const h = Math.ceil(lines.length * lineH + padY * 2);

    this.canvas.width = w;
    this.canvas.height = h;
    ctx.font = fontCss; // resizing resets the context
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";

    if (s.background === "box") {
      ctx.fillStyle = "rgba(10, 16, 22, 0.72)";
      ctx.beginPath();
      ctx.roundRect(0, 0, w, h, px * 0.22);
      ctx.fill();
    }

    lines.forEach((line, li) => {
      let x = (w - lineWidths[li]) / 2;
      const cy = padY + lineH * (li + 0.5);
      for (const i of line) {
        const isActive = i === active;
        let color = s.textColor;
        ctx.globalAlpha = preset.effect === "karaoke" && i > active ? 0.45 : 1;

        if (preset.effect === "box" && isActive) {
          ctx.fillStyle = s.accentColor;
          ctx.beginPath();
          ctx.roundRect(x, cy - lineH * 0.47, widths[i] + wordPad * 2, lineH * 0.94, px * 0.18);
          ctx.fill();
          color = contrastText(s.accentColor);
        } else if (preset.effect === "color" && isActive) {
          color = s.accentColor;
        }

        const tx = x + wordPad;
        const boxed = preset.effect === "box" && isActive;
        if (s.background === "outline" && !boxed) {
          ctx.strokeStyle = "rgba(0, 0, 0, 0.92)";
          ctx.lineWidth = stroke * 2;
          ctx.strokeText(texts[i], tx, cy);
        }
        if (s.background === "shadow") {
          ctx.shadowColor = "rgba(0, 0, 0, 0.75)";
          ctx.shadowBlur = px * 0.3;
          ctx.shadowOffsetY = px * 0.05;
        }
        ctx.fillStyle = color;
        ctx.fillText(texts[i], tx, cy);
        ctx.shadowColor = "transparent";
        x += widths[i] + wordPad * 2 + space;
      }
    });
    ctx.globalAlpha = 1;

    const margin = H > W ? 0.16 : 0.08; // keep clear of phone UI on vertical video
    const y = s.position === "top" ? H * margin : s.position === "middle" ? (H - h) / 2 : H * (1 - margin) - h;
    return { source: this.canvas, key, x: (W - w) / 2, y, w, h, scale: 1, frameW: W, frameH: H };
  }
}
