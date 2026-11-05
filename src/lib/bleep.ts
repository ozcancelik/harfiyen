// Censoring: a word picked in the transcript is replaced by a bleep (the voice is gone, not mixed under it).
// Times stay the file's everywhere, as with the cuts: the player and the exports both look the ranges up in it.

import type { Word } from "../engine";
import type { TimeRange } from "./useTranscriber";

/** The tone's pitch, Hz. */
export const BLEEP_HZ = 1000;
/** The tone's level against full scale; speech sits well above it, so the bleep is heard without being harsh. */
export const BLEEP_LEVEL = 0.22;
/**
 * Extra time bleeped on each side of the word. Recognised word times run a little off, and without it the first
 * or last sound of the word gets through.
 */
export const BLEEP_PAD = 0.07;
/** The tone fades in and out over this, seconds, so it does not click. */
const FADE = 0.006;

/** Bleeps the word at `indices`, or takes them off (toggles when `force` is omitted: off if all are bleeped). */
export function toggleWordsBleep(words: Word[], indices: number[], force?: boolean): Word[] {
  const set = new Set(indices.filter((i) => i >= 0 && i < words.length));
  if (!set.size) return words;
  const on = force ?? ![...set].every((i) => words[i].bleep === true);
  let changed = false;
  const out = words.map((w, i) => {
    if (!set.has(i) || (w.bleep === true) === on) return w;
    changed = true;
    if (on) return { ...w, bleep: true as const };
    const { bleep: _, ...rest } = w;
    return rest;
  });
  return changed ? out : words;
}

/** Takes the bleep off every word. */
export function clearBleeps(words: Word[]): Word[] {
  if (!words.some((w) => w.bleep)) return words;
  return words.map(({ bleep: _, ...w }) => w);
}

/** The stretches to bleep, sorted and joined where they touch, in file time. Words that are cut are not in it. */
export function bleepRanges(words: Word[]): TimeRange[] {
  const out: TimeRange[] = [];
  for (const w of words) {
    if (!w.bleep || w.cut === true) continue;
    const start = Math.max(0, w.start - BLEEP_PAD);
    const end = w.end + BLEEP_PAD;
    const last = out.at(-1);
    if (last && start <= last.end) last.end = Math.max(last.end, end);
    else out.push({ start, end });
  }
  return out;
}

/** Whether `t` is in one of the (sorted) ranges. */
export function inBleep(ranges: TimeRange[], t: number): boolean {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ranges[mid].end <= t) lo = mid + 1;
    else if (ranges[mid].start > t) hi = mid - 1;
    else return true;
  }
  return false;
}

/**
 * Puts the bleep over the audio in place: `planes` (one array per channel) begin at `from` seconds of the file at
 * `rate`. The tone's phase goes by the file's time, so it stays whole across the pieces the audio comes in.
 * Returns whether anything was changed.
 */
export function bleepPlanes(planes: Float32Array[], from: number, rate: number, ranges: TimeRange[]): boolean {
  const n = planes[0]?.length ?? 0;
  if (!n || !ranges.length) return false;
  const to = from + n / rate;
  let changed = false;
  for (const r of ranges) {
    if (r.end <= from) continue;
    if (r.start >= to) break;
    const i0 = Math.max(0, Math.ceil((r.start - from) * rate));
    const i1 = Math.min(n, Math.ceil((r.end - from) * rate));
    for (let i = i0; i < i1; i++) {
      const t = from + i / rate;
      const edge = Math.min(1, (t - r.start) / FADE, (r.end - t) / FADE);
      const tone = Math.sin(2 * Math.PI * BLEEP_HZ * t) * BLEEP_LEVEL * Math.max(0, edge);
      for (const p of planes) p[i] = tone;
    }
    changed = true;
  }
  return changed;
}

/** A bleeped word as the captions show it: its first letter and a star for each of the rest ("s****"). */
export function maskText(text: string): string {
  let seen = false;
  return text.replace(/\p{L}|\p{N}/gu, (c) => {
    if (seen) return "*";
    seen = true;
    return c;
  });
}

/** The words with every bleeped one masked, for captions. */
export function maskBleeped(words: Word[]): Word[] {
  if (!words.some((w) => w.bleep)) return words;
  return words.map((w) => (w.bleep ? { ...w, text: maskText(w.text) } : w));
}

/**
 * What the captions do with a bleeped word: stars ("s****"), a mosaic or a bar drawn over it, leave it
 * out, or show it as it is (only the sound is bleeped).
 */
export type Censor = "stars" | "blur" | "bar" | "hide" | "off";

/** What the censored word's place is drawn over: the letters give only the width, the word itself never reaches the picture. */
const placeholder = (text: string) => text.replace(/\p{L}|\p{N}/gu, "o");

/**
 * The words as the captions get them. `drawn`: they are drawn as pictures (the caption renderer, which paints the
 * mosaic or bar over a bleeped word, found by its `bleep`); else they are text (subtitle files), where
 * those two come out as stars.
 */
export function censorWords(words: Word[], mode: Censor, drawn = true): Word[] {
  if (mode === "off" || !words.some((w) => w.bleep)) return words;
  if (mode === "hide") return words.filter((w) => !w.bleep);
  if ((mode === "blur" || mode === "bar") && drawn) {
    return words.map((w) => (w.bleep ? { ...w, text: placeholder(w.text) } : w));
  }
  return maskBleeped(words);
}

/**
 * The bleep for the live player: a tone that is gated on and off with the playhead. The player turns the
 * file's own sound down while it is on. Created on first use (a gesture has happened by then: playback).
 */
export class Beeper {
  private ctx: AudioContext | null = null;
  private gain: GainNode | null = null;

  /** Sounds the tone at `level` (0 to 1) of its full volume, or silences it with 0. */
  set(level: number) {
    if (!this.ctx) {
      if (level <= 0) return;
      try {
        this.ctx = new AudioContext();
        const osc = this.ctx.createOscillator();
        osc.frequency.value = BLEEP_HZ;
        this.gain = this.ctx.createGain();
        this.gain.gain.value = 0;
        osc.connect(this.gain).connect(this.ctx.destination);
        osc.start();
      } catch {
        // No Web Audio: the voice is only silenced.
        this.ctx = null;
        return;
      }
    }
    if (this.ctx.state === "suspended") void this.ctx.resume().catch(() => {});
    this.gain!.gain.setTargetAtTime(level * BLEEP_LEVEL, this.ctx.currentTime, FADE / 2);
  }

  close() {
    void this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.gain = null;
  }
}
