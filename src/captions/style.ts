import type { CueRules } from "../lib/cues";
import type { AuraPaletteId } from "../render/aura";
import type { FontId } from "./fonts";

export type PresetId = "klasik" | "karaoke" | "vurgu" | "pop" | "sade";

/** How each word reacts while it is being spoken. */
export type WordEffect = "none" | "karaoke" | "box" | "color";

export interface CaptionSettings {
  preset: PresetId;
  font: FontId;
  /** Font size relative to the shorter side of the frame. */
  size: number;
  position: "bottom" | "middle" | "top";
  textColor: string;
  accentColor: string;
  uppercase: boolean;
  background: "box" | "outline" | "shadow";
  /** Background for audio-only projects. */
  aura: AuraPaletteId;
}

export interface Preset {
  id: PresetId;
  label: string;
  note: string;
  /** How words are grouped into what is on screen at once. */
  grouping: CueRules;
  maxLines: number;
  effect: WordEffect;
  /** Scale-in when a new group appears. */
  pop: boolean;
  defaults: Omit<CaptionSettings, "preset" | "aura">;
}

export const PRESETS: Preset[] = [
  {
    id: "klasik",
    label: "Klasik",
    note: "İki satır altyazı, koyu kutu içinde.",
    grouping: { gap: 0.8, maxDuration: 6.5, maxChars: 84 },
    maxLines: 2,
    effect: "none",
    pop: false,
    defaults: {
      font: "gsflex",
      size: 0.05,
      position: "bottom",
      textColor: "#ffffff",
      accentColor: "#ffd60a",
      uppercase: false,
      background: "box",
    },
  },
  {
    id: "karaoke",
    label: "Karaoke",
    note: "Satır görünür, söylenen kelimeler belirginleşir.",
    grouping: { gap: 0.8, maxDuration: 5, maxChars: 56 },
    maxLines: 2,
    effect: "karaoke",
    pop: false,
    defaults: {
      font: "gsflex",
      size: 0.055,
      position: "bottom",
      textColor: "#ffffff",
      accentColor: "#ffd60a",
      uppercase: false,
      background: "outline",
    },
  },
  {
    id: "vurgu",
    label: "Vurgu",
    note: "Kısa ifadeler, konuşulan kelime renkli kutuda.",
    grouping: { gap: 0.5, maxDuration: 2.4, maxChars: 24 },
    maxLines: 2,
    effect: "box",
    pop: false,
    defaults: {
      font: "gsflex",
      size: 0.064,
      position: "bottom",
      textColor: "#ffffff",
      accentColor: "#ffd60a",
      uppercase: true,
      background: "outline",
    },
  },
  {
    id: "pop",
    label: "Pop",
    note: "Bir iki iri kelime, ortada, zıplayarak gelir.",
    grouping: { gap: 0.4, maxDuration: 1.3, maxChars: 13 },
    maxLines: 2,
    effect: "color",
    pop: true,
    defaults: {
      font: "gsflex",
      size: 0.1,
      position: "middle",
      textColor: "#ffffff",
      accentColor: "#5ce1e6",
      uppercase: true,
      background: "outline",
    },
  },
  {
    id: "sade",
    label: "Sade",
    note: "Kutusuz, hafif gölgeli, sakin.",
    grouping: { gap: 0.8, maxDuration: 5, maxChars: 64 },
    maxLines: 2,
    effect: "none",
    pop: false,
    defaults: {
      font: "gsflex",
      size: 0.045,
      position: "bottom",
      textColor: "#ffffff",
      accentColor: "#ffd60a",
      uppercase: false,
      background: "shadow",
    },
  },
];

export const presetById = (id: PresetId) => PRESETS.find((p) => p.id === id)!;

/** Switch preset, keeping choices that are not part of a preset look. */
export const settingsFor = (id: PresetId, prev?: CaptionSettings): CaptionSettings => ({
  preset: id,
  aura: prev?.aura ?? "cini",
  ...presetById(id).defaults,
});

export const DEFAULT_SETTINGS = settingsFor("karaoke");

export const TEXT_COLORS = ["#ffffff", "#ffd60a", "#16222b"];
export const ACCENT_COLORS = ["#ffd60a", "#5ce1e6", "#7ed957", "#ff5a5f", "#2347c5"];
