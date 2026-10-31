// Rasterises the caption for a moment in time into a small canvas. Used by
// both the live preview (2D canvas over the <video>) and the WebGPU burn-in,
// so what you preview is what gets written into the video.

import type { Word } from "../engine";
import { buildCues, type Cue } from "../lib/cues";
import { hasDottedI, TRANSCRIPT_LANG } from "../lib/lang";
import { speakerColor } from "../lib/speakers";
import { loudWords } from "./emphasis";
import { captionCss, captionStack, fontById, type CaptionFont } from "./fonts";
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
  /**
   * Frosted glass behind the caption: corner radius, and how far in from the
   * image's edges it starts (the image has room around it for blur, and the
   * speaker's name above it), in caption pixels.
   */
  panel: { radius: number; insetX: number; insetTop: number; insetBottom: number } | null;
  /** Frame size the caption was laid out for. */
  frameW: number;
  frameH: number;
}

const POP_IN = 0.16;
/** A word grows in over WORD_IN seconds (wordIn presets), redrawn in WORD_STEPS steps. */
const WORD_IN = 0.15;
const WORD_STEPS = 12;
/** Seconds a word takes to come out of blur ("focus" drifts up, "sharpen" shrinks into place). */
const FOCUS_IN = { focus: 0.3, sharpen: 0.35 };
/** Redraws per second while something moves: above any frame rate, so every frame differs. */
const LIVE_RATE = 240;
/** Size of a word said loudly ("Sesle vurgula"), relative to the others. */
const LOUD = 1.3;
/** Slant (tan of 12°) of an italic in a font that has none of its own. */
const SLANT = 0.2126;
const easeOutBack = (x: number) => 1 + 2.2 * Math.pow(x - 1, 3) + 1.2 * Math.pow(x - 1, 2);

/** Readable text on top of an accent colour. */
function contrastText(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  const l = 0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255);
  return l > 150 ? "#111111" : "#ffffff";
}

/** The speaker's name above a caption, laid out (caption pixels). */
interface TagLayout {
  text: string;
  speaker: number;
  css: string;
  px: number;
  w: number;
  h: number;
  padX: number;
  dot: number;
  gap: number;
  stroke: number;
  /** On a pill of its own (box and glass looks); else bare, outlined or shadowed like the words. */
  pill: boolean;
  /** Room between it and the caption below. */
  space: number;
}

let nextRendererId = 1;

export class CaptionRenderer {
  /** Part of every image key: a new renderer (new words or style) never reuses old pixels. */
  private readonly id = nextRendererId++;
  private preset: Preset;
  private groups: Cue[];
  private canvas = new OffscreenCanvas(8, 8);
  private cached: CaptionImage | null = null;
  /** Words said louder than those around them, drawn larger. */
  private loud: Set<Word>;
  /** Per group, the speaker whose name goes above it (the first caption of their turn), or -1. */
  private tags: number[];

  constructor(
    words: Word[],
    private s: CaptionSettings,
    private W: number,
    private H: number,
    /** Speech loudness (BandTracker.takeLoudness), for "Sesle vurgula"; null without it. */
    loudness: Float32Array | null = null,
    /** Language of the words; decides how they are uppercased. */
    private lang: string = TRANSCRIPT_LANG,
    /** The speakers' names to show (the words carry `speaker`); null not to. One speaker needs no name. */
    private speakers: string[] | null = null,
  ) {
    this.preset = presetById(s.preset);
    this.groups = buildCues(words, this.preset.grouping);
    this.loud = s.voiceEmphasis && loudness ? loudWords(words, loudness) : new Set();
    // Groups break where the speaker changes, so a group has one; the name shows where they take over.
    const named = speakers && speakers.length > 1;
    const speakerOf = (g: Cue | undefined) => g?.words[0]?.speaker;
    this.tags = this.groups.map((g, i) => {
      const sp = speakerOf(g);
      return named && sp !== undefined && sp < speakers.length && speakerOf(this.groups[i - 1]) !== sp ? sp : -1;
    });
  }

