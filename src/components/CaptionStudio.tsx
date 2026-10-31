import { useEffect, useRef, useState } from "react";
import { captionStack, captionWeight, FONTS, fontById, isUserFont, loadCaptionFont, weightBounds, type FontId } from "../captions/fonts";
import {
  ACCENT_COLORS,
  presetById,
  settingsFor,
  TEXT_COLORS,
  withOverrides,
  type CaptionSettings,
} from "../captions/style";
import { addFontFile, removeFont, useUserFonts } from "../captions/userFonts";
import type { GroundPreview } from "../lib/groundPreview";
import { hasDottedI, TRANSCRIPT_LANG } from "../lib/lang";
import { OPT, OPT_NOTE, OPT_TEXT, OPT_TITLE, Select } from "./Select";
import { LogoSection } from "./LogoSection";
import { StylePicker } from "./StylePicker";
import { Hint, LinkButton, Range, Row, RowGroup, RowLabel, RowValue, Section, Switch } from "./ui";

const SWATCH =
  "relative size-[22px] cursor-pointer rounded-full border border-line-strong p-0 transition-[transform,outline-color] duration-150 ease-[ease] hover:scale-112";

/** Small preview tile at the start of an option. */
const TILE = "grid h-6 w-[30px] flex-none place-items-center rounded-ui-sm";
const BAR_AT = { top: "top-[3px]", middle: "top-2", bottom: "bottom-[3px]" };
const BG_LOOK = {
  box: "shadow-[inset_0_0_0_5px_rgba(10,16,22,0.75)]",
  outline: "[-webkit-text-stroke:1px_#000] [paint-order:stroke_fill]",
  shadow: "[text-shadow:0_1px_4px_rgba(0,0,0,0.9)]",
  glass: "shadow-[inset_0_0_0_5px_rgba(255,255,255,0.25)] [text-shadow:0_1px_2px_rgba(0,0,0,0.5)]",
};

/** Inspector body: no border or padding of its own; dims while disabled. */
export const STUDIO = "m-0 min-w-0 border-0 p-0 pb-5 disabled:opacity-50";

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
    <RowGroup wrap role="radiogroup" aria-label={label}>
      <RowLabel>{label}</RowLabel>
      {colors.map((c) => (
        <button
          key={c}
          className={`${SWATCH} aria-checked:outline-2 aria-checked:outline-offset-2 aria-checked:outline-cini`}
          role="radio"
          aria-checked={value === c}
          aria-label={c}
          style={{ background: c }}
          onClick={() => onChange(c)}
        />
      ))}
      <label
        className={`${SWATCH} overflow-hidden bg-[conic-gradient(#ff5a5f,#ffd60a,#7ed957,#5ce1e6,#4f74e8,#ff5a5f)]`}
        title="Başka renk"
      >
        <input
          type="color"
          className="absolute inset-0 cursor-pointer opacity-0"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-label={`${label}, özel renk`}
        />
      </label>
    </RowGroup>
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
  { value: "glass" as const, label: "Buzlu cam", note: "Arkasındaki video bulanıklaşır" },
];

