import { useEffect, useRef, useState } from "react";
import { loadCaptionFont } from "../captions/fonts";
import { CaptionRenderer } from "../captions/renderer";
import {
  FAMILIES,
  PRESETS,
  presetById,
  settingsFor,
  type CaptionSettings,
  type PresetFamily,
  type PresetId,
} from "../captions/style";
import type { Word } from "../engine";
import type { GroundPreview } from "../lib/groundPreview";
import { paletteById } from "../render/aura";
import { IconCheck } from "./icons";

const SAMPLE: Word[] = [
  { text: "bugün", start: 0, end: 0.4 },
  { text: "hava", start: 0.4, end: 0.8 },
  { text: "çok", start: 0.8, end: 1.1 },
  { text: "güzel", start: 1.1, end: 1.6 },
];

// Cards lay captions out on a small frame; the size is boosted so the
// look stays legible at thumbnail scale.
const FRAME = { w: 320, h: 180 };
const BOOST = 2.1;

const TAB =
  "relative h-6 flex-1 rounded-[5px] border-0 bg-transparent text-[11.5px] font-medium tracking-[-0.01em] text-fg-2 transition-all duration-150 ease-[ease] hover:not-aria-selected:text-fg aria-selected:bg-raised aria-selected:font-[550] aria-selected:text-fg-strong aria-selected:shadow-[0_1px_3px_var(--shadow-pop),inset_0_1px_0_var(--tint)]";

/** Glass panel on a card, in CSS pixels of the card. */
interface CardPanel {
  left: number;
  top: number;
  width: number;
  height: number;
  radius: number;
}

/** A preset rendered with the real caption renderer. */
function StyleCard({
  id,
  label,
  selected,
  settings,
  still,
  onPick,
}: {
  id: PresetId;
  label: string;
  selected: boolean;
  settings: CaptionSettings;
  /** The project's ground (lib/groundPreview.ts); null for a ground in the aura's colours. */
  still: string | null;
  onPick: () => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const s = settingsFor(id, settings);
  const [fontTick, setFontTick] = useState(0);
  const [panel, setPanel] = useState<CardPanel | null>(null);

  useEffect(() => {
    let live = true;
    loadCaptionFont(s.font, document.fonts, s.italic).then(
      () => live && setFontTick((n) => n + 1),
    );
    return () => {
      live = false;
    };
  }, [s.font, s.italic]);

  useEffect(() => {
    const c = canvas.current!;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(c.clientWidth * dpr);
    c.height = Math.round(c.clientHeight * dpr);
    const g = c.getContext("2d")!;
    g.clearRect(0, 0, c.width, c.height);
    // The card shows the style even while captions are hidden.
    const boosted = { ...s, size: Math.min(0.17, s.size * BOOST), hidden: false };
    const r = new CaptionRenderer(SAMPLE, boosted, FRAME.w, FRAME.h);
    const img = r.frame(0.6);
    if (!img) return;
    const k = c.width / FRAME.w;
    g.drawImage(img.source, img.x * k, img.y * k, img.w * k, img.h * k);
    // The glass itself is the browser's backdrop blur over the card background.
    const css = c.clientWidth / FRAME.w;
    setPanel(
      img.panel
        ? {
            left: (img.x + img.panel.insetX) * css,
            top: (img.y + img.panel.insetTop) * css,
            width: (img.w - img.panel.insetX * 2) * css,
            height: (img.h - img.panel.insetTop - img.panel.insetBottom) * css,
            radius: img.panel.radius * css,
          }
        : null,
    );
    // Only depends on the preset and font readiness.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, fontTick]);

  const [a, b, c] = paletteById(settings.aura).colors;
  return (
    <button
      role="radio"
      aria-checked={selected}
      className="group/card grid gap-1.5 border-0 bg-transparent p-0 text-left"
      onClick={onPick}
    >
      <span
        className={`relative block aspect-video cursor-pointer overflow-hidden rounded-ui transition-all duration-150 ease-[ease] group-hover/card:-translate-y-px ${
          selected
            ? "shadow-[0_0_0_2px_var(--cini),0_4px_12px_rgba(71,109,230,0.35),inset_0_0_0_1px_rgba(255,255,255,0.1)]"
            : "shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)] group-hover/card:shadow-[inset_0_0_0_1px_rgba(255,255,255,0.25)]"
        }`}
        style={{
          background: still
            ? `center / cover no-repeat url(${still}), #0b0e13`
            : `radial-gradient(120% 90% at 15% 20%, ${a}cc, transparent 60%), radial-gradient(110% 90% at 85% 30%, ${b}aa, transparent 60%), radial-gradient(120% 100% at 50% 100%, ${c}99, transparent 65%), #0b0e13`,
        }}
      >
        {panel && (
          <span
            className="absolute bg-black/25 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.14)] backdrop-blur-[6px] backdrop-saturate-[1.2]"
            style={{ ...panel, borderRadius: panel.radius }}
            aria-hidden
          />
        )}
        <canvas
          ref={canvas}
          className="absolute inset-0 size-full"
          aria-hidden
        />
        {selected && (
          <span
            className="absolute top-1.5 right-1.5 grid size-4.5 place-items-center rounded-full bg-cini text-white shadow-[0_1px_4px_rgba(0,0,0,0.4)]"
            aria-hidden
          >
            <IconCheck size={12} />
          </span>
        )}
      </span>
      <span
        className={`pl-0.5 text-[12px] font-[550] tracking-[-0.01em] ${selected ? "text-fg-strong" : "text-fg-2"}`}
      >
        {label}
      </span>
    </button>
  );
}

export function StylePicker({
  settings,
  ground,
  onChange,
}: {
  settings: CaptionSettings;
  /** The project's ground, behind the cards. */
  ground?: GroundPreview;
  onChange: (s: CaptionSettings) => void;
}) {
  // Opens on the family of the chosen style, and follows it when it changes
  // from elsewhere (a project opened, say).
  const family = presetById(settings.preset).family;
  const [tab, setTab] = useState<PresetFamily>(family);
  useEffect(() => setTab(family), [family]);

  return (
    <div className="grid gap-2">
      <div
        className="flex gap-0.5 rounded-lg border border-line-soft bg-well p-0.75"
        role="tablist"
        aria-label="Stil ailesi"
      >
        {FAMILIES.map((f) => (
          <button
            key={f.id}
            type="button"
            className={TAB}
            role="tab"
            aria-selected={tab === f.id}
            onClick={() => setTab(f.id)}
          >
            {f.label}
            {/* The chosen style is in another family. */}
            {f.id === family && tab !== family && (
              <>
                <span
                  className="absolute top-1 right-1.5 size-1.25 rounded-full bg-cini"
                  aria-hidden
                />
                <span className="sr-only"> (seçili stil burada)</span>
              </>
            )}
          </button>
        ))}
      </div>
      <div
        className="grid grid-cols-2 gap-2"
        role="radiogroup"
        aria-label="Altyazı stili"
      >
        {PRESETS.filter((p) => p.family === tab).map((p) => (
          <StyleCard
            key={p.id}
            id={p.id}
            label={p.label}
            selected={settings.preset === p.id}
            settings={settings}
            still={ground?.url ?? null}
            onPick={() => onChange(settingsFor(p.id, settings))}
          />
        ))}
      </div>
    </div>
  );
}
