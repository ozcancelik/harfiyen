import type { SpeechLang } from "../engine";
import { MAIN_LANGS, SPEECH_LANGS } from "../engine/languages";
import { LANG_NAMES } from "../lib/lang";
import { OPT_NOTE, OPT_TITLE, Select, type Option } from "./Select";

const OPTIONS: Option<SpeechLang>[] = SPEECH_LANGS.map((l) => ({
  value: l.code,
  label: l.name,
  group: MAIN_LANGS.includes(l.code) ? "Ana diller" : "Diğer diller",
}));

/** The language spoken in the media, chosen before transcribing. */
export function VideoLang({
  value,
  onChange,
  disabled,
}: {
  value: SpeechLang;
  onChange: (l: SpeechLang) => void;
  disabled?: boolean;
}) {
  return (
    <span className="flex min-w-0 items-center gap-2.5 text-[12px] text-fg-2">
      <span className="flex-none">Videodaki dil</span>
      <Select<SpeechLang>
        label="Videodaki dil"
        value={value}
        options={OPTIONS}
        onChange={onChange}
        disabled={disabled}
        render={(o, inList) => (
          <span className="flex min-w-0 items-baseline justify-between gap-3">
            <span className={OPT_TITLE}>{o.label}</span>
            {inList && !MAIN_LANGS.includes(o.value) && <span className={`${OPT_NOTE} flex-none`}>deneysel</span>}
          </span>
        )}
      />
    </span>
  );
}

/** Why the chosen model cannot transcribe `lang`, if it cannot; `gpuReason`: why Whisper cannot run here. */
export function langProblem(lang: SpeechLang, modelName: string, modelLangs: SpeechLang[], gpuReason: string | null) {
  if (modelLangs.includes(lang)) return null;
  if (gpuReason) return `${LANG_NAMES[lang]} yalnızca Whisper ile yazıya dökülür; Whisper bu cihazda çalışmıyor. ${gpuReason}`;
  return `${modelName} yalnızca Türkçe anlar; ${LANG_NAMES[lang]} için üst çubuktan Whisper Turbo ya da Whisper Turbo Hafif'i seç.`;
}
