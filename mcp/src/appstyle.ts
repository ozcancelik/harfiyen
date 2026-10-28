// The look a web-app project was saved with (caption style, crop, jump cut) as render_captions' options. What the
// MCP cannot draw is reported in `notes`, never dropped silently.

import type { JumpCut } from "../../src/lib/cuts";
import type { Aspect, CaptionOptions, CaptionStyle } from "./captions";

export interface Look {
  style?: CaptionStyle;
  captions: Partial<CaptionOptions>;
  emphasis?: boolean;
  speakerNames?: boolean;
  aspect?: Aspect;
  fit?: "fill" | "fit";
  backdrop?: "black" | "blur";
  /** The slice of the picture kept, as fractions of it (fill). */
  cropBox?: { x: number; y: number; w: number; h: number };
  jumpCut?: Partial<JumpCut>;
  /** What the project asked for that cannot be drawn here. */
  notes: string[];
  /** What the project gave, by part, for the tool's answer (a part asked for by hand is not the project's). */
  used: { style?: string; crop?: string; jumpCut?: string };
}

/** The app's presets and the nearest style here. Dolgu (the accent fills each word) is what karaoke does here. */
const PRESETS: Record<string, CaptionStyle> = {
  klasik: "klasik",
  karaoke: "karaoke",
  dolgu: "karaoke",
  akis: "akis",
  odak: "odak",
  vurgu: "vurgu",
  pop: "pop",
  tek: "tek-kelime",
  netles: "netles",
  sade: "sade",
  // The blurred glass needs the GPU; the dark box is the nearest calm look.
  cam: "klasik",
};

/** The app's font ids and their families (fonts.ts). */
const FONTS: Record<string, string> = {
  gsflex: "Google Sans Flex",
  montserrat: "Montserrat",
  poppins: "Poppins",
  inter: "Inter",
  anton: "Anton",
  bebas: "Bebas Neue",
  bangers: "Bangers",
  luckiest: "Luckiest Guy",
  schibsted: "Schibsted Grotesk",
  literata: "Literata",
};

const ASPECTS = new Set(["9:16", "4:5", "1:1", "16:9"]);
const num = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const obj = (x: unknown): Record<string, unknown> | undefined => (x && typeof x === "object" ? (x as Record<string, unknown>) : undefined);
const hex = (x: unknown) => (typeof x === "string" && /^#[0-9a-f]{6}$/i.test(x) ? x : undefined);

export function lookOf(app: Record<string, unknown> | undefined): Look {
  const look: Look = { captions: {}, notes: [], used: {} };
  const s = obj(app?.settings);
  if (s) {
    if (typeof s.preset === "string" && s.preset in PRESETS) {
      look.style = PRESETS[s.preset];
      look.used.style = `stil ${s.preset}${s.preset === PRESETS[s.preset] ? "" : ` → ${look.style}`}`;
      if (s.preset === "cam") look.notes.push("Cam stili yok (buzlu cam ekran kartı gerektirir); koyu kutulu klasik stil kullanıldı.");
    }
    if (typeof s.font === "string") {
      if (s.font in FONTS) look.captions.font = FONTS[s.font];
      else look.notes.push("Projede kendi yüklediğin bir yazı tipi var; dosyası projede olmadığı için varsayılan yazı tipi kullanıldı (font_file ile verilebilir).");
    }
    // The app's size is a share of the frame's shorter side, and already the style's own size.
    if (num(s.size)) Object.assign(look.captions, { size: s.size, sizeBasis: "short" });
    if (s.position === "bottom" || s.position === "middle" || s.position === "top") {
      look.captions.position = { bottom: "alt", middle: "orta", top: "ust" }[s.position] as CaptionOptions["position"];
    }
    if (hex(s.textColor)) look.captions.color = hex(s.textColor);
    if (hex(s.accentColor)) look.captions.accent = hex(s.accentColor);
    // False leaves it to the font: capitals-only fonts need the Turkish upper-casing either way.
    if (s.uppercase === true) look.captions.uppercase = true;
    if (s.background === "box" || s.background === "outline" || s.background === "shadow") look.captions.background = s.background;
    else if (s.background === "glass") look.captions.background = "box";
    if (typeof s.voiceEmphasis === "boolean") look.emphasis = s.voiceEmphasis;
    if (typeof s.speakerNames === "boolean") look.speakerNames = s.speakerNames;
    if (obj(s.kinetic)?.on === true) look.notes.push("Projede kinetik tipografi açık; burada yok, altyazı stiliyle yazıldı.");
    if (s.hidden === true) look.notes.push("Projede altyazı gizli işaretli (yalnızca seslendirmeli video); altyazı yine de yazıldı.");
    if (s.picture === "hidden" || s.picture === "blur") look.notes.push("Projede görüntü gizli ya da bulanık; burada görüntü olduğu gibi kullanıldı.");
    if (s.photo === true) look.notes.push("Projede arka plan fotoğrafı var; burada kullanılmıyor.");
  }

  const c = obj(app?.crop);
  if (c && num(c.x) && num(c.y) && num(c.w) && num(c.h)) {
    const aspect = typeof c.aspect === "string" && ASPECTS.has(c.aspect) ? (c.aspect as Aspect) : undefined;
    const whole = c.w > 0.999 && c.h > 0.999;
    if (c.fit === "fit" && aspect) {
      Object.assign(look, { aspect, fit: "fit", backdrop: c.backdrop === "blur" ? "blur" : "black" });
      look.used.crop = `kadraj ${aspect} sığdır, ${look.backdrop === "blur" ? "bulanık" : "siyah"} zemin`;
    } else if (!whole) {
      Object.assign(look, { aspect, fit: "fill", cropBox: { x: c.x, y: c.y, w: c.w, h: c.h } });
      look.used.crop = `kadraj ${aspect ?? "serbest"} (${Math.round(c.x * 100)}%, ${Math.round(c.y * 100)}% köşeli kutu)`;
    }
  }

  const j = obj(app?.jumpCut);
  if (j?.on === true) {
    look.jumpCut = { gap: num(j.gap) ? j.gap : undefined, pad: num(j.pad) ? j.pad : undefined, fillers: j.fillers !== false };
    look.used.jumpCut = "boşluk kesme";
  }
  return look;
}
