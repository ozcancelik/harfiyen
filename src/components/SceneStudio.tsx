import { useRef, useState } from "react";
import { shownPicture, type CaptionSettings } from "../captions/style";
import type { GroundPreview } from "../lib/groundPreview";
import { removePhoto, setPhotoFile, usePhoto } from "../lib/photo";
import { AURA_PALETTES, AURA_STYLES, paletteById, type AuraPaletteId, type AuraStyleId } from "../render/aura";
import { DEFAULT_KINETIC, kineticPaletteById } from "../render/kinetic";
import { STUDIO } from "./CaptionStudio";
import { KineticControls } from "./KineticStudio";
import { OPT, OPT_TITLE, Select } from "./Select";
import { Hint, LinkButton, RowGroup, RowLabel, Section } from "./ui";

/** What is written over the picture. */
export type TextMode = "captions" | "kinetic" | "none";

/** The text mode as the settings keep it: kinetic.on and hidden. */
const textModeOf = (s: CaptionSettings): TextMode =>
  s.kinetic?.on ? "kinetic" : s.hidden ? "none" : "captions";

/** `video` is the note for a project with a picture. */
const TEXT_MODES: { value: TextMode; label: string; note: string; video: string }[] = [
  {
    value: "captions",
    label: "Altyazı",
    note: "Arka planın üstünde altyazı; görünümü Altyazı sekmesinde.",
    video: "Görüntünün üstünde altyazı; görünümü Altyazı sekmesinde.",
  },
  {
    value: "kinetic",
    label: "Kinetik",
    note: "Altyazı yerine bütün ekranı kullanan kinetik tipografi.",
    video: "Altyazı yerine bütün ekranı kullanan kinetik tipografi.",
  },
  {
    value: "none",
    label: "Yok",
    note: "Yalnız arka plan; SRT, VTT ve metin dışa aktarımları etkilenmez.",
    video: "Yazısız; varsa kadraj, logo ve seslendirme kalır. SRT, VTT ve metin dışa aktarımları etkilenmez.",
  },
];

/** A video's own picture as the ground; `kinetic` is the note under the kinetic stage. */
const PICTURES: { value: "video" | "blur"; label: string; note: string; kinetic: string }[] = [
  {
    value: "video",
    label: "Görüntü",
    note: "Videonun görüntüsü olduğu gibi.",
    kinetic: "Videonun görüntüsü, üstünde paletin zemininden ince bir perde.",
  },
  {
    value: "blur",
    label: "Bulanık",
    note: "Görüntü bulanık ve koyu; yazı her görüntüde okunur.",
    kinetic: "Görüntü bulanık ve koyu; yazı her görüntüde okunur.",
  },
];

/** The photo or background video as it is or blurred (a picture's "video" and "blur"). */
const PHOTO_LOOKS: {
  blur: boolean;
  label: string;
  note: string;
  kinetic: string;
  videoNote: string;
  videoKinetic: string;
}[] = [
  {
    blur: false,
    label: "Net",
    note: "Fotoğraf kareyi kaplar, taşan kısmı kesilir.",
    kinetic: "Fotoğraf kareyi kaplar, üstünde paletin zemininden ince bir perde.",
    videoNote: "Video sessizce döngüde oynar ve kareyi kaplar, taşan kısmı kesilir.",
    videoKinetic: "Video sessizce döngüde oynar; üstünde paletin zemininden ince bir perde.",
  },
  {
    blur: true,
    label: "Bulanık",
    note: "Fotoğraf bulanık ve koyu; yazı her fotoğrafta okunur.",
    kinetic: "Fotoğraf bulanık ve koyu; yazı her fotoğrafta okunur.",
    videoNote: "Video bulanık, koyu ve sessiz döngüde; yazı her görüntüde okunur.",
    videoKinetic: "Video bulanık, koyu ve sessiz döngüde; yazı her görüntüde okunur.",
  },
];

const CHOICE =
  "h-[26px] rounded-ui border border-line bg-raised text-[12px] text-fg-2 hover:not-disabled:text-fg aria-pressed:border-cini aria-pressed:text-fg-strong disabled:opacity-45";

/**
 * The Sahne tab: how the picture is made. What is written (captions, kinetic
 * typography or nothing) and what is behind it: one of the auras or the user's
 * photo for an audio project, the picture (as it is or blurred) for a video,
 * or the kinetic palette's own plain ground.
 */