  /** Caption for time t (seconds), or null when nothing is on screen. */
  frame(t: number): CaptionImage | null {
    if (this.s.hidden) return null;
    const gi = this.groupAt(t);
    if (gi < 0) return null;
    const g = this.groups[gi];
    let active = -1;
    for (let i = 0; i < g.words.length && g.words[i].start <= t; i++) active = i;
    // Only the growing word changes between frames, in fixed steps.
    const step =
      this.preset.wordIn === "grow"
        ? Math.min(WORD_STEPS, Math.floor(((t - g.words[active].start) / WORD_IN) * WORD_STEPS))
        : WORD_STEPS;
    // Words coming into focus (several when speech is quick) and a filling
    // word change on every frame.
    const { wordIn, effect } = this.preset;
    const moving =
      (wordIn === "focus" || wordIn === "sharpen"
        ? g.words.some((w) => t >= w.start && t - w.start < FOCUS_IN[wordIn])
        : false) ||
      (effect === "fill" && g.words.some((w) => t >= w.start && t < w.end));
    const live = moving ? Math.floor(t * LIVE_RATE) : -1;
    // Effects without per-word state draw the same pixels for the whole group.
    const key = `${this.id}|${gi}|${effect === "none" ? 0 : active}|${step}|${live}`;
    if (this.cached?.key !== key) this.cached = this.draw(g, active, step / WORD_STEPS, t, key, this.tags[gi]);
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

  /**
   * grow: how far the active word has grown in, 0..1 (1 without wordIn); t: the time, for words that move;
   * speaker: whose name goes above the caption, or -1.
   */
  private draw(g: Cue, active: number, grow: number, t: number, key: string, speaker: number): CaptionImage {
    const { s, W, H, preset } = this;
    const font = fontById(s.font);
    const upper = s.uppercase || (font.capsOnly && hasDottedI(this.lang));
    const texts = g.words.map((w) => (upper ? w.text.toLocaleUpperCase(this.lang) : w.text));
    // Each word's size relative to px (loud words are larger).
    const size = g.words.map((w) => (this.loud.has(w) ? LOUD : 1));
    const css = (size: number) => captionCss(font, size, { weight: s.weight, italic: s.italic });
    // A font without an italic of its own is slanted as it is drawn.
    const slant = !!s.italic && !font.italicFiles;
    const ctx = this.canvas.getContext("2d")!;
    // Space between letters, in em; the canvas must support it (letterSpacing).
    const track = "letterSpacing" in ctx ? (s.tracking ?? 0) : 0;
    // Set along with the font (resizing the canvas resets both). A word's width counts the space after its last letter too.
    const setFont = (size: number) => {
      ctx.font = css(size);
      if (track) ctx.letterSpacing = `${track * size}px`;
    };
    const wordWidth = (t: string, size: number) => ctx.measureText(t).width - track * size;
    let px = Math.max(10, Math.round(Math.min(W, H) * s.size));
    // Lines wrap between words only: shrink until the longest word fits the
    // frame (padding scales with the font, so one step is enough).
    setFont(px);
    const longest = Math.max(...texts.map((t, i) => wordWidth(t, px) * size[i]));
    // Both sides' padX, stroke and word box, in units of px (see below).
    const pads =
      (s.background === "box" ? 1 : s.background === "glass" ? 1.2 : 0.7) +
      (s.background === "outline" ? 0.24 : 0) +
      (preset.effect === "box" ? 0.64 : 0);
    const need = longest + px * pads;
    if (need > W * 0.86) px = Math.max(10, Math.floor((px * W * 0.86) / need));
    setFont(px);

    // Text widths grow with the font size, so larger words are measured at px and scaled.
    const widths = texts.map((t, i) => wordWidth(t, px) * size[i]);
    const space = ctx.measureText(" ").width;
    const stroke = s.background === "outline" ? Math.max(2, px * 0.12) : 0;
    const wordPad = preset.effect === "box" ? px * 0.16 : 0;
    const padX = s.background === "box" ? px * 0.5 : s.background === "glass" ? px * 0.6 : stroke + px * 0.35 + wordPad;
    const padY = s.background === "box" ? px * 0.24 : s.background === "glass" ? px * 0.3 : stroke + px * 0.25;
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
    // A line with a larger word is taller.
    const lineHs = lines.map((l) => Math.round(lineH * Math.max(...l.map((i) => size[i]))));
    const lineTops = lineHs.map((_, li) => padY + lineHs.slice(0, li).reduce((a, v) => a + v, 0));
    const w = Math.ceil(Math.max(...lineWidths) + padX * 2);
    const h = Math.ceil(lineHs.reduce((a, v) => a + v, 0) + padY * 2);
    // Clear room around the caption so blur and growth are not cut at the
    // image's edges; the caption itself (and its box) stays w x h.
    const blurs = preset.wordIn === "focus" || preset.wordIn === "sharpen";
    const grows = preset.wordIn === "sharpen" ? 0.15 : 0;
    // A slanted word leans out to the right at the top.
    const leanX = slant ? Math.ceil(px * 0.25 * Math.max(...size)) : 0;
    const bleedX = Math.max(leanX, blurs ? Math.ceil(px * 0.6 + (Math.max(...lineWidths) * grows) / 2) : 0);
    const bleedY = blurs ? Math.ceil(px * 0.6 + (Math.max(...lineHs) * grows) / 2) : 0;
    // The name sits above the caption, both centred; the image is as wide as the wider.
    const tag = speaker >= 0 ? this.tagLayout(ctx, speaker, px, font, !!upper) : null;
    const top = tag ? tag.h + tag.space : 0;
    // Widened evenly, so the caption stays whole pixels in from both sides (the glass assumes it).
    const ox = Math.ceil(Math.max(0, (tag?.w ?? 0) - w) / 2);
    const cw = w + ox * 2;

    this.canvas.width = cw + bleedX * 2;
    this.canvas.height = h + top + bleedY * 2;
    ctx.translate(bleedX + ox, bleedY + top);
    setFont(px); // resizing resets the context
    // "middle" centres the font's em box, which leaves capitals sitting low
    // (the room below is for descenders). Centre the capital height instead,
    // measured from the font itself so it holds for any font.
    ctx.textBaseline = "alphabetic";
    const capH = ctx.measureText("H").actualBoundingBoxAscent;
    ctx.lineJoin = "round";

    if (s.background === "box") {
      ctx.fillStyle = "rgba(10, 16, 22, 0.72)";
      ctx.beginPath();
      ctx.roundRect(0, 0, w, h, px * 0.22);
      ctx.fill();
    }

    lines.forEach((line, li) => {
      let x = (w - lineWidths[li]) / 2;
      const lh = lineHs[li];
      const cy = lineTops[li] + lh / 2;
      for (const i of line) {
        if (preset.effect === "reveal" && i > active) {
          x += widths[i] + wordPad * 2 + space;
          continue;
        }
        const isActive = i === active;
        let color = s.textColor;
        ctx.globalAlpha = preset.effect === "karaoke" && i > active ? 0.45 : 1;
        ctx.save();
        if (size[i] !== 1) setFont(px * size[i]);
        // A loud word takes the accent; with "fill" the accent is the fill, so only its size changes.
        if (size[i] !== 1 && preset.effect !== "fill") color = s.accentColor;
        if (isActive && grow < 1) {
          const e = 1 - Math.pow(1 - grow, 3);
          const k = 0.8 + 0.2 * e;
          const cx = x + wordPad + widths[i] / 2;
          ctx.globalAlpha *= e;
          ctx.translate(cx, cy);
          ctx.scale(k, k);
          ctx.translate(-cx, -cy);
        }
        if (preset.wordIn === "focus" || preset.wordIn === "sharpen") {
          // Blurred and faint at first, sharp in place after FOCUS_IN: "focus"
          // rises a little, "sharpen" starts larger and settles.
          const p = Math.min(1, Math.max(0, (t - g.words[i].start) / FOCUS_IN[preset.wordIn]));
          if (p < 1) {
            const e = 1 - Math.pow(1 - p, 3);
            ctx.globalAlpha *= e;
            if (preset.wordIn === "focus") ctx.translate(0, (1 - e) * px * 0.3);
            else {
              const k = 1 + grows * (1 - e);
              const cx = x + wordPad + widths[i] / 2;
              ctx.translate(cx, cy);
              ctx.scale(k, k);
              ctx.translate(-cx, -cy);
            }
            const blur = (1 - e) * px * (preset.wordIn === "focus" ? 0.35 : 0.5);
            if (blur > 0.05) ctx.filter = `blur(${blur.toFixed(2)}px)`;
          }
        }

        if (preset.effect === "box" && isActive) {
          ctx.fillStyle = s.accentColor;
          ctx.beginPath();
          ctx.roundRect(x, cy - lh * 0.47, widths[i] + wordPad * 2, lh * 0.94, px * 0.18);
          ctx.fill();
          color = contrastText(s.accentColor);
        } else if (preset.effect === "color" && isActive) {
          color = s.accentColor;
        }

        const tx = x + wordPad;
        const ty = cy + (capH * size[i]) / 2;
        const boxed = preset.effect === "box" && isActive;
        if (slant) {
          // Leaning about the baseline, and moved back so the word stays centred where it was.
          ctx.translate((-SLANT * capH * size[i]) / 2, ty);
          ctx.transform(1, 0, -SLANT, 1, 0, 0);
          ctx.translate(0, -ty);
        }
        if (s.background === "outline" && !boxed) {
          ctx.strokeStyle = "rgba(0, 0, 0, 0.92)";
          ctx.lineWidth = stroke * 2 * size[i];
          ctx.strokeText(texts[i], tx, ty);
        }
        if (s.background === "shadow") {
          ctx.shadowColor = "rgba(0, 0, 0, 0.75)";
          ctx.shadowBlur = px * 0.3;
          ctx.shadowOffsetY = px * 0.05;
        } else if (s.background === "glass" && !boxed) {
          // Just enough to lift the text off bright glass.
          ctx.shadowColor = "rgba(0, 0, 0, 0.35)";
          ctx.shadowBlur = px * 0.12;
          ctx.shadowOffsetY = px * 0.03;
        }
        ctx.fillStyle = color;
        ctx.fillText(texts[i], tx, ty);
        if (preset.effect === "fill" && i <= active) {
          // The accent fills the word left to right while it is spoken.
          const wd = g.words[i];
          const p = wd.end > wd.start ? Math.min(1, Math.max(0, (t - wd.start) / (wd.end - wd.start))) : 1;
          if (p > 0) {
            ctx.save();
            ctx.beginPath();
            ctx.rect(tx, cy - lh, widths[i] * p, lh * 2);
            ctx.clip();
            ctx.shadowColor = "transparent"; // the white pass already cast it
            ctx.fillStyle = s.accentColor;
            ctx.fillText(texts[i], tx, ty);
            ctx.restore();
          }
        }
        ctx.restore();
        x += widths[i] + wordPad * 2 + space;
      }
    });
    ctx.globalAlpha = 1;
    if (tag) {
      ctx.setTransform(1, 0, 0, 1, bleedX + Math.round((cw - tag.w) / 2), bleedY);
      this.drawTag(ctx, tag);
    }

    // The caption stays where it would be without the name; the name goes above it.
    const margin = H > W ? 0.16 : 0.08; // keep clear of phone UI on vertical video
    const y = s.position === "top" ? H * margin : s.position === "middle" ? (H - h) / 2 : H * (1 - margin) - h;
    return {
      source: this.canvas,
      key,
      x: (W - cw) / 2 - bleedX,
      y: y - top - bleedY,
      w: cw + bleedX * 2,
      h: h + top + bleedY * 2,
      scale: 1,
      panel:
        s.background === "glass" ? { radius: px * 0.32, insetX: bleedX + ox, insetTop: bleedY + top, insetBottom: bleedY } : null,
      frameW: W,
      frameH: H,
    };
  }

  /** The speaker's name at about half the caption's size, with a dot in their colour. */
  private tagLayout(ctx: OffscreenCanvasRenderingContext2D, speaker: number, px: number, font: CaptionFont, upper: boolean): TagLayout {
    const { s, W } = this;
    const tp = Math.max(9, Math.round(px * 0.48));
    const css = `${font.weight} ${tp}px ${captionStack(font.id)}`;
    const pill = s.background === "box" || s.background === "glass";
    const stroke = s.background === "outline" ? Math.max(1.5, tp * 0.12) : 0;
    const padX = pill ? tp * 0.6 : stroke + tp * 0.3;
    const padY = pill ? tp * 0.3 : stroke + tp * 0.15;
    const dot = Math.round(tp * 0.55);
    const gap = tp * 0.45;
    ctx.font = css;
    if ("letterSpacing" in ctx) ctx.letterSpacing = "0px"; // the name is set tight, whatever the captions are
    let text = this.speakers![speaker];
    if (upper) text = text.toLocaleUpperCase(this.lang);
    const max = W * 0.86 - padX * 2 - dot - gap;
    // A long name is cut to fit the frame.
    if (ctx.measureText(text).width > max) {
      while (text.length > 1 && ctx.measureText(`${text}…`).width > max) text = text.slice(0, -1);
      text = `${text.trimEnd()}…`;
    }
    return {
      text,
      speaker,
      css,
      px: tp,
      w: Math.ceil(padX * 2 + dot + gap + ctx.measureText(text).width),
      h: Math.ceil(tp * 1.2 + padY * 2),
      padX,
      dot,
      gap,
      stroke,
      pill,
      space: Math.round(px * (pill ? 0.16 : 0.06)),
    };
  }

  /** The name drawn at 0, 0 in the caption's own look: its box or glass, its outline or shadow. */
  private drawTag(ctx: OffscreenCanvasRenderingContext2D, L: TagLayout) {
    const { s } = this;
    ctx.save();
    ctx.font = L.css;
    if ("letterSpacing" in ctx) ctx.letterSpacing = "0px";
    ctx.textBaseline = "alphabetic";
    ctx.lineJoin = "round";
    if (L.pill) {
      // Glass has no blur of its own here: a lighter tint of the box instead.
      ctx.fillStyle = s.background === "box" ? "rgba(10, 16, 22, 0.72)" : "rgba(10, 16, 22, 0.42)";
      ctx.beginPath();
      ctx.roundRect(0, 0, L.w, L.h, L.h * (s.background === "box" ? 0.3 : 0.5));
      ctx.fill();
    }
    if (s.background === "shadow") {
      ctx.shadowColor = "rgba(0, 0, 0, 0.75)";
      ctx.shadowBlur = L.px * 0.3;
      ctx.shadowOffsetY = L.px * 0.05;
    } else if (s.background === "glass") {
      ctx.shadowColor = "rgba(0, 0, 0, 0.35)";
      ctx.shadowBlur = L.px * 0.12;
      ctx.shadowOffsetY = L.px * 0.03;
    }
    const cy = L.h / 2;
    const r = L.dot / 2;
    ctx.beginPath();
    ctx.arc(L.padX + r, cy, r, 0, Math.PI * 2);
    if (L.stroke) {
      ctx.strokeStyle = "rgba(0, 0, 0, 0.92)";
      ctx.lineWidth = L.stroke * 2;
      ctx.stroke();
    }
    ctx.fillStyle = speakerColor(L.speaker);
    ctx.fill();
    const tx = L.padX + L.dot + L.gap;
    const ty = cy + ctx.measureText("H").actualBoundingBoxAscent / 2;
    if (L.stroke) {
      ctx.strokeStyle = "rgba(0, 0, 0, 0.92)";
      ctx.lineWidth = L.stroke * 2;
      ctx.strokeText(L.text, tx, ty);
    }
    ctx.globalAlpha = 0.92;
    ctx.fillStyle = s.textColor;
    ctx.fillText(L.text, tx, ty);
    ctx.restore();
  }
}
