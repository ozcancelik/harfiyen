// Caption fonts. Every font ships its latin and latin-ext subsets, so Turkish
// (ğ ş ı İ ç ö ü) always renders with the real glyphs, never a fallback.
// Fonts are registered under our own family names from the bundled files, so
// the on-screen preview and the WebGPU render use exactly the same font.
// Fonts the user adds (userFonts.ts) are registered here too, from their bytes.

import gsflexExt from "@fontsource-variable/google-sans-flex/files/google-sans-flex-latin-ext-wght-normal.woff2?url";
import gsflex from "@fontsource-variable/google-sans-flex/files/google-sans-flex-latin-wght-normal.woff2?url";
import antonExt from "@fontsource/anton/files/anton-latin-ext-400-normal.woff2?url";
import anton from "@fontsource/anton/files/anton-latin-400-normal.woff2?url";
import bangersExt from "@fontsource/bangers/files/bangers-latin-ext-400-normal.woff2?url";
import bangers from "@fontsource/bangers/files/bangers-latin-400-normal.woff2?url";
import bebasExt from "@fontsource/bebas-neue/files/bebas-neue-latin-ext-400-normal.woff2?url";
import bebas from "@fontsource/bebas-neue/files/bebas-neue-latin-400-normal.woff2?url";
import luckiestExt from "@fontsource/luckiest-guy/files/luckiest-guy-latin-ext-400-normal.woff2?url";
import luckiest from "@fontsource/luckiest-guy/files/luckiest-guy-latin-400-normal.woff2?url";
import poppinsExt from "@fontsource/poppins/files/poppins-latin-ext-800-normal.woff2?url";
import poppins from "@fontsource/poppins/files/poppins-latin-800-normal.woff2?url";
import interExt from "@fontsource-variable/inter/files/inter-latin-ext-wght-normal.woff2?url";
import inter from "@fontsource-variable/inter/files/inter-latin-wght-normal.woff2?url";
import literataExt from "@fontsource-variable/literata/files/literata-latin-ext-wght-normal.woff2?url";
import literata from "@fontsource-variable/literata/files/literata-latin-wght-normal.woff2?url";
import montserratExt from "@fontsource-variable/montserrat/files/montserrat-latin-ext-wght-normal.woff2?url";
import montserrat from "@fontsource-variable/montserrat/files/montserrat-latin-wght-normal.woff2?url";
import schibstedExt from "@fontsource-variable/schibsted-grotesk/files/schibsted-grotesk-latin-ext-wght-normal.woff2?url";
import schibsted from "@fontsource-variable/schibsted-grotesk/files/schibsted-grotesk-latin-wght-normal.woff2?url";

import interItalicExt from "@fontsource-variable/inter/files/inter-latin-ext-wght-italic.woff2?url";
import interItalic from "@fontsource-variable/inter/files/inter-latin-wght-italic.woff2?url";
import literataItalicExt from "@fontsource-variable/literata/files/literata-latin-ext-wght-italic.woff2?url";
import literataItalic from "@fontsource-variable/literata/files/literata-latin-wght-italic.woff2?url";
import montserratItalicExt from "@fontsource-variable/montserrat/files/montserrat-latin-ext-wght-italic.woff2?url";
import montserratItalic from "@fontsource-variable/montserrat/files/montserrat-latin-wght-italic.woff2?url";
import schibstedItalicExt from "@fontsource-variable/schibsted-grotesk/files/schibsted-grotesk-latin-ext-wght-italic.woff2?url";
import schibstedItalic from "@fontsource-variable/schibsted-grotesk/files/schibsted-grotesk-latin-wght-italic.woff2?url";
import poppinsItalicExt from "@fontsource/poppins/files/poppins-latin-ext-800-italic.woff2?url";
import poppinsItalic from "@fontsource/poppins/files/poppins-latin-800-italic.woff2?url";

export type BuiltinFontId =
  | "gsflex"
  | "montserrat"
  | "poppins"
  | "inter"
  | "anton"
  | "bebas"
  | "bangers"
  | "luckiest"
  | "schibsted"
  | "literata";

export type UserFontId = `user:${string}`;
export type FontId = BuiltinFontId | UserFontId;

/** A font the user added, as stored in IndexedDB and sent to the render worker. */
export interface UserFont {
  id: UserFontId;
  label: string;
  data: ArrayBuffer;
  /** See CaptionFont.capsOnly; detected when the font is added. */
  capsOnly: boolean;
  /** "min max" when the file is a variable font with a weight axis; missing otherwise (and in fonts added before this). */
  weightRange?: string;
  /** Turkish letters the font lacks (they render in a fallback font). */
  missing: string;
  addedAt: number;
}

export interface CaptionFont {
  id: FontId;
  label: string;
  /** Weight used for captions. */
  weight: number;
  /** Weight range of the file (variable fonts) or the single static weight. */
  weightRange?: string;
  /** Bundled fonts: the [latin, latin-ext] files. */
  files?: string[];
  /** The same files in italic, for the fonts that have a real italic; without them italics are slanted by the renderer. */
  italicFiles?: string[];
  /** User fonts: the font file itself, at its default weight. */
  data?: ArrayBuffer;
  /** Lowercase letters are drawn as capitals, so a dotless "I" stands in for
   *  "i" and Turkish "bir" reads "bır". In languages with a dotted i the
   *  captions are always uppercased (i → İ, ı → I); see hasDottedI. */
  capsOnly?: boolean;
}

