import type { DecodingMethod } from "../engine";
import { Select } from "./Select";

const METHODS: { value: DecodingMethod; label: string; note: string }[] = [
  { value: "beam-lm", label: "En doğru", note: "Dil modeliyle; özel adlarda ve uzun cümlelerde daha az hata." },
  { value: "beam", label: "Dengeli", note: "Dil modeli olmadan, dört yollu arama." },
  { value: "greedy", label: "Hızlı", note: "Tek yollu arama, en kısa sürede biter." },
];

export function MethodPicker({
  value,
  onChange,
  disabled,
}: {
  value: DecodingMethod;
  onChange: (m: DecodingMethod) => void;
  disabled?: boolean;
}) {
  return (
    <Select
      label="Doğruluk"
      value={value}
      options={METHODS}
      onChange={onChange}
      disabled={disabled}
      render={(o, inList) => (
        <span className="opt">
          <span className={`opt__meter opt__meter--${o.value}`} aria-hidden>
            <span />
            <span />
            <span />
          </span>
          <span className="opt__text">
            <span className="opt__title">{o.label}</span>
            {inList && <span className="opt__note">{METHODS.find((m) => m.value === o.value)!.note}</span>}
          </span>
        </span>
      )}
    />
  );
}

export const methodTitle = (id: DecodingMethod) => METHODS.find((m) => m.value === id)!.label;
