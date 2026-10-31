// The look a web-app project was saved with (caption style, crop, jump cut) as render_captions' options. What only
// the app's own renderer (Chrome, src/chrome.ts) draws is in `chromeOnly`: with Chrome it is drawn as the project has
// it, without it the nearest ffmpeg look is used and the note says what is missing. What neither draws is in `notes`,
// never dropped silently.

import type { Corner, LogoSettings } from "../../src/captions/style";
import { cropFor } from "../../src/lib/crop";
import { DEFAULT_JUMP_CUT, type JumpCut } from "../../src/lib/cuts";
import { CROP_CENTER, type Aspect, type CaptionOptions, type CaptionStyle, type CropPosition } from "./captions";

export interface Look {
  style?: CaptionStyle;
  captions: Partial<CaptionOptions>;
  hidden?: boolean;
  emphasis?: boolean;
  speakerNames?: boolean;
  logo?: Partial<LogoSettings> & { on: boolean };
  photo?: boolean;
  photoBlur?: boolean;
  /** The project uses a font the user added from a file, which is not inside the project file. */
  missingFont?: boolean;
  aspect?: Aspect;
  fit?: "fill" | "fit";
  backdrop?: "black" | "blur";
  /** The slice of the picture kept, as fractions of it (fill). */
  cropBox?: { x: number; y: number; w: number; h: number };
  jumpCut?: Partial<JumpCut>;
  /** The project's caption settings as the app saved them, for the app's renderer. */
  settings?: Record<string, unknown>;
  /** What the project asks for that only the app's renderer draws, and what to tell when ffmpeg stands in for it. */
  chromeOnly: { why: string; note: string }[];
  /** What the project asked for that cannot be drawn at all. */
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
  // The blurred glass needs the app's renderer; the dark box is the nearest calm look.
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

/** The app's font id for a family name (fonts.ts); undefined for a system font the app does not bundle. */
export const fontIdOf = (family: string) => Object.entries(FONTS).find(([, f]) => f.toLowerCase() === family.toLowerCase())?.[0];

const ASPECTS = new Set(["9:16", "4:5", "1:1", "16:9"]);
const num = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const obj = (x: unknown): Record<string, unknown> | undefined => (x && typeof x === "object" ? (x as Record<string, unknown>) : undefined);
const hex = (x: unknown) => (typeof x === "string" && /^#[0-9a-f]{6}$/i.test(x) ? x : undefined);

const CORNERS = new Set<Corner>(["tl", "tr", "bl", "br"]);

export function lookOf(app: Record<string, unknown> | undefined): Look {
  const look: Look = { captions: {}, chromeOnly: [], notes: [], used: {} };
  const s = obj(app?.settings);
  if (s) {
    look.settings = s;
    if (typeof s.preset === "string" && s.preset in PRESETS) {
      look.style = PRESETS[s.preset];
      look.used.style = `stil ${s.preset}${s.preset === PRESETS[s.preset] ? "" : ` → ${look.style}`}`;
      if (s.preset === "cam") look.chromeOnly.push({ why: "cam stili", note: "Cam stili çizilemedi (Chrome gerekir); koyu kutulu klasik stil kullanıldı." });
    }
    const k = obj(s.kinetic);
    if (typeof s.font === "string") {
      if (s.font in FONTS) look.captions.font = FONTS[s.font];
      else if (k?.on !== true) look.missingFont = true;
    }
    if (k?.on === true && typeof k.font === "string" && !(k.font in FONTS)) look.missingFont = true;
    // The app's size is a share of the frame's shorter side, and already the style's own size.
    if (num(s.size)) Object.assign(look.captions, { size: s.size, sizeBasis: "short" });
    if (s.position === "bottom" || s.position === "middle" || s.position === "top") {
      look.captions.position = { bottom: "alt", middle: "orta", top: "ust" }[s.position] as CaptionOptions["position"];
    }
    if (s.italic === true) look.captions.italic = true;
    if (num(s.tracking)) look.captions.tracking = s.tracking;
    if (num(s.weight)) look.chromeOnly.push({ why: "yazı kalınlığı", note: `Projedeki yazı kalınlığı (${s.weight}) Chrome olmadan çizilemedi; ffmpeg yalnızca kalın ya da normal yazar.` });
    if (hex(s.textColor)) look.captions.color = hex(s.textColor);
    if (hex(s.accentColor)) look.captions.accent = hex(s.accentColor);
    // False leaves it to the font: capitals-only fonts need the Turkish upper-casing either way.
    if (s.uppercase === true) look.captions.uppercase = true;
    if (s.background === "box" || s.background === "outline" || s.background === "shadow") look.captions.background = s.background;
    else if (s.background === "glass") {
      look.captions.background = "box";
      if (s.preset !== "cam") look.chromeOnly.push({ why: "buzlu cam zemin", note: "Buzlu cam zemin çizilemedi (Chrome gerekir); koyu kutu kullanıldı." });
    }
    if (typeof s.voiceEmphasis === "boolean") look.emphasis = s.voiceEmphasis;
    if (typeof s.speakerNames === "boolean") look.speakerNames = s.speakerNames;
    if (k?.on === true) look.chromeOnly.push({ why: "kinetik tipografi", note: "Projede kinetik tipografi açık; Chrome olmadan çizilemez, altyazı stiliyle yazıldı." });
    if (s.hidden === true) {
      look.hidden = true;
      look.used.style = "yazısız";
    }
    if (s.picture === "hidden" || s.picture === "blur") {
      look.chromeOnly.push({ why: "gizli ya da bulanık görüntü", note: "Projede görüntü gizli ya da bulanık; Chrome olmadan görüntü olduğu gibi kullanıldı." });
    }
    const l = obj(s.logo);
    if (l) {
      look.logo = {
        on: l.on === true,
        corner: typeof l.corner === "string" && CORNERS.has(l.corner as Corner) ? (l.corner as Corner) : undefined,
        size: num(l.size) ? l.size : undefined,
        opacity: num(l.opacity) ? l.opacity : undefined,
      };
    }
    if (s.photo === true) {
      look.photo = true;
      look.photoBlur = s.photoBlur === true;
    }
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

const STYLE_KEYS = ["font", "size", "position", "textColor", "accentColor", "uppercase", "background"] as const;

export interface AppLookUpdate {
  preset?: string;
  patch?: Record<string, unknown>;
  kinetic?: { style?: string; palette?: string; backdrop?: "stage" | "aura" };
  picture?: "video" | "blur" | "aura";
  hidden?: boolean;
  emphasis?: boolean;
  speakerNames?: boolean;
  logo?: { corner: Corner; size: number; opacity: number };
  photo?: { blur?: boolean };
  aspect?: Aspect;
  fit?: "fill" | "fit";
  backdrop?: "black" | "blur";
  cropPosition?: CropPosition;
  mediaSize?: { width: number; height: number };
  jumpCut?: boolean;
  jumpCutOpts?: Partial<JumpCut>;
}

/** Updates `app` (`t.app`) with the visual, framing and jump-cut settings chosen in `render_captions`, for `.harfiyen` export. */
export function saveLookToApp(prev: Record<string, unknown> | undefined, u: AppLookUpdate): Record<string, unknown> {
  const next: Record<string, unknown> = { ...prev };
  const s: Record<string, unknown> = { ...obj(prev?.settings) };
  if (u.preset) s.preset = u.preset;
  else if (typeof s.preset !== "string") s.preset = "sade";

  const overrides = new Set<string>(Array.isArray(s.overrides) ? (s.overrides as string[]).filter((x) => typeof x === "string") : []);
  if (u.patch) {
    for (const [k, v] of Object.entries(u.patch)) {
      if (v !== undefined) {
        s[k] = v;
        if ((STYLE_KEYS as readonly string[]).includes(k)) overrides.add(k);
      }
    }
  }
  if (overrides.size) s.overrides = [...overrides];
  if (u.hidden !== undefined) s.hidden = u.hidden;
  if (u.emphasis !== undefined) s.voiceEmphasis = u.emphasis;
  if (u.speakerNames !== undefined) s.speakerNames = u.speakerNames;
  if (u.picture !== undefined) s.picture = u.picture === "aura" ? "hidden" : u.picture;
  if (u.photo) {
    s.photo = true;
    if (u.photo.blur !== undefined) s.photoBlur = u.photo.blur;
  }
  if (u.logo) {
    s.logo = { on: true, corner: u.logo.corner, size: u.logo.size, opacity: u.logo.opacity };
  }
  if (u.kinetic) {
    const k = obj(s.kinetic);
    s.kinetic = {
      style: "dugum",
      palette: "gece",
      font: (typeof u.patch?.font === "string" ? u.patch.font : typeof k?.font === "string" ? k.font : "montserrat"),
      backdrop: "stage",
      ...k,
      ...u.kinetic,
      on: true,
    };
    s.hidden = false;
  } else if (u.preset || u.hidden) {
    const k = obj(s.kinetic);
    if (k?.on === true) s.kinetic = { ...k, on: false };
  }
  next.settings = s;

  const prevCrop = obj(prev?.crop);
  const aspect = u.aspect ?? (typeof prevCrop?.aspect === "string" && ASPECTS.has(prevCrop.aspect) ? (prevCrop.aspect as Aspect) : undefined);
  if (aspect && (u.aspect !== undefined || u.cropPosition !== undefined || u.fit !== undefined || u.backdrop !== undefined)) {
    const w = u.mediaSize?.width || 1920;
    const h = u.mediaSize?.height || 1080;
    const center = u.cropPosition ? CROP_CENTER[u.cropPosition] : { cx: 0.5, cy: 0.5 };
    const fit = u.fit ?? (prevCrop?.fit === "fit" ? "fit" : "fill");
    const backdrop = u.backdrop ?? (prevCrop?.backdrop === "black" ? "black" : "blur");
    next.crop = { ...cropFor(aspect, w, h, center.cx, center.cy), fit, backdrop };
  }

  if (u.jumpCut !== undefined || u.jumpCutOpts) {
    const prevJc = obj(prev?.jumpCut);
    const on = u.jumpCut ?? (prevJc?.on === true || !!u.jumpCutOpts);
    next.jumpCut = {
      on,
      gap: u.jumpCutOpts?.gap ?? (num(prevJc?.gap) ? prevJc.gap : DEFAULT_JUMP_CUT.gap),
      pad: u.jumpCutOpts?.pad ?? (num(prevJc?.pad) ? prevJc.pad : DEFAULT_JUMP_CUT.pad),
      fillers: u.jumpCutOpts?.fillers ?? (typeof prevJc?.fillers === "boolean" ? prevJc.fillers : DEFAULT_JUMP_CUT.fillers),
    };
  }
  return next;
}
