import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { IconCheck, IconUpDown } from "./icons";

export interface Option<T extends string> {
  value: T;
  /** Accessible name. */
  label: string;
}

/**
 * Dropdown whose options preview themselves (fonts in their own typeface,
 * styles as tiny renderings). The list opens in a fixed layer so the
 * scrolling inspector never clips it. Keyboard: arrows, Home/End, Enter,
 * Escape, and type-to-jump.
 */
export function Select<T extends string>({
  label,
  value,
  options,
  onChange,
  render,
  disabled,
}: {
  label: string;
  value: T;
  options: Option<T>[];
  onChange: (v: T) => void;
  /** Renders an option; `inList` is false for the closed button. */
  render: (o: Option<T>, inList: boolean) => React.ReactNode;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<{ left: number; top: number; width: number; maxHeight: number; up: boolean } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const id = useId();
  const selected = Math.max(0, options.findIndex((o) => o.value === value));

  const place = () => {
    const r = button.current!.getBoundingClientRect();
    const below = window.innerHeight - r.bottom - 8;
    const above = r.top - 8;
    const up = below < 220 && above > below;
    setPos({
      left: r.left,
      top: up ? r.top - 4 : r.bottom + 4,
      width: r.width,
      maxHeight: Math.min(380, up ? above : below),
      up,
    });
  };

  const show = () => {
    if (disabled) return;
    place();
    setActive(selected);
    setOpen(true);
  };

  const choose = (i: number) => {
    onChange(options[i].value);
    setOpen(false);
    button.current?.focus();
  };

  useLayoutEffect(() => {
    if (open) list.current?.children[active]?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  useEffect(() => {
    if (!open) return;
    list.current?.focus();
    const away = (e: Event) => {
      const t = e.target as Node;
      if (!list.current?.contains(t) && !button.current?.contains(t)) setOpen(false);
    };
    const reflow = (e: Event) => {
      if (!list.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    window.addEventListener("resize", reflow);
    document.addEventListener("scroll", reflow, true);
    return () => {
      document.removeEventListener("pointerdown", away);
      window.removeEventListener("resize", reflow);
      document.removeEventListener("scroll", reflow, true);
    };
  }, [open]);

  const typed = useRef({ text: "", at: 0 });
  const onListKey = (e: React.KeyboardEvent) => {
    const n = options.length;
    if (e.key === "ArrowDown") setActive((a) => Math.min(n - 1, a + 1));
    else if (e.key === "ArrowUp") setActive((a) => Math.max(0, a - 1));
    else if (e.key === "Home") setActive(0);
    else if (e.key === "End") setActive(n - 1);
    else if (e.key === "Enter" || e.key === " ") choose(active);
    else if (e.key === "Escape" || e.key === "Tab") {
      setOpen(false);
      if (e.key === "Escape") button.current?.focus();
      if (e.key === "Tab") return;
    } else if (e.key.length === 1) {
      const now = Date.now();
      const t = typed.current;
      t.text = now - t.at < 700 ? t.text + e.key : e.key;
      t.at = now;
      const i = options.findIndex((o) => o.label.toLocaleLowerCase("tr").startsWith(t.text.toLocaleLowerCase("tr")));
      if (i >= 0) setActive(i);
    } else return;
    e.preventDefault();
  };

  return (
    <>
      <button
        ref={button}
        type="button"
        className={`select${open ? " select--open" : ""}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={id}
        aria-label={`${label}: ${options[selected]?.label}`}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={(e) => {
          if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) {
            e.preventDefault();
            show();
          }
        }}
      >
        <span className="select__value">{options[selected] && render(options[selected], false)}</span>
        <span className="select__arrow" aria-hidden>
          <IconUpDown size={14} />
        </span>
      </button>
      {open && pos && (
        <ul
          ref={list}
          id={id}
          role="listbox"
          tabIndex={-1}
          aria-label={label}
          aria-activedescendant={`${id}-${active}`}
          className={`select__list${pos.up ? " select__list--up" : ""}`}
          style={{
            left: pos.left,
            width: pos.width,
            maxHeight: pos.maxHeight,
            ...(pos.up ? { bottom: window.innerHeight - pos.top } : { top: pos.top }),
          }}
          onKeyDown={onListKey}
        >
          {options.map((o, i) => (
            <li
              key={o.value}
              id={`${id}-${i}`}
              role="option"
              aria-selected={i === selected}
              className={`select__option${i === active ? " select__option--active" : ""}`}
              onPointerMove={() => setActive(i)}
              onClick={() => choose(i)}
            >
              <span className="select__option-body">{render(o, true)}</span>
              <span className="select__check" aria-hidden>
                {i === selected && <IconCheck size={14} />}
              </span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