export function CaptionStudio({
  settings,
  ground,
  onChange,
  disabled,
  lang = TRANSCRIPT_LANG,
  onScene,
  speakerCount = 0,
}: {
  settings: CaptionSettings;
  /** The project's ground, behind the style cards. */
  ground?: GroundPreview;
  onChange: (s: CaptionSettings) => void;
  disabled?: boolean;
  /** The captions' language; decides how they are uppercased. */
  lang?: string;
  /** Opens the Sahne tab, where captions are turned on or off. */
  onScene: () => void;
  /** How many speakers the open transcript tells apart; their names can be shown from two. */
  speakerCount?: number;
}) {
  const userFonts = useUserFonts();
  const fontFile = useRef<HTMLInputElement>(null);
  const [adding, setAdding] = useState(false);
  const [fontError, setFontError] = useState<string | null>(null);

  // Font options render in their own typeface.
  useEffect(() => {
    for (const f of [...FONTS, ...userFonts.fonts]) void loadCaptionFont(f.id, document.fonts);
  }, [userFonts.fonts]);

  const set = (patch: Partial<CaptionSettings>) => onChange(withOverrides(settings, patch));
  /** Back to the preset's own look. */
  const resetLook = () =>
    onChange(settingsFor(settings.preset, { ...settings, overrides: [], weight: undefined, italic: undefined, tracking: undefined }));
  const preset = presetById(settings.preset);
  const font = fontById(settings.font);
  const weights = weightBounds(font);
  const capsOnly = !!font.capsOnly && hasDottedI(lang);
  const added = userFonts.fonts.find((f) => f.id === settings.font);
  // A project whose added font was deleted, or opened in another browser.
  const lost = userFonts.ready && font.id !== settings.font;

  const addFont = async (file: File) => {
    setAdding(true);
    setFontError(null);
    try {
      const f = await addFontFile(file);
      set({ font: f.id, weight: undefined });
    } catch (e) {
      setFontError(e instanceof Error ? e.message : String(e));
    } finally {
      setAdding(false);
    }
  };

  const fontOptions = [
    ...userFonts.fonts.map((f) => ({ value: f.id, label: f.label, group: "Yüklediklerin" })),
    ...FONTS.map((f) => ({ value: f.id, label: f.label, group: userFonts.fonts.length ? "Hazır" : undefined })),
  ];

  return (
    <fieldset className={STUDIO} disabled={disabled}>
      {/* The Sahne tab decides what is written; here only a note when it is not captions. */}
      {(settings.kinetic?.on || settings.hidden) && (
        <Section title="Altyazı">
          <Hint>
            {settings.kinetic?.on
              ? "Kinetik tipografi açık: altyazının yerine o çiziliyor."
              : "Bu projede ekranda yazı yok; SRT, VTT ve metin dışa aktarımları etkilenmez."}{" "}
            Aşağıdaki ayarlar altyazıya dönünce kullanılır.
          </Hint>
          <LinkButton type="button" className="justify-self-start" onClick={onScene}>
            Sahne sekmesine git
          </LinkButton>
        </Section>
      )}
      {speakerCount > 1 && (
        <Section title="Konuşmacılar">
          <Row>
            <RowLabel wide>Konuşanın adını göster</RowLabel>
            <Switch checked={!!settings.speakerNames} onChange={(e) => onChange({ ...settings, speakerNames: e.target.checked })} />
          </Row>
          <Hint>
            Konuşan değişince altyazının üstünde adı, renk noktasıyla, stilin kendi görünümünde çıkar; yazı ve vurgu
            renkleri değişmez. Kinetik tipografide ad sol üst köşede durur. Adlar Metin sekmesindeki Konuşmacılar'dan
            değişir.
          </Hint>
        </Section>
      )}
      <Section title="Stil">
        <StylePicker settings={settings} ground={ground} onChange={onChange} />
        <Hint>{preset.note}</Hint>
        {!!settings.overrides?.length && (
          <LinkButton type="button" className="justify-self-start" onClick={resetLook}>
            Stilin varsayılanlarına dön
          </LinkButton>
        )}
        <RowGroup>
          <RowLabel>Zemin</RowLabel>
          <Select
            label="Zemin"
            value={settings.background}
            options={BACKGROUNDS}
            onChange={(background) => set({ background })}
            disabled={disabled}
            render={(o, inList) => (
              <span className={OPT}>
                <span
                  className={`${TILE} bg-[linear-gradient(160deg,#6f8796,#2b3640)] text-[13px] font-extrabold text-white ${BG_LOOK[o.value]}`}
                  aria-hidden
                >
                  Aa
                </span>
                <span className={OPT_TEXT}>
                  <span className={OPT_TITLE}>{o.label}</span>
                  {inList && <span className={OPT_NOTE}>{BACKGROUNDS.find((b) => b.value === o.value)!.note}</span>}
                </span>
              </span>
            )}
          />
        </RowGroup>
        <Row>
          <RowLabel wide>Sesle vurgula</RowLabel>
          <Switch checked={settings.voiceEmphasis} onChange={(e) => set({ voiceEmphasis: e.target.checked })} />
        </Row>
        {settings.voiceEmphasis && (
          <Hint>Çevresindekilerden daha yüksek sesle söylenen kelimeler büyük ve vurgu renginde yazılır.</Hint>
        )}
      </Section>

      <Section title="Yazı">
        <Select<FontId>
          label="Yazı tipi"
          value={font.id}
          options={fontOptions}
          onChange={(font) => set({ font, weight: undefined })}
          disabled={disabled}
          canRemove={isUserFont}
          onRemove={(id) => {
            if (!isUserFont(id)) return;
            // The preset's font again, and no longer the user's choice.
            if (id === settings.font)
              onChange({
                ...settings,
                font: preset.defaults.font,
                weight: undefined,
                overrides: settings.overrides?.filter((k) => k !== "font"),
              });
            void removeFont(id);
          }}
          render={(o, inList) => {
            const f = fontById(o.value);
            const style = { fontFamily: captionStack(f.id), fontWeight: f.weight };
            // The sample is Turkish, so a caps-only font shows it uppercased.
            const sample = (t: string) => (f.capsOnly ? t.toLocaleUpperCase("tr-TR") : t);
            return inList ? (
              <span className="grid min-w-0 gap-px">
                <span className="text-[17px] leading-[1.2] text-balance" style={style}>
                  {sample("Pijamalı hasta yağız şoföre çabucak güvendi.")}
                </span>
                <span className={OPT_NOTE}>{f.label}</span>
              </span>
            ) : (
              <span className={OPT}>
                <span className={`${TILE} bg-bg text-[15px]`} style={style}>
                  {sample("Ağ")}
                </span>
                <span className={OPT_TITLE}>{f.label}</span>
              </span>
            );
          }}
        />
        <input
          ref={fontFile}
          type="file"
          accept=".ttf,.otf,.woff,.woff2"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = ""; // The same file can be picked again.
            if (file) void addFont(file);
          }}
        />
        <div>
          <LinkButton type="button" disabled={adding} onClick={() => fontFile.current?.click()}>
            {adding ? "Yazı tipi inceleniyor…" : "Bilgisayarından yazı tipi ekle"}
          </LinkButton>
        </div>
        {fontError && <p className="m-0 text-[12px] leading-normal text-mercan">{fontError}</p>}
        {lost && <Hint>Bu projenin yazı tipi bu tarayıcıda yok, yerine {font.label} kullanılıyor.</Hint>}
        {added?.missing && (
          <Hint>
            Bu yazı tipinde {[...added.missing].join(" ")} yok, bu harfler {FONTS[0].label} ile görünür.
          </Hint>
        )}
        {weights && (
          <Row>
            <RowLabel>Kalınlık</RowLabel>
            <Range
              min={weights[0]}
              max={weights[1]}
              step={10}
              value={captionWeight(font, settings.weight)}
              onChange={(e) => set({ weight: Number(e.target.value) })}
            />
            <RowValue>{captionWeight(font, settings.weight)}</RowValue>
          </Row>
        )}
        <Row>
          <RowLabel>İtalik</RowLabel>
          <Switch checked={!!settings.italic} onChange={(e) => set({ italic: e.target.checked })} />
        </Row>
        <Row>
          <RowLabel>Harf aralığı</RowLabel>
          <Range
            min={-0.05}
            max={0.2}
            step={0.005}
            value={settings.tracking ?? 0}
            onChange={(e) => set({ tracking: Number(e.target.value) })}
          />
          <RowValue>{Math.round((settings.tracking ?? 0) * 100)}</RowValue>
        </Row>
        <Row>
          <RowLabel>Boyut</RowLabel>
          <Range
            min={0.03}
            max={0.14}
            step={0.002}
            value={settings.size}
            onChange={(e) => set({ size: Number(e.target.value) })}
          />
          <RowValue>{Math.round(settings.size * 1000) / 10}</RowValue>
        </Row>
        <Row>
          <RowLabel>Büyük harf</RowLabel>
          <Switch
            checked={settings.uppercase || capsOnly}
            disabled={capsOnly}
            onChange={(e) => set({ uppercase: e.target.checked })}
          />
        </Row>
        {capsOnly && <Hint>Bu yazı tipinde küçük harf yok. "i" ile "ı" karışmasın diye altyazı hep büyük harfle yazılır.</Hint>}
      </Section>

      <Section title="Yerleşim">
        <RowGroup>
          <RowLabel>Konum</RowLabel>
          <Select
            label="Konum"
            value={settings.position}
            options={POSITIONS}
            onChange={(position) => set({ position })}
            disabled={disabled}
            render={(o) => (
              <span className={OPT}>
                <span className="relative h-5 w-[30px] flex-none rounded-[3px] border border-line bg-bg" aria-hidden>
                  <span className={`absolute inset-x-1.5 h-[3px] rounded-[2px] bg-fg-2 ${BAR_AT[o.value]}`} />
                </span>
                <span className={OPT_TITLE}>{o.label}</span>
              </span>
            )}
          />
        </RowGroup>
      </Section>

      <Section title="Renk">
        <Swatches label="Yazı" colors={TEXT_COLORS} value={settings.textColor} onChange={(textColor) => set({ textColor })} />
        {(preset.effect !== "none" || settings.voiceEmphasis) && (
          <Swatches label="Vurgu" colors={ACCENT_COLORS} value={settings.accentColor} onChange={(accentColor) => set({ accentColor })} />
        )}
      </Section>

      <LogoSection value={settings.logo} onChange={(logo) => set({ logo })} />
    </fieldset>
  );
}
