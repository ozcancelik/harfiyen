// Fonts the user adds from a file. They stay in this browser (IndexedDB),
// are shared by every project, and travel to the render worker with the job.
//
// When a font is added it is checked for Turkish: which of ç ğ ı İ ö ş ü it
// lacks, and whether its "i" has a dot at all (fonts with capitals only draw a
// dotless I for it, so their captions are always uppercased, see capsOnly).

import { useSyncExternalStore } from "react";
import { deleteFont, listFonts, saveFont, stripExt } from "../lib/projectStore";
import { addUserFont, removeUserFont, waitForUserFonts, type UserFont, type UserFontId } from "./fonts";

const TURKISH = "çÇğĞıİöÖşŞüÜ";
/** Font files above this are refused: every export copies the file to the worker. */
const MAX_BYTES = 20 * 1024 * 1024;

let state: { fonts: UserFont[]; ready: boolean } = { fonts: [], ready: false };
const subscribers = new Set<() => void>();

function publish(fonts: UserFont[]) {
  state = { fonts, ready: true };
  for (const f of subscribers) f();
}

waitForUserFonts(
  listFonts()
    .then((all) => {
      all.forEach(addUserFont);
      publish(all);
    })
    .catch(() => publish([])),
);

const subscribe = (f: () => void) => {
  subscribers.add(f);
  return () => void subscribers.delete(f);
};

/** The added fonts, oldest first; `ready` once storage has been read. */
export const useUserFonts = () => useSyncExternalStore(subscribe, () => state);

export const userFontById = (id: string) => state.fonts.find((f) => f.id === id) ?? null;

/** Check, store and register a font file. Throws with a message for the user. */
export async function addFontFile(file: File): Promise<UserFont> {
  if (file.size > MAX_BYTES) throw new Error("Yazı tipi dosyası çok büyük (20 MB üstü).");
  const data = await file.arrayBuffer();
  const font: UserFont = {
    id: `user:${crypto.randomUUID()}`,
    label: stripExt(file.name),
    data,
    ...(await inspect(data)),
    addedAt: Date.now(),
  };
  await saveFont(font);
  addUserFont(font);
  publish([...state.fonts, font]);
  return font;
}

export async function removeFont(id: UserFontId) {
  await deleteFont(id);
  removeUserFont(id);
  publish(state.fonts.filter((f) => f.id !== id));
}

let probes = 0;

async function inspect(data: ArrayBuffer): Promise<Pick<UserFont, "capsOnly" | "missing" | "weightRange">> {
  const family = `Harfiyen Probe ${++probes}`;
  // Declared as taking any weight, so a variable font follows the weight asked for and a static one is left alone.
  const face = new FontFace(family, data, { weight: "1 1000" });
  try {
    await face.load();
  } catch {
    throw new Error("Bu dosya yazı tipi olarak açılamadı (TTF, OTF, WOFF veya WOFF2 olmalı).");
  }
  document.fonts.add(face);
  try {
    const ctx = new OffscreenCanvas(256, 256).getContext("2d", { willReadFrequently: true })!;
    // A letter the font lacks falls back, so its width changes with the
    // fallback; one the font has is the same width whatever comes after it.
    const has = (c: string) =>
      new Set(
        ["monospace", "serif", "sans-serif"].map((fallback) => {
          ctx.font = `100px "${family}", ${fallback}`;
          return ctx.measureText(c).width;
        }),
      ).size === 1;
    if (![..."aeiAEI"].every(has)) throw new Error("Bu yazı tipinde Latin harfleri yok.");
    return { capsOnly: !dotted(ctx, family), missing: [...TURKISH].filter((c) => !has(c)).join(""), weightRange: weights(ctx, family) };
  } finally {
    document.fonts.delete(face);
  }
}

/**
 * "min max" when the font has a weight axis, else undefined: a static font is the same width at every weight,
 * a variable one changes until the ends of its axis.
 */
function weights(ctx: OffscreenCanvasRenderingContext2D, family: string): string | undefined {
  const at = (w: number) => {
    ctx.font = `${w} 100px "${family}", monospace`;
    return ctx.measureText("Hamburgefonstiv").width;
  };
  const steps = [100, 200, 300, 400, 500, 600, 700, 800, 900];
  const widths = steps.map(at);
  const same = (a: number, b: number) => Math.abs(a - b) < 0.01;
  // Weights below the axis's minimum look like it, as do those above its maximum.
  const lo = steps.filter((_, i) => same(widths[i], widths[0])).pop()!;
  const hi = steps.find((_, i) => same(widths[i], widths[8]))!;
  return hi > lo ? `${lo} ${hi}` : undefined;
}

/** Whether "i" is drawn as a dot above a stem: an empty row between inked ones. */
function dotted(ctx: OffscreenCanvasRenderingContext2D, family: string): boolean {
  const { width, height } = ctx.canvas;
  ctx.clearRect(0, 0, width, height);
  ctx.font = `160px "${family}"`;
  ctx.textBaseline = "alphabetic";
  ctx.fillText("i", 64, 200);
  const px = ctx.getImageData(0, 0, width, height).data;
  const inked = (y: number) => {
    for (let x = 0; x < width; x++) if (px[(y * width + x) * 4 + 3] > 96) return true;
    return false;
  };
  let seen = false;
  let gap = false;
  for (let y = 0; y < height; y++) {
    if (inked(y)) {
      if (gap) return true;
      seen = true;
    } else if (seen) gap = true;
  }
  return false;
}
