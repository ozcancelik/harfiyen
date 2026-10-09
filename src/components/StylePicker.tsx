import { useEffect, useRef, useState } from "react";
import { loadCaptionFont } from "../captions/fonts";
import { CaptionRenderer } from "../captions/renderer";
import { PRESETS, settingsFor, type CaptionSettings, type PresetId } from "../captions/style";
import type { Word } from "../engine";
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

/** A preset rendered with the real caption renderer. */
function StyleCard({
  id,
  label,
  selected,
  settings,
  onPick,
}: {
  id: PresetId;
  label: string;
  selected: boolean;
  settings: CaptionSettings;
  onPick: () => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const s = settingsFor(id, settings);
  const [fontTick, setFontTick] = useState(0);

  useEffect(() => {
    let live = true;
    loadCaptionFont(s.font, document.fonts).then(() => live && setFontTick((n) => n + 1));
    return () => {
      live = false;
    };
  }, [s.font]);

  useEffect(() => {
    const c = canvas.current!;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(c.clientWidth * dpr);
    c.height = Math.round(c.clientHeight * dpr);
    const g = c.getContext("2d")!;
    g.clearRect(0, 0, c.width, c.height);
    const boosted = { ...s, size: Math.min(0.17, s.size * BOOST) };
    const r = new CaptionRenderer(SAMPLE, boosted, FRAME.w, FRAME.h);
    const img = r.frame(0.6);
    if (!img) return;
    const k = c.width / FRAME.w;
    g.drawImage(img.source, img.x * k, img.y * k, img.w * k, img.h * k);
    // Only depends on the preset and font readiness.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, fontTick]);

  const [a, b, c] = paletteById(settings.aura).colors;
  return (
    <button
      role="radio"
      aria-checked={selected}
      className={`style-card${selected ? " style-card--on" : ""}`}
      onClick={onPick}
    >
      <span
        className="style-card__frame"
        style={{
          background: `radial-gradient(120% 90% at 15% 20%, ${a}cc, transparent 60%), radial-gradient(110% 90% at 85% 30%, ${b}aa, transparent 60%), radial-gradient(120% 100% at 50% 100%, ${c}99, transparent 65%), #0b0e13`,
        }}
      >
        <canvas ref={canvas} aria-hidden />
        {selected && (
          <span className="style-card__check" aria-hidden>
            <IconCheck size={12} />
          </span>
        )}
      </span>
      <span className="style-card__label">{label}</span>
    </button>
  );
}

export function StylePicker({
  settings,
  onChange,
}: {
  settings: CaptionSettings;
  onChange: (s: CaptionSettings) => void;
}) {
  return (
    <div className="style-grid" role="radiogroup" aria-label="Altyazı stili">
      {PRESETS.map((p) => (
        <StyleCard
          key={p.id}
          id={p.id}
          label={p.label}
          selected={settings.preset === p.id}
          settings={settings}
          onPick={() => onChange(settingsFor(p.id, settings))}
        />
      ))}
    </div>
  );
}
