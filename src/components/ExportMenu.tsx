import { useEffect, useRef, useState } from "react";
import type { Word } from "../engine";
import { buildCues } from "../lib/cues";
import { download, toJson, toSrt, toText, toVtt } from "../lib/exporters";
import { duration as fmtDuration, megabytes } from "../lib/format";
import type { BurnState } from "../lib/useBurner";
import { IconChevron, IconExport } from "./icons";

export function ExportMenu({
  words,
  baseName,
  meta,
  complete,
  isVideo,
  canBurn,
  burn,
  onBurn,
  onCancelBurn,
}: {
  words: Word[];
  baseName: string;
  meta: Record<string, unknown>;
  /** The transcript is final (subtitle files and video need it). */
  complete: boolean;
  isVideo: boolean;
  /** A file exists (recordings get one once stopped). */
  canBurn: boolean;
  burn: BurnState;
  onBurn: () => void;
  onCancelBurn: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  // Open the menu by itself when a video render finishes.
  useEffect(() => {
    if (burn.status === "done") setOpen(true);
  }, [burn.status]);

  const has = words.length > 0;
  const cues = () => buildCues(words);
  const item = (label: string, note: string, onClick: () => void, enabled = has && complete) => (
    <button className="menu__item" role="menuitem" disabled={!enabled} onClick={onClick}>
      <span>{label}</span>
      <span className="menu__note">{note}</span>
    </button>
  );

  return (
    <div className="menu-root" ref={root}>
      <button
        className={`tb-btn tb-btn--primary${burn.status === "running" ? " tb-btn--busy" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={!has}
        onClick={() => setOpen((o) => !o)}
      >
        <IconExport /> Dışa aktar <IconChevron size={12} />
      </button>
      {open && (
        <div className="menu" role="menu">
          <div className="menu__group">
            <span className="menu__title">Video</span>
            {burn.status === "running" ? (
              <div className="menu__progress">
                <div className="progress">
                  <span style={{ transform: `scaleX(${burn.progress})` }} />
                </div>
                <span className="menu__note">
                  Oluşturuluyor, %{Math.floor(burn.progress * 100)}
                  {burn.fps > 0 && `, ${burn.fps.toFixed(0)} kare/sn`}
                </span>
                <button className="link" onClick={onCancelBurn}>
                  Durdur
                </button>
              </div>
            ) : burn.status === "done" ? (
              <a className="menu__item menu__item--ready" href={burn.url} download={`${baseName}.altyazili.mp4`}>
                <span>Altyazılı MP4'ü indir</span>
                <span className="menu__note">
                  {megabytes(burn.size)} MB, {fmtDuration(burn.elapsed)} sürdü
                </span>
              </a>
            ) : (
              item(
                "Altyazılı video oluştur",
                isVideo ? "Altyazı görüntüye yazılır, MP4" : "Ses + hareketli aura + altyazı, MP4",
                onBurn,
                has && complete && canBurn,
              )
            )}
            {burn.status === "error" && <p className="menu__error">{burn.message}</p>}
          </div>
          <div className="menu__group">
            <span className="menu__title">Altyazı dosyası</span>
            {item("SRT", "Çoğu oynatıcı ve kurgu programı", () => download(`${baseName}.srt`, toSrt(cues()), "application/x-subrip"))}
            {item("WebVTT", "Web ve YouTube", () => download(`${baseName}.vtt`, toVtt(cues()), "text/vtt"))}
          </div>
          <div className="menu__group">
            <span className="menu__title">Metin</span>
            {item("Düz metin", "TXT, paragraflar", () => download(`${baseName}.txt`, toText(words), "text/plain"), has)}
            {item("Kelime zamanları", "JSON", () => download(`${baseName}.json`, toJson(words, meta), "application/json"), has)}
            {item(
              copied ? "Kopyalandı" : "Metni kopyala",
              "Panoya",
              async () => {
                await navigator.clipboard.writeText(toText(words));
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              },
              has,
            )}
          </div>
          {!complete && <p className="menu__foot">Altyazı ve video, yazıya döküm bitince hazır olur.</p>}
        </div>
      )}
    </div>
  );
}
