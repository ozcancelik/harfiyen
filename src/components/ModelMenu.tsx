import { useState } from "react";
import type { SpeechLang } from "../engine";
import { LANG_NAMES } from "../lib/lang";
import { MODELS, modelInfo, type ModelId } from "../models";
import { IconCheck, IconChevron, IconWave } from "./icons";
import { Menu, MenuFoot, MenuGroup, MenuItem, MenuNote, MenuTitle } from "./Menu";
import { TbLabel, toolbarButton } from "./ui";

export interface ModelProps {
  value: ModelId;
  onChange: (m: ModelId) => void;
  /** Why GPU-only models cannot run here, if they cannot. */
  gpuReason: string | null;
  /** A transcription is running; switching would abort it. */
  locked: boolean;
  /** The language spoken in the media: models that do not know it are not offered. */
  lang: SpeechLang;
  /** Models already stored in the browser cache (ready offline). */
  cached?: ReadonlySet<ModelId>;
  /** Browser is offline: uncached models cannot be downloaded right now. */
  offline?: boolean;
}

/** Toolbar control: which speech model transcribes. */
export function ModelMenu(props: ModelProps) {
  const [open, setOpen] = useState(false);
  const current = modelInfo(props.value);

  return (
    <Menu
      open={open}
      onOpenChange={setOpen}
      width="w-[320px]"
      trigger={
        <button
          className={toolbarButton()}
          aria-haspopup="menu"
          aria-expanded={open}
          title={`Model: ${current.name} (${current.tier})`}
          onClick={() => setOpen((o) => !o)}
        >
          <span className="inline-grid place-items-center text-fg-2">
            <IconWave />
          </span>
          <TbLabel>{current.name}</TbLabel>
          <IconChevron size={12} />
        </button>
      }
    >
      <ModelChoices {...props} onDone={() => setOpen(false)} />
    </Menu>
  );
}

/** The models to pick from; also in the phone toolbar's "⋯" menu. */
export function ModelChoices({
  value,
  onChange,
  gpuReason,
  locked,
  lang,
  cached,
  offline,
  onDone,
}: ModelProps & { onDone: () => void }) {
  return (
    <>
      <MenuGroup>
        <MenuTitle>Yazıya döken model</MenuTitle>
        {MODELS.map((m) => {
          const isCached = cached?.has(m.id) ?? false;
          const unavailable = !m.langs.includes(lang)
            ? `Yalnızca ${m.langs.map((l) => LANG_NAMES[l]).join(" ve ")}; videodaki dil ${LANG_NAMES[lang]}.`
            : m.gpuOnly && gpuReason
              ? gpuReason
              : offline && !isCached
                ? "Henüz indirilmedi; çevrimdışıyken kullanılamaz."
                : null;
          return (
            <MenuItem
              key={m.id}
              choice
              role="menuitemradio"
              aria-checked={m.id === value}
              disabled={locked || (!!unavailable && m.id !== value)}
              onClick={() => {
                onDone();
                if (m.id !== value) onChange(m.id);
              }}
            >
              <span className="grid h-[18px] w-[14px] flex-none place-items-center" aria-hidden>
                {m.id === value && <IconCheck size={14} />}
              </span>
              <span className="grid gap-0.5">
                <span className="flex items-baseline gap-2">
                  <span>{m.name}</span>
                  <MenuNote>
                    {m.tier} · {m.size}
                    {isCached && <span className="text-firuze"> · İndirildi</span>}
                  </MenuNote>
                </span>
                <MenuNote>{unavailable ?? m.note}</MenuNote>
              </span>
            </MenuItem>
          );
        })}
      </MenuGroup>
      <MenuFoot>Model ilk kullanımda indirilir ve bu tarayıcıda saklanır. Ayarlar → Modeller'den indirilip silinebilir.</MenuFoot>
      {locked && <MenuFoot>Yazıya dökme sürerken değiştirilemez.</MenuFoot>}
    </>
  );
}