export const FONTS: CaptionFont[] = [
  { id: "gsflex", label: "Google Sans Flex", weight: 760, weightRange: "1 1000", files: [gsflex, gsflexExt] },
  { id: "montserrat", label: "Montserrat", weight: 800, weightRange: "100 900", files: [montserrat, montserratExt], italicFiles: [montserratItalic, montserratItalicExt] },
  { id: "poppins", label: "Poppins", weight: 800, weightRange: "800", files: [poppins, poppinsExt], italicFiles: [poppinsItalic, poppinsItalicExt] },
  { id: "inter", label: "Inter", weight: 650, weightRange: "100 900", files: [inter, interExt], italicFiles: [interItalic, interItalicExt] },
  { id: "anton", label: "Anton", weight: 400, weightRange: "400", files: [anton, antonExt] },
  { id: "bebas", label: "Bebas Neue", weight: 400, weightRange: "400", files: [bebas, bebasExt], capsOnly: true },
  { id: "bangers", label: "Bangers", weight: 400, weightRange: "400", files: [bangers, bangersExt], capsOnly: true },
  { id: "luckiest", label: "Luckiest Guy", weight: 400, weightRange: "400", files: [luckiest, luckiestExt], capsOnly: true },
  { id: "schibsted", label: "Schibsted Grotesk", weight: 650, weightRange: "400 900", files: [schibsted, schibstedExt], italicFiles: [schibstedItalic, schibstedItalicExt] },
  { id: "literata", label: "Literata", weight: 600, weightRange: "200 900", files: [literata, literataExt], italicFiles: [literataItalic, literataItalicExt] },
];

const userFonts = new Map<FontId, CaptionFont>();

export const isUserFont = (id: FontId): id is UserFontId => id.startsWith("user:");

/** Make a user font known (main thread from storage, the worker from its job). */
export function addUserFont(u: UserFont) {
  userFonts.set(u.id, { id: u.id, label: u.label, weight: 400, weightRange: u.weightRange, data: u.data, capsOnly: u.capsOnly });
}

export const removeUserFont = (id: UserFontId) => userFonts.delete(id);

export const hasFont = (id: FontId) => FONTS.some((f) => f.id === id) || userFonts.has(id);

/** A font that is not here (a deleted user font) falls back to the first one. */
export const fontById = (id: FontId) => FONTS.find((f) => f.id === id) ?? userFonts.get(id) ?? FONTS[0];

let userFontsReady: Promise<unknown> = Promise.resolve();
/** Main thread: user fonts load from storage; loading one waits for that. */
export const waitForUserFonts = (p: Promise<unknown>) => (userFontsReady = p);

/** The weights a font can be set to (its variable axis), or null when it has just one. */
export function weightBounds(f: CaptionFont): [number, number] | null {
  const [lo, hi] = (f.weightRange ?? "").split(" ").map(Number);
  return lo && hi && hi > lo ? [Math.max(100, lo), Math.min(900, hi)] : null;
}

/** The weight captions are drawn in: the one asked for if the font can do it, else its own. */
export function captionWeight(f: CaptionFont, asked?: number): number {
  const b = weightBounds(f);
  return b && asked ? Math.min(b[1], Math.max(b[0], asked)) : f.weight;
}

/** CSS font shorthand for a caption font. Without a real italic file the text is upright here and slanted by the renderer. */
export function captionCss(f: CaptionFont, px: number, o: { weight?: number; italic?: boolean } = {}): string {
  const style = o.italic && f.italicFiles ? "italic " : "";
  return `${style}${captionWeight(f, o.weight)} ${px}px ${captionStack(f.id)}`;
}

/** CSS family name the caption renderer uses for a font. */
export const captionFamily = (id: FontId) => `Harfiyen Caption ${id}`;

/** Letters a user font lacks (often ğ ş İ ı) come from the first bundled font, not the browser's serif. */
const FALLBACK = FONTS[0].id;

/** CSS font-family list for a font, with that fallback. */
export const captionStack = (id: FontId) => `"${captionFamily(id)}", "${captionFamily(FALLBACK)}"`;

// Subset ranges from fontsource; files are always [latin, latin-ext].
const RANGES = [
  "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD",
  "U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF",
];

const loaded = new WeakMap<FontFaceSet, Map<string, Promise<void>>>();

/**
 * Register a caption font on a FontFaceSet (document.fonts or a worker's self.fonts).
 * `italic` also loads its italic files, for the fonts that have them.
 */
export function loadCaptionFont(id: FontId, set: FontFaceSet, italic = false): Promise<void> {
  let m = loaded.get(set);
  if (!m) loaded.set(set, (m = new Map()));
  const f0 = fontById(id);
  const withItalic = italic && !!f0.italicFiles;
  const cacheKey = withItalic ? `${id}|italic` : id;
  let p = m.get(cacheKey);
  if (!p) {
    p = (isUserFont(id) ? userFontsReady.catch(() => {}) : Promise.resolve()).then(async () => {
      const f = fontById(id);
      if (f.id !== id) return loadCaptionFont(f.id, set, italic); // Not here: its fallback.
      if (f.data) {
        const face = new FontFace(captionFamily(id), f.data, f.weightRange ? { weight: f.weightRange } : {});
        await Promise.all([face.load().then((x) => set.add(x)), loadCaptionFont(FALLBACK, set)]);
        return;
      }
      const faces = (files: string[], style: "normal" | "italic") =>
        files.map(async (url, i) => {
          const face = new FontFace(captionFamily(id), `url(${url})`, {
            weight: f.weightRange,
            style,
            unicodeRange: RANGES[i],
          });
          set.add(await face.load());
        });
      await Promise.all([
        ...faces(f.files!, "normal"),
        ...(withItalic ? faces(f.italicFiles!, "italic") : []),
      ]);
    });
    m.set(cacheKey, p);
  }
  return p;
}
