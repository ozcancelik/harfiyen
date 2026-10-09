import { useEffect } from "react";
import { captionFamily, FONTS, fontById, loadCaptionFont, type FontId } from "../captions/fonts";
import { ACCENT_COLORS, presetById, TEXT_COLORS, type CaptionSettings } from "../captions/style";
import { AURA_PALETTES, paletteById, type AuraPaletteId } from "../render/aura";
import { Select } from "./Select";
import { StylePicker } from "./StylePicker";

function Swatches({
  label,
  colors,
  value,
  onChange,
}: {
  label: string;
  colors: string[];
  value: string;
  onChange: (c: string) => void;
}) {
  return (
    <div className="row swatches" role="radiogroup" aria-label={label}>
      <span className="row__label">{label}</span>
      {colors.map((c) => (
        <button
          key={c}
          className="swatch"
          role="radio"
          aria-checked={value === c}
          aria-label={c}
          style={{ background: c }}
          onClick={() => onChange(c)}
        />
      ))}
      <label className="swatch swatch--custom" title="Başka renk">
        <input type="color" value={value} onChange={(e) => onChange(e.target.value)} aria-label={`${label}, özel renk`} />
      </label>
    </div>
  );
}

const POSITIONS = [
  { value: "top" as const, label: "Üstte" },
  { value: "middle" as const, label: "Ortada" },
  { value: "bottom" as const, label: "Altta" },
];

const BACKGROUNDS = [
  { value: "box" as const, label: "Kutu", note: "Yazının arkasında koyu kutu" },
  { value: "outline" as const, label: "Kontur", note: "Harflerin çevresinde siyah çizgi" },
  { value: "shadow" as const, label: "Gölge", note: "Yumuşak gölge, kutusuz" },
];

export function CaptionStudio({
  settings,
  onChange,
  disabled,
}: {
  settings: CaptionSettings;
  onChange: (s: CaptionSettings) => void;
  disabled?: boolean;
}) {
  // Font options render in their own typeface.
  useEffect(() => {
    for (const f of FONTS) void loadCaptionFont(f.id, document.fonts);
  }, []);

  const set = (patch: Partial<CaptionSettings>) => onChange({ ...settings, ...patch });
  const preset = presetById(settings.preset);

  return (
    <fieldset className="studio" disabled={disabled}>
      <section className="section">
        <h3 className="section__title">Stil</h3>
        <StylePicker settings={settings} onChange={onChange} />
        <p className="hint">{preset.note}</p>
      </section>

      <section className="section">
        <h3 className="section__title">Yazı</h3>
        <Select<FontId>
          label="Yazı tipi"
          value={settings.font}
          options={FONTS.map((f) => ({ value: f.id, label: f.label }))}
          onChange={(font) => set({ font })}
          disabled={disabled}
          render={(o, inList) => {
            const f = fontById(o.value);
            const style = { fontFamily: `"${captionFamily(f.id)}"`, fontWeight: f.weight };
            return inList ? (
              <span className="opt opt--font">
                <span className="opt__specimen" style={style}>
                  Pijamalı hasta yağız şoföre çabucak güvendi.
                </span>
                <span className="opt__note">{f.label}</span>
              </span>
            ) : (
              <span className="opt">
                <span className="opt__aa" style={style}>
                  Ağ
                </span>
                <span className="opt__title">{f.label}</span>
              </span>
            );
          }}
        />
        <label className="row">
          <span className="row__label">Boyut</span>
          <input
            type="range"
            min={0.03}
            max={0.14}
            step={0.002}
            value={settings.size}
            onChange={(e) => set({ size: Number(e.target.value) })}
          />
          <span className="row__value">{Math.round(settings.size * 1000) / 10}</span>
        </label>
        <label className="row">
          <span className="row__label">Büyük harf</span>
          <input type="checkbox" className="switch" checked={settings.uppercase} onChange={(e) => set({ uppercase: e.target.checked })} />
        </label>
      </section>

      <section className="section">
        <h3 className="section__title">Yerleşim</h3>
        <div className="row">
          <span className="row__label">Konum</span>
          <Select
            label="Konum"
            value={settings.position}
            options={POSITIONS}
            onChange={(position) => set({ position })}
            disabled={disabled}
            render={(o) => (
              <span className="opt">
                <span className={`opt__frame opt__frame--${o.value}`} aria-hidden>
                  <span />
                </span>
                <span className="opt__title">{o.label}</span>
              </span>
            )}
          />
        </div>
        <div className="row">
          <span className="row__label">Zemin</span>
          <Select
            label="Zemin"
            value={settings.background}
            options={BACKGROUNDS}
            onChange={(background) => set({ background })}
            disabled={disabled}
            render={(o, inList) => (
              <span className="opt">
                <span className={`opt__bg opt__bg--${o.value}`} aria-hidden>
                  Aa
                </span>
                <span className="opt__text">
                  <span className="opt__title">{o.label}</span>
                  {inList && <span className="opt__note">{BACKGROUNDS.find((b) => b.value === o.value)!.note}</span>}
                </span>
              </span>
            )}
          />
        </div>
      </section>

      <section className="section">
        <h3 className="section__title">Renk</h3>
        <Swatches label="Yazı" colors={TEXT_COLORS} value={settings.textColor} onChange={(textColor) => set({ textColor })} />
        {preset.effect !== "none" && (
          <Swatches label="Vurgu" colors={ACCENT_COLORS} value={settings.accentColor} onChange={(accentColor) => set({ accentColor })} />
        )}
      </section>

      <section className="section">
        <h3 className="section__title">Ses kayıtlarında arka plan</h3>
        <Select<AuraPaletteId>
          label="Aura renkleri"
          value={settings.aura}
          options={AURA_PALETTES.map((p) => ({ value: p.id, label: p.label }))}
          onChange={(aura) => set({ aura })}
          disabled={disabled}
          render={(o) => {
            const [a, b, c] = paletteById(o.value).colors;
            return (
              <span className="opt">
                <span
                  className="opt__aura"
                  aria-hidden
                  style={{
                    background: `radial-gradient(circle at 30% 40%, ${a}, transparent 60%), radial-gradient(circle at 70% 60%, ${b}, transparent 55%), radial-gradient(circle at 50% 90%, ${c}, transparent 50%), #05070b`,
                  }}
                />
                <span className="opt__title">{o.label}</span>
              </span>
            );
          }}
        />
        <p className="hint">Sadece ses olan dosyalarda ve mikrofon kayıtlarında, görüntü yerine sesle hareket eden bir aura çizilir.</p>
      </section>
    </fieldset>
  );
}