export function SceneStudio({
  settings,
  ground,
  onChange,
  onCaptions,
  video = false,
  disabled,
}: {
  settings: CaptionSettings;
  /** The project's ground, behind the kinetic cards. */
  ground?: GroundPreview;
  onChange: (s: CaptionSettings) => void;
  /** Opens the Altyazı tab. */
  onCaptions: () => void;
  /** The project has a picture: the kinetic stage goes over it, not over an aura. */
  video?: boolean;
  disabled?: boolean;
}) {
  const kinetic = settings.kinetic ?? DEFAULT_KINETIC;
  const mode = textModeOf(settings);
  const modeInfo = TEXT_MODES.find((m) => m.value === mode)!;
  // A video's own picture, when it is the ground; else the aura or the plain ground, as in an audio project.
  const pic = shownPicture(settings, video);
  const picInfo = PICTURES.find((p) => p.value === pic);
  const plain = !pic && mode === "kinetic" && kinetic.backdrop === "stage";
  const usesPhoto = !pic && !plain && !!settings.photo;
  const auraStyle = settings.auraStyle ?? "aura";
  const { photo } = usePhoto();
  const photoFile = useRef<HTMLInputElement>(null);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [photoError, setPhotoError] = useState<string | null>(null);

  const setMode = (m: TextMode) =>
    onChange({ ...settings, hidden: m === "none", kinetic: { ...kinetic, on: m === "kinetic" } });
  // An aura or the plain ground in a video: the file is used for its sound.
  const leaveOut = video ? { picture: "hidden" as const } : {};
  const setAura = (style: AuraStyleId) =>
    onChange({ ...settings, ...leaveOut, auraStyle: style, photo: false, kinetic: { ...kinetic, backdrop: "aura" } });
  const setPlain = () =>
    onChange({ ...settings, ...leaveOut, photo: false, kinetic: { ...kinetic, backdrop: "stage" } });
  // The photo stands where the aura does, so the kinetic stage goes over it as over the aura.
  const setPhoto = () => {
    onChange({ ...settings, ...leaveOut, photo: true, kinetic: { ...kinetic, backdrop: "aura" } });
    if (!photo) photoFile.current?.click();
  };
  const addPhoto = async (f: File) => {
    setPhotoBusy(true);
    setPhotoError(null);
    try {
      await setPhotoFile(f);
    } catch (e) {
      setPhotoError(e instanceof Error ? e.message : String(e));
    } finally {
      setPhotoBusy(false);
    }
  };

  return (
    <fieldset className={STUDIO} disabled={disabled}>
      <Section title="Yazı">
        <div className="grid grid-cols-3 gap-1.5" role="group" aria-label="Ekrandaki yazı">
          {TEXT_MODES.map((m) => (
            <button
              key={m.value}
              type="button"
              className={CHOICE}
              aria-pressed={mode === m.value}
              onClick={() => setMode(m.value)}
            >
              {m.label}
            </button>
          ))}
        </div>
        <Hint>{video ? modeInfo.video : modeInfo.note}</Hint>
        {mode === "captions" && (
          <LinkButton type="button" className="justify-self-start" onClick={onCaptions}>
            Altyazının görünümünü ayarla
          </LinkButton>
        )}
      </Section>

      {mode === "kinetic" && (
        <KineticControls
          kinetic={kinetic}
          ground={ground}
          onChange={(k) => onChange({ ...settings, kinetic: k })}
          disabled={disabled}
        />
      )}

      <Section title="Arka plan">
        {video && (
          <div className="grid grid-cols-2 gap-1.5" role="group" aria-label="Videonun görüntüsü">
            {PICTURES.map((p) => (
              <button
                key={p.value}
                type="button"
                className={CHOICE}
                aria-pressed={pic === p.value}
                onClick={() => onChange({ ...settings, picture: p.value })}
              >
                {p.label}
              </button>
            ))}
          </div>
        )}
        <div className="grid grid-cols-3 gap-1.5" role="group" aria-label={video ? "Görüntü yerine" : "Arka plan"}>
          {AURA_STYLES.map((st) => (
            <button
              key={st.id}
              type="button"
              className={CHOICE}
              aria-pressed={!pic && !plain && !usesPhoto && auraStyle === st.id}
              onClick={() => setAura(st.id)}
            >
              {st.label}
            </button>
          ))}
          <button type="button" className={CHOICE} aria-pressed={usesPhoto} onClick={setPhoto}>
            Medya
          </button>
          {mode === "kinetic" && (
            <button type="button" className={CHOICE} aria-pressed={plain} onClick={setPlain}>
              Düz
            </button>
          )}
        </div>
        <input
          ref={photoFile}
          type="file"
          accept="image/jpeg,image/png,image/webp,image/svg+xml,video/mp4,video/webm,video/quicktime"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = ""; // The same file can be picked again.
            if (f) void addPhoto(f);
          }}
        />
        {picInfo ? (
          <Hint>{mode === "kinetic" ? picInfo.kinetic : picInfo.note}</Hint>
        ) : usesPhoto ? (
          <>
            {photo ? (
              <>
                <div className="flex min-w-0 items-center gap-2.5">
                  <img
                    src={photo.thumbUrl}
                    alt=""
                    className="h-9 w-12 flex-none rounded-ui-sm border border-line object-cover"
                  />
                  <span className="min-w-0 flex-1 truncate text-[12.5px] text-fg-2">{photo.name}</span>
                  <LinkButton type="button" disabled={photoBusy} onClick={() => photoFile.current?.click()}>
                    Değiştir
                  </LinkButton>
                  <LinkButton
                    type="button"
                    onClick={() => void removePhoto().then(() => onChange({ ...settings, photo: false }))}
                  >
                    Kaldır
                  </LinkButton>
                </div>
                <div className="grid grid-cols-2 gap-1.5" role="group" aria-label="Medyanın görünümü">
                  {PHOTO_LOOKS.map((l) => (
                    <button
                      key={l.label}
                      type="button"
                      className={CHOICE}
                      aria-pressed={!!settings.photoBlur === l.blur}
                      onClick={() => onChange({ ...settings, photoBlur: l.blur })}
                    >
                      {l.label}
                    </button>
                  ))}
                </div>
                <Hint>
                  {video && "Görüntü kullanılmaz, yalnız sesi. "}
                  {(() => {
                    const look = PHOTO_LOOKS.find((l) => l.blur === !!settings.photoBlur)!;
                    if (photo.kind === "video") return mode === "kinetic" ? look.videoKinetic : look.videoNote;
                    return mode === "kinetic" ? look.kinetic : look.note;
                  })()}{" "}
                  Bu tarayıcıda saklanır, sonraki projelerde de hazırdır.
                </Hint>
              </>
            ) : (
              <>
                <div>
                  <LinkButton type="button" disabled={photoBusy} onClick={() => photoFile.current?.click()}>
                    {photoBusy ? "Medya açılıyor…" : "Bilgisayarından fotoğraf ya da video ekle"}
                  </LinkButton>
                </div>
                <Hint>
                  Fotoğraf (JPEG, PNG, WebP) ya da video (MP4, WebM, MOV). Kareyi kaplar, video sessizce döngüde oynar;
                  eklenene kadar aura görünür.
                </Hint>
              </>
            )}
            {photoError && <p className="m-0 text-[12px] leading-normal text-mercan">{photoError}</p>}
          </>
        ) : plain ? (
          <Hint>
            {video && "Görüntü kullanılmaz, yalnız sesi. "}Kinetik paletin kendi zemini (
            {kineticPaletteById(kinetic.palette).label}); sesle hafifçe parlar.
          </Hint>
        ) : (
          <>
            <RowGroup>
              <RowLabel>Renkler</RowLabel>
              <Select<AuraPaletteId>
                label="Arka plan renkleri"
                value={settings.aura}
                options={AURA_PALETTES.map((p) => ({ value: p.id, label: p.label }))}
                onChange={(aura) => onChange({ ...settings, aura })}
                disabled={disabled}
                render={(o) => {
                  const [a, b, c] = paletteById(o.value).colors;
                  return (
                    <span className={OPT}>
                      <span
                        className="h-[22px] w-[30px] flex-none rounded-ui-sm"
                        aria-hidden
                        style={{
                          background: `radial-gradient(circle at 30% 40%, ${a}, transparent 60%), radial-gradient(circle at 70% 60%, ${b}, transparent 55%), radial-gradient(circle at 50% 90%, ${c}, transparent 50%), #05070b`,
                        }}
                      />
                      <span className={OPT_TITLE}>{o.label}</span>
                    </span>
                  );
                }}
              />
            </RowGroup>
            <Hint>
              {video && "Görüntü kullanılmaz, yalnız sesi. "}
              {AURA_STYLES.find((st) => st.id === auraStyle)?.note}
            </Hint>
          </>
        )}
      </Section>
    </fieldset>
  );
}
