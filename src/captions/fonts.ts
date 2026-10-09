// Caption fonts. Every font ships its latin and latin-ext subsets, so Turkish
// (ğ ş ı İ ç ö ü) always renders with the real glyphs, never a fallback.
// Fonts are registered under our own family names from the bundled files, so
// the on-screen preview and the WebGPU render use exactly the same font.

import gsflexExt from "@fontsource-variable/google-sans-flex/files/google-sans-flex-latin-ext-wght-normal.woff2?url";
import gsflex from "@fontsource-variable/google-sans-flex/files/google-sans-flex-latin-wght-normal.woff2?url";
import antonExt from "@fontsource/anton/files/anton-latin-ext-400-normal.woff2?url";
import anton from "@fontsource/anton/files/anton-latin-400-normal.woff2?url";
import bebasExt from "@fontsource/bebas-neue/files/bebas-neue-latin-ext-400-normal.woff2?url";
import bebas from "@fontsource/bebas-neue/files/bebas-neue-latin-400-normal.woff2?url";
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

export type FontId = "gsflex" | "montserrat" | "poppins" | "inter" | "anton" | "bebas" | "schibsted" | "literata";

export interface CaptionFont {
  id: FontId;
  label: string;
  /** Weight used for captions. */
  weight: number;
  /** Weight range of the file (variable fonts) or the single static weight. */
  weightRange: string;
  files: string[];
}

export const FONTS: CaptionFont[] = [
  { id: "gsflex", label: "Google Sans Flex", weight: 760, weightRange: "1 1000", files: [gsflex, gsflexExt] },
  { id: "montserrat", label: "Montserrat", weight: 800, weightRange: "100 900", files: [montserrat, montserratExt] },
  { id: "poppins", label: "Poppins", weight: 800, weightRange: "800", files: [poppins, poppinsExt] },
  { id: "inter", label: "Inter", weight: 650, weightRange: "100 900", files: [inter, interExt] },
  { id: "anton", label: "Anton", weight: 400, weightRange: "400", files: [anton, antonExt] },
  { id: "bebas", label: "Bebas Neue", weight: 400, weightRange: "400", files: [bebas, bebasExt] },
  { id: "schibsted", label: "Schibsted Grotesk", weight: 650, weightRange: "400 900", files: [schibsted, schibstedExt] },
  { id: "literata", label: "Literata", weight: 600, weightRange: "200 900", files: [literata, literataExt] },
];

export const fontById = (id: FontId) => FONTS.find((f) => f.id === id)!;

/** CSS family name the caption renderer uses for a font. */
export const captionFamily = (id: FontId) => `Harfiyen Caption ${id}`;

// Subset ranges from fontsource; files are always [latin, latin-ext].
const RANGES = [
  "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD",
  "U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF",
];

const loaded = new WeakMap<FontFaceSet, Map<FontId, Promise<void>>>();

/** Register a caption font on a FontFaceSet (document.fonts or a worker's self.fonts). */
export function loadCaptionFont(id: FontId, set: FontFaceSet): Promise<void> {
  let m = loaded.get(set);
  if (!m) loaded.set(set, (m = new Map()));
  let p = m.get(id);
  if (!p) {
    const f = fontById(id);
    p = Promise.all(
      f.files.map(async (url, i) => {
        const face = new FontFace(captionFamily(id), `url(${url})`, {
          weight: f.weightRange,
          unicodeRange: RANGES[i],
        });
        set.add(await face.load());
      }),
    ).then(() => undefined);
    m.set(id, p);
  }
  return p;
}
