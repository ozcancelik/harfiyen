import { useEffect, useState } from "react";
import type { Word } from "../engine";
import { buildCues, importedCues } from "../lib/cues";
import { download, toJson, toSrt, toText, toVtt } from "../lib/exporters";
import { duration as fmtDuration, megabytes, remaining } from "../lib/format";
import type { BurnState } from "../lib/useBurner";
import { hasGpu } from "../render/compositor";
import {
  effectiveOutput,
  estimateSize,
  undecodable,
  resolutionOf,
  videoBitrate,
  type Encoder,
  type OutputCodec,
  type OutputQuality,
  type OutputResolution,
  type SourceInfo,
  type VideoOutput,
} from "../lib/videoOutput";
import { IconCheck, IconChevron, IconCpu, IconDownload, IconExport, IconGpu } from "./icons";
import { Meter } from "./Indicators";
import { OPT_NOTE, OPT_TITLE, Select } from "./Select";
import { LinkButton, toolbarButton } from "./ui";
import { Menu, MenuError, MenuFoot, MenuGroup, MenuItem, MenuNote, MenuTitle } from "./Menu";

const CODECS: { value: OutputCodec; label: string }[] = [
  { value: "avc", label: "H.264" },
  { value: "hevc", label: "HEVC" },
];
const QUALITIES: { value: OutputQuality; label: string }[] = [
  { value: "source", label: "Kaynakla aynı" },
  { value: "low", label: "Düşük" },
  { value: "medium", label: "Orta" },
  { value: "high", label: "Yüksek" },
  { value: "very-high", label: "Çok yüksek" },
];
const RESOLUTION_NAMES: Record<OutputResolution, string> = {
  source: "Kaynakla aynı",
  "2160": "4K",
  "1080": "1080p",
  "720": "720p",
};
const ENCODER: Record<Exclude<Encoder, null>, string> = { hardware: "Ekran kartı", software: "İşlemci" };

const mbps = (bits: number) => (bits / 1e6).toLocaleString("tr-TR", { maximumFractionDigits: 1 });
const codecName = (c: OutputCodec) => CODECS.find((o) => o.value === c)!.label;

/** Codec tile: the blue wash when selected; the full blue is kept for the main button. */
const TILE =
  "grid gap-0.5 rounded-ui-sm border border-line bg-pane-2 px-2.5 py-1.5 text-left text-fg transition-all duration-120 ease-[ease] disabled:opacity-40 aria-checked:border-[rgba(71,109,230,0.55)] aria-checked:bg-cini-wash aria-checked:text-white hover:not-disabled:not-aria-checked:bg-raised";

const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="grid gap-1.5">
    <span className="text-[12px] font-medium text-fg-2">{label}</span>
    {children}
  </div>
);

