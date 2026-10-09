import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Word } from "../engine";
import { buildCues, READING_RULES, type Cue } from "../lib/cues";
import { clock } from "../lib/format";
import { IconEdit, IconTrash } from "./icons";

interface Props {
  words: Word[];
  tentative: Word[];
  running: boolean;
  /** Running, but the model is still loading. */
  waiting?: boolean;
  time: number;
  playing: boolean;
  onSeek: (t: number) => void;
  /** Present when the transcript can be edited (decoding finished). */
  onEdit?: (first: number, count: number, text: string) => void;
}

/** Index of the word being spoken at time t, or -1. */
function activeIndex(words: Word[], t: number): number {
  let lo = 0;
  let hi = words.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (words[mid].start <= t) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans >= 0 && t < words[ans].end + 0.25 ? ans : -1;
}

function CueEditor({ initial, onDone }: { initial: string; onDone: (text: string | null) => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [value, setValue] = useState(initial);
  useLayoutEffect(() => {
    const t = ref.current!;
    t.style.height = "0";
    t.style.height = `${t.scrollHeight}px`;
  }, [value]);
  useEffect(() => {
    const t = ref.current!;
    t.focus();
    t.setSelectionRange(t.value.length, t.value.length);
  }, []);
  return (
    <textarea
      ref={ref}
      className="cue__editor"
      value={value}
      spellCheck
      lang="tr"
      aria-label="Satırı düzenle"
      onChange={(e) => setValue(e.target.value.replace(/\n/g, " "))}
      onBlur={() => onDone(value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          onDone(value);
        } else if (e.key === "Escape") {
          e.preventDefault();
          onDone(null);
        }
      }}
    />
  );
}

const CueRow = memo(function CueRow({
  cue,
  active,
  tentativeFrom,
  onSeek,
  onEdit,
}: {
  cue: Cue;
  /** Index of the active word within this cue, or -1. */
  active: number;
  /** Words from this index on are still being decoded. */
  tentativeFrom: number;
  onSeek: (t: number) => void;
  onEdit?: (first: number, count: number, text: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const text = cue.words.map((w) => w.text).join(" ");
  const finish = (value: string | null) => {
    setEditing(false);
    if (value !== null && value.trim() !== text) onEdit?.(cue.first, cue.words.length, value);
  };
  return (
    <li className={`cue${active >= 0 ? " cue--active" : ""}${editing ? " cue--editing" : ""}`} data-start={cue.start}>
      <button className="tc" onClick={() => onSeek(cue.start)} aria-label={`${clock(cue.start)} konumuna git`}>
        {clock(cue.start)}
      </button>
      {editing ? (
        <CueEditor initial={text} onDone={finish} />
      ) : (
        <p className="cue__text" onDoubleClick={() => onEdit && setEditing(true)}>
          {cue.words.map((w, i) => (
            <span key={i}>
              <span
                className={`w${i === active ? " w--now" : ""}${i >= tentativeFrom ? " w--live" : ""}`}
                onClick={() => onSeek(w.start)}
              >
                {w.text}
              </span>{" "}
            </span>
          ))}
        </p>
      )}
      {onEdit && !editing && (
        <span className="cue__tools">
          <button className="cue__tool" onClick={() => setEditing(true)} title="Düzenle (çift tıkla)" aria-label="Satırı düzenle">
            <IconEdit />
          </button>
          <button className="cue__tool" onClick={() => onEdit(cue.first, cue.words.length, "")} title="Satırı sil" aria-label="Satırı sil">
            <IconTrash />
          </button>
        </span>
      )}
    </li>
  );
},
// Cues are rebuilt on every progress update; only re-render rows that changed.
(a, b) =>
  a.active === b.active &&
  a.tentativeFrom === b.tentativeFrom &&
  a.onSeek === b.onSeek &&
  a.onEdit === b.onEdit &&
  a.cue.first === b.cue.first &&
  a.cue.words.length === b.cue.words.length &&
  a.cue.words.every((w, i) => w === b.cue.words[i]));

export function Transcript({ words, tentative, running, waiting, time, playing, onSeek, onEdit }: Props) {
  const all = useMemo(() => (tentative.length ? words.concat(tentative) : words), [words, tentative]);
  const cues = useMemo(() => buildCues(all, READING_RULES), [all]);
  const active = playing || time > 0 ? activeIndex(all, time) : -1;
  const list = useRef<HTMLOListElement>(null);
  const userScrolledAt = useRef(0);

  // Follow the playhead, unless the reader scrolled on their own recently.
  const activeCue = active < 0 ? -1 : cues.findIndex((c) => active < c.first + c.words.length);
  useEffect(() => {
    if (activeCue < 0 || !playing || Date.now() - userScrolledAt.current < 4000) return;
    list.current?.children[activeCue]?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [activeCue, playing]);

  // While decoding, keep the newest line in view if the reader is at the end.
  // The list scrolls inside its panel (the nearest scrollable ancestor).
  const nearEnd = useRef(true);
  useEffect(() => {
    const el = list.current?.closest(".scroll");
    if (!el) return;
    const onScroll = () => {
      nearEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    };
    const onUser = () => (userScrolledAt.current = Date.now());
    el.addEventListener("scroll", onScroll, { passive: true });
    el.addEventListener("wheel", onUser, { passive: true });
    el.addEventListener("touchmove", onUser, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("wheel", onUser);
      el.removeEventListener("touchmove", onUser);
    };
  }, [all.length > 0]);
  useEffect(() => {
    if (running && !playing && nearEnd.current) {
      list.current?.lastElementChild?.scrollIntoView({ block: "end" });
    }
  }, [cues.length, running, playing]);

  if (!all.length) {
    return (
      <p className="empty-note" aria-live="polite">
        {waiting
          ? "Model hazırlanıyor, bitince yazıya dökme başlayacak."
          : running
            ? "Konuşma bekleniyor…"
            : "Bu dosyada konuşma bulunamadı."}
      </p>
    );
  }

  return (
    <ol className="cues" ref={list}>
      {cues.map((c) => {
        const end = c.first + c.words.length;
        return (
          <CueRow
            key={c.first}
            cue={c}
            active={active >= c.first && active < end ? active - c.first : -1}
            tentativeFrom={Math.min(c.words.length, Math.max(0, words.length - c.first))}
            onSeek={onSeek}
            onEdit={onEdit}
          />
        );
      })}
    </ol>
  );
}
