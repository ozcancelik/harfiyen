import { useEffect, useRef, useState } from "react";
import type { EngineState } from "../lib/useTranscriber";
import type { ProviderChoice } from "../worker/protocol";
import { IconAuto, IconCheck, IconChevron, IconCpu, IconGpu } from "./icons";

const CHOICES: { value: ProviderChoice; label: string; note: string; Icon: typeof IconCpu }[] = [
  {
    value: "auto",
    label: "Otomatik",
    note: "Ekran kartı varsa onu kullanır, sorun çıkarsa işlemciye geçer.",
    Icon: IconAuto,
  },
  { value: "webgpu", label: "Ekran kartı (WebGPU)", note: "En hızlısı.", Icon: IconGpu },
  { value: "wasm", label: "İşlemci (WASM)", note: "Daha yavaş, ama her cihazda çalışır.", Icon: IconCpu },
];

/** Toolbar control: where the model runs, and what it runs on right now. */
export function ProviderMenu({
  value,
  engine,
  onChange,
  locked,
}: {
  value: ProviderChoice;
  engine: EngineState;
  onChange: (p: ProviderChoice) => void;
  /** A transcription is running; switching would abort it. */
  locked: boolean;
}) {
  const [open, setOpen] = useState(false);
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

  // Once loaded, show what it actually runs on (a GPU failure moves it to the CPU).
  const ready = engine.phase === "ready" ? engine : null;
  const current = ready ? (ready.provider === "wasm" ? "wasm" : "webgpu") : value;
  const shown = CHOICES.find((c) => c.value === current)!;

  return (
    <div className="menu-root" ref={root}>
      <button
        className="tb-btn tb-btn--provider"
        aria-haspopup="menu"
        aria-expanded={open}
        title={ready?.gpu ?? ready?.fallbackReason ?? "Modelin çalıştığı yer"}
        onClick={() => setOpen((o) => !o)}
      >
        <span className={`provider-icon provider-icon--${current}`}>
          <shown.Icon />
        </span>
        <span className="tb-btn__label">{shown.label.split(" (")[0]}</span>
        <IconChevron size={12} />
      </button>
      {open && (
        <div className="menu" role="menu">
          <div className="menu__group">
            <span className="menu__title">Model nerede çalışsın</span>
            {CHOICES.map((c) => (
              <button
                key={c.value}
                className="menu__item menu__item--choice"
                role="menuitemradio"
                aria-checked={c.value === value}
                disabled={locked}
                onClick={() => {
                  setOpen(false);
                  if (c.value !== value) onChange(c.value);
                }}
              >
                <span className="menu__check" aria-hidden>
                  {c.value === value && <IconCheck size={14} />}
                </span>
                <span className={`menu__icon provider-icon provider-icon--${c.value}`}>
                  <c.Icon />
                </span>
                <span className="menu__choice">
                  <span>{c.label}</span>
                  <span className="menu__note">{c.note}</span>
                </span>
              </button>
            ))}
          </div>
          {ready?.fallbackReason && <p className="menu__foot">{ready.fallbackReason}</p>}
          {ready?.gpu && <p className="menu__foot">Şu an: {ready.gpu}</p>}
          {locked && <p className="menu__foot">Yazıya dökme sürerken değiştirilemez.</p>}
        </div>
      )}
    </div>
  );
}