export function ExportMenu({
  words,
  baseName,
  videoName,
  captions,
  kinetic,
  photo,
  meta,
  speakers,
  complete,
  isVideo,
  canBurn,
  burn,
  output,
  onOutput,
  source,
  onBurn,
  onCancelBurn,
  onResetBurn,
}: {
  words: Word[];
  baseName: string;
  /** File name of the exported video. */
  videoName: string;
  /** Captions are drawn into the video (they can be hidden). */
  captions: boolean;
  /** The kinetic stage is drawn in place of the captions. */
  kinetic: boolean;
  /** An audio project's ground is the user's photo or video, not the aura. */
  photo: "image" | "video" | null;
  meta: Record<string, unknown>;
  /** The speakers' names, when they were told apart. */
  speakers?: string[];
  /** The transcript is final (subtitle files and video need it). */
  complete: boolean;
  isVideo: boolean;
  /** A file exists (recordings get one once stopped). */
  canBurn: boolean;
  burn: BurnState;
  /** Codec and quality as chosen; `source` decides what this file and browser allow. */
  output: VideoOutput;
  onOutput: (o: VideoOutput) => void;
  /** The file read beforehand; null while it is read. */
  source: SourceInfo | null;
  onBurn: () => void;
  onCancelBurn: () => void;
  /** Drops the finished video to choose other settings. */
  onResetBurn: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  // Without WebGPU the video is still made, on the 2D canvas; null while it is asked.
  const [gpu, setGpu] = useState<boolean | null>(null);
  useEffect(() => {
    void hasGpu().then(setGpu);
  }, []);
  // Open the menu by itself when a video render finishes.
  useEffect(() => {
    if (burn.status === "done") setOpen(true);
  }, [burn.status]);

  const has = words.length > 0;
  const out = effectiveOutput(output, source);
  const resolution = source && resolutionOf(out, source);
  const encoder = resolution?.encoders[out.codec];
  // A video written larger than its own picture.
  const upscaled = !!source?.video && !!resolution && resolution.height * resolution.width > source.width * source.height;
  const size = (o: VideoOutput) => (source ? `${megabytes(estimateSize(o, source))} MB` : "");
  const badCodec = undecodable(source);
  const canCreate = has && complete && canBurn && (!source || !!encoder) && !badCodec;
  const wide = `${toolbarButton({ primary: true })} w-full justify-center`;

  const cues = () => importedCues(words) ?? buildCues(words);
  const item = (label: string, note: string, onClick: () => void, enabled = has && complete) => (
    <MenuItem disabled={!enabled} onClick={onClick}>
      <span>{label}</span>
      <MenuNote>{note}</MenuNote>
    </MenuItem>
  );

  return (
    <Menu
      open={open}
      onOpenChange={setOpen}
      width="w-[320px]"
      trigger={
        <button
          className={toolbarButton({ primary: true, busy: burn.status === "running" })}
          aria-haspopup="menu"
          aria-expanded={open}
          disabled={!has}
          onClick={() => setOpen((o) => !o)}
        >
          <IconExport /> Dışa aktar <IconChevron size={12} />
        </button>
      }
    >
      <MenuGroup>
        <MenuTitle>{captions ? "Altyazılı video" : "Video (altyazısız)"}</MenuTitle>
        {burn.status === "running" ? (
          <div className="grid gap-2 px-2 pt-1 pb-2">
            <Meter value={burn.progress} className="w-full" />
            <div className="flex items-baseline justify-between gap-3">
              <MenuNote>
                Oluşturuluyor, %{Math.floor(burn.progress * 100)}
                {burn.remaining !== null
                  ? `, kalan ${remaining(burn.remaining)}`
                  : burn.fps > 0 && `, ${burn.fps.toFixed(0)} kare/sn`}
              </MenuNote>
              <LinkButton onClick={onCancelBurn}>Durdur</LinkButton>
            </div>
          </div>
        ) : burn.status === "done" ? (
          <div className="grid gap-2 px-2 pt-1 pb-2">
            {burn.url ? (
              <a className={wide} href={burn.url} download={videoName}>
                <IconDownload /> Videoyu indir
              </a>
            ) : (
              // Written straight into the file the user picked: nothing left to download.
              <p className="m-0 flex items-center gap-2 text-[12.5px] text-firuze">
                <IconCheck size={14} />
                <span className="min-w-0 truncate">{burn.saved} kaydedildi</span>
              </p>
            )}
            <div className="flex items-baseline justify-between gap-3">
              <MenuNote>
                MP4, {codecName(out.codec)}, {megabytes(burn.size)} MB, {fmtDuration(burn.elapsed)} sürdü
              </MenuNote>
              <LinkButton onClick={onResetBurn}>Yeniden oluştur</LinkButton>
            </div>
          </div>
        ) : (
          <div className="grid gap-3 px-2 pt-1 pb-2">
            {/* Only when there is a choice. */}
            {source && resolution && source.resolutions.length > 1 && (
              <Field label="Çözünürlük">
                <Select<OutputResolution>
                  label="Çözünürlük"
                  value={resolution.value}
                  options={source.resolutions.map((r) => ({ value: r.value, label: RESOLUTION_NAMES[r.value] }))}
                  onChange={(value) => onOutput({ ...output, resolution: value })}
                  render={(o) => {
                    const r = source.resolutions.find((x) => x.value === o.value)!;
                    return (
                      <span className="flex min-w-0 items-baseline justify-between gap-3">
                        <span className={OPT_TITLE}>{o.label}</span>
                        <span className={`${OPT_NOTE} flex-none tabular-nums`}>
                          {r.width}×{r.height}
                        </span>
                      </span>
                    );
                  }}
                />
                {upscaled && <MenuNote>Görüntü büyütülür; altyazı bu boyutta çizildiği için keskin çıkar.</MenuNote>}
              </Field>
            )}
            <Field label="Video kodlaması">
              <div className="grid grid-cols-2 gap-1.5" role="radiogroup" aria-label="Video kodlaması">
                {CODECS.map((c) => {
                  const e = resolution?.encoders[c.value];
                  return (
                    <button
                      key={c.value}
                      type="button"
                      role="radio"
                      aria-checked={c.value === out.codec}
                      disabled={!!source && !e}
                      onClick={() => onOutput({ ...output, codec: c.value })}
                      className={TILE}
                    >
                      <span className="text-[12.5px] font-[560]">{c.label}</span>
                      <span className="flex items-center gap-1 text-[11.5px] text-fg-3">
                        {e === "hardware" ? <IconGpu size={13} /> : e === "software" ? <IconCpu size={13} /> : null}
                        {source ? (e ? ENCODER[e] : "Bu tarayıcıda yok") : "Bakılıyor…"}
                      </span>
                    </button>
                  );
                })}
              </div>
            </Field>
            <Field label="Kalite">
              <Select<OutputQuality>
                label="Kalite"
                value={out.quality}
                options={QUALITIES.filter((q) => q.value !== "source" || (source ? !!source.video : isVideo))}
                onChange={(quality) => onOutput({ ...output, quality })}
                render={(q, inList) => {
                  const o = { ...out, quality: q.value };
                  return (
                    <span className="flex min-w-0 items-baseline justify-between gap-3">
                      <span className={OPT_TITLE}>{q.label}</span>
                      {source && (
                        <span className={`${OPT_NOTE} flex-none tabular-nums`}>
                          {mbps(videoBitrate(o, source))} Mbps{inList && `, ${size(o)}`}
                        </span>
                      )}
                    </span>
                  );
                }}
              />
            </Field>
            <div className="grid gap-1.5">
              <button className={wide} disabled={!canCreate} onClick={onBurn}>
                Videoyu oluştur
              </button>
              {badCodec ? (
                <MenuNote>Bu tarayıcı {badCodec} kodlamasını çözemiyor; video Chrome'da oluşturulabilir.</MenuNote>
              ) : (
                <MenuNote>
                  {isVideo
                    ? kinetic
                      ? "Kinetik tipografi görüntüye yazılır"
                      : captions
                        ? "Altyazı görüntüye yazılır"
                        : "Altyazısız; varsa kadraj ve logoyla"
                    : kinetic
                      ? "Ses ve kinetik tipografi"
                      : captions
                        ? `Ses, ${photo === "video" ? "arka plan videosu" : photo ? "fotoğraf" : "hareketli aura"} ve altyazı`
                        : `Ses ve ${photo === "video" ? "arka plan videosu" : photo ? "fotoğraf" : "hareketli aura"}, altyazısız; varsa logoyla`}
                  , MP4
                  {source && `, yaklaşık ${size(out)}`}.
                </MenuNote>
              )}
              {!badCodec && gpu === false && (
                <MenuNote>Ekran kartı kullanılamıyor: video daha yavaş oluşur, buzlu cam ve aura sadeleşir.</MenuNote>
              )}
            </div>
          </div>
        )}
        {burn.status === "error" && <MenuError>{burn.message}</MenuError>}
      </MenuGroup>
      <MenuGroup>
        <MenuTitle>Altyazı dosyası</MenuTitle>
        {item("SRT", "Çoğu oynatıcı ve kurgu programı", () => download(`${baseName}.srt`, toSrt(cues(), speakers), "application/x-subrip"))}
        {item("WebVTT", "Web ve YouTube", () => download(`${baseName}.vtt`, toVtt(cues(), speakers), "text/vtt"))}
      </MenuGroup>
      <MenuGroup>
        <MenuTitle>Metin</MenuTitle>
        {item("Düz metin", "TXT, paragraflar", () => download(`${baseName}.txt`, toText(words, speakers), "text/plain"), has)}
        {item("Kelime zamanları", "JSON", () => download(`${baseName}.json`, toJson(words, meta, speakers), "application/json"), has)}
        {item(
          copied ? "Kopyalandı" : "Metni kopyala",
          "Panoya",
          async () => {
            await navigator.clipboard.writeText(toText(words, speakers));
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          },
          has,
        )}
      </MenuGroup>
      {!complete && <MenuFoot>Altyazı ve video, yazıya döküm bitince hazır olur.</MenuFoot>}
    </Menu>
  );
}
