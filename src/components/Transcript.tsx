import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Word } from "../engine";
import { buildCues, importedCues, READING_RULES, type Cue } from "../lib/cues";
import { DEFAULT_JUMP_CUT, isFiller, isGapCut, isWordCut, wordGap, type JumpCut } from "../lib/cuts";
import type { Match } from "../lib/find";
import { clock, duration as fmtDuration } from "../lib/format";
import { speakerColor } from "../lib/speakers";
import { IconBleep, IconCheck, IconClock, IconEdit, IconScissors, IconSpeaker, IconTrash, IconUndo } from "./icons";
import { Menu, MenuGroup, MenuItem, MenuTitle } from "./Menu";
import { TimingEditor } from "./TimingEditor";
import { EmptyNote, IconButton } from "./ui";

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
  /** Present with onEdit: words first..first+count-1 placed in start..end, or moved by seconds. */
  onRetime?: (first: number, count: number, start: number, end: number) => void;
  onShift?: (first: number, count: number, seconds: number) => void;
  /** Find hits to mark, and which one is current. */
  found?: { matches: Match[]; current: number };
  /** Language of the words, for the spelling check while editing. */
  lang: string;
  /** The speakers' names, when they were told apart (the words then carry `speaker`). */
  speakerNames?: string[];
  /** Present with speakerNames when they can be changed: start..end is said by `speaker` (a new number adds one). */
  onSpeaker?: (start: number, end: number, speaker: number) => void;
  /** Jump-cut rules and callbacks for transcript-based video editing. */
  jumpCut?: JumpCut;
  spanStart?: number;
  onToggleWords?: (indices: number[], force?: boolean) => void;
  onToggleGap?: (index: number, force?: boolean) => void;
  onToggleAllFillers?: () => void;
  onToggleAllGaps?: () => void;
  /** Bleeps (censors) the words at `indices`, or takes the bleep off (toggles when `force` is omitted). */
  onToggleBleep?: (indices: number[], force?: boolean) => void;
  /** Takes the bleep off every word. */
  onClearBleeps?: () => void;
  cutSummary?: { count: number; before: number; after: number } | null;
}

const fmtGap = (s: number) => `${(s >= 10 ? Math.round(s).toString() : s.toFixed(1)).replace(".", ",")} sn`;

/** Who says a line: one speaker per line, since lines break where the speaker changes. */
const speakerOf = (c: Cue) => c.words[0]?.speaker;

/** Pick who says a line or a turn: the speakers, and a new one. */
function SpeakerMenu({
  names,
  current,
  title,
  align,
  onPick,
  trigger,
}: {
  names: string[];
  current: number;
  title: string;
  align: "left" | "right";
  onPick: (speaker: number) => void;
  trigger: (toggle: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Menu open={open} onOpenChange={setOpen} align={align} width="w-[220px]" trigger={trigger(() => setOpen((o) => !o))}>
      <MenuGroup>
        <MenuTitle>{title}</MenuTitle>
        {names.map((n, i) => (
          <MenuItem
            key={i}
            onClick={() => {
              setOpen(false);
              if (i !== current) onPick(i);
            }}
          >
            <span className="flex min-w-0 items-center gap-2">
              <span className="size-2 shrink-0 rounded-full" style={{ background: speakerColor(i) }} />
              <span className="truncate">{n}</span>
            </span>
            {i === current && <IconCheck size={14} />}
          </MenuItem>
        ))}
      </MenuGroup>
      <MenuGroup>
        <MenuItem
          onClick={() => {
            setOpen(false);
            onPick(names.length);
          }}
        >
          Yeni konuşmacı
        </MenuItem>
      </MenuGroup>
    </Menu>
  );
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
      className="-my-[3px] block w-full resize-none overflow-hidden rounded-ui-sm border border-cini bg-bg px-1.5 py-0.5 text-[15px] leading-[1.6] font-[560] text-fg outline-none [font-family:inherit]"
      value={value}
      spellCheck
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
  marks,
  onSeek,
  onEdit,
  onRetime,
  onShift,
  now,
  speakerNames,
  turnEnd,
  onSpeaker,
  jc,
  firstGap,
  cutMode,
  selectedFrom,
  selectedTo,
  onWordClick,
  onToggleWords,
  onToggleGap,
  onPaintStart,
  onPaintMove,
}: {
  cue: Cue;
  /** Index of the active word within this cue, or -1. */
  active: number;
  /** Words from this index on are still being decoded. */
  tentativeFrom: number;
  /** Per word: "1" inside a find hit, "2" inside the current one, else "0". Empty if none. */
  marks: string;
  onSeek: (t: number) => void;
  onEdit?: (first: number, count: number, text: string) => void;
  onRetime?: (first: number, count: number, start: number, end: number) => void;
  onShift?: (first: number, count: number, seconds: number) => void;
  now: () => number;
  speakerNames?: string[];
  /** Set on the first line of a speaker's turn: where the turn ends. Its name shows above the line. */
  turnEnd?: number;
  onSpeaker?: (start: number, end: number, speaker: number) => void;
  jc: JumpCut;
  /** Silence duration before the first word of this cue, seconds. */
  firstGap: number;
  cutMode: boolean;
  selectedFrom: number;
  selectedTo: number;
  onWordClick: (idx: number, start: number) => void;
  onToggleWords?: (indices: number[], force?: boolean) => void;
  onToggleGap?: (index: number, force?: boolean) => void;
  onPaintStart?: (idx: number, targetCut: boolean) => void;
  onPaintMove?: (idx: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [timing, setTiming] = useState(false);
  const text = cue.words.map((w) => w.text).join(" ");
  const speaker = speakerNames ? speakerOf(cue) : undefined;
  const allCueCut = cue.words.length > 0 && cue.words.every((w) => isWordCut(w, jc));
  const finish = (value: string | null) => {
    setEditing(false);
    if (value !== null && value.trim() !== text) onEdit?.(cue.first, cue.words.length, value);
  };
  return (
    <li
      className={`group/cue relative grid scroll-m-10 grid-cols-[52px_minmax(0,1fr)] items-baseline border-l-2 py-1.5 pr-3.5 pl-0 transition-[background,border-color] duration-150 ease-[ease] ${
        active >= 0 ? "border-cini bg-linear-to-r from-cini-wash to-transparent to-75%" : "border-transparent"
      }`}
      data-start={cue.start}
    >
      {speaker !== undefined && turnEnd !== undefined && (
        <div className="col-span-2 pt-1 pb-0.5 pl-3">
          {onSpeaker ? (
            <SpeakerMenu
              names={speakerNames!}
              current={speaker}
              title="Bu konuşmayı söyleyen"
              align="left"
              onPick={(s) => onSpeaker(cue.start, turnEnd, s)}
              trigger={(toggle) => (
                <button
                  className="-mx-1.5 flex items-center gap-1.5 rounded-ui-sm border-0 bg-transparent px-1.5 py-0.5 text-[11.5px] font-semibold hover:bg-raised"
                  style={{ color: speakerColor(speaker) }}
                  onClick={toggle}
                  title="Konuşmacıyı değiştir"
                >
                  <span className="size-2 rounded-full" style={{ background: speakerColor(speaker) }} />
                  {speakerNames![speaker]}
                </button>
              )}
            />
          ) : (
            <span className="flex items-center gap-1.5 text-[11.5px] font-semibold" style={{ color: speakerColor(speaker) }}>
              <span className="size-2 rounded-full" style={{ background: speakerColor(speaker) }} />
              {speakerNames![speaker]}
            </span>
          )}
        </div>
      )}
      <button
        className={`justify-self-start border-0 bg-transparent py-0 pr-0 pl-3 text-[11px] font-medium tabular-nums transition-colors duration-150 ease-[ease] [font-feature-settings:'tnum'_1] hover:text-wave-played ${
          active >= 0 ? "text-wave-played" : allCueCut ? "text-fg-3/45 line-through" : "text-fg-3"
        }`}
        onClick={() => onSeek(cue.start)}
        aria-label={`${clock(cue.start)} konumuna git`}
      >
        {clock(cue.start)}
      </button>
      {editing ? (
        <CueEditor initial={text} onDone={finish} />
      ) : (
        <p
          className={`m-0 font-[family-name:var(--read)] text-[14.5px] leading-[1.65] font-[480] tracking-[-0.008em] ${
            cutMode ? "select-none" : ""
          }`}
          onDoubleClick={() => !cutMode && onEdit && setEditing(true)}
        >
          {cue.words.map((w, i) => {
            const idx = cue.first + i;
            const decoded = i < tentativeFrom;
            const gap = i === 0 ? firstGap : Math.max(0, w.start - cue.words[i - 1].end);
            const showGap = !!onToggleGap && decoded && (gap >= jc.gap - 1e-6 || w.cutGap !== undefined) && gap >= 0.25;
            const gapCut = showGap && isGapCut(w, jc);
            const wordCut = decoded && isWordCut(w, jc);
            const filler = decoded && !wordCut && isFiller(w.text);
            const inSel = !wordCut && selectedFrom >= 0 && idx >= selectedFrom && idx <= selectedTo;

            return (
              <span key={i}>
                {showGap && (
                  <>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onToggleGap(idx);
                      }}
                      title={
                        gapCut
                          ? `${fmtGap(gap)} sessizlik kısaltıldı · geri getirmek için tıkla`
                          : `${fmtGap(gap)} sessizlik · tek tıkla kısalt`
                      }
                      aria-label={`${fmtGap(gap)} sessizlik, ${gapCut ? "kısaltıldı, geri getir" : "kısalt"}`}
                      className={`mx-0.5 inline-flex translate-y-[-0.5px] cursor-pointer items-center gap-1 rounded-full border px-1.5 py-0 text-[10.5px] leading-[1.45] font-medium tabular-nums select-none align-baseline transition-all duration-150 [font-feature-settings:'tnum'_1] ${
                        gapCut
                          ? "border-line-soft bg-transparent text-fg-3/45 line-through decoration-fg-3/65 hover:border-line hover:text-fg-2"
                          : "border-line bg-well text-fg-2 hover:border-firuze/60 hover:bg-raised hover:text-fg"
                      }`}
                    >
                      <span className="text-[9px] leading-none not-italic no-underline" aria-hidden>
                        ⏸
                      </span>
                      <span>{fmtGap(gap)}</span>
                    </button>{" "}
                  </>
                )}
                <span
                  data-word-index={idx}
                  onPointerDown={
                    cutMode && onToggleWords && decoded
                      ? (e) => {
                          if (e.button !== 0) return;
                          e.preventDefault();
                          onPaintStart?.(idx, !wordCut);
                        }
                      : undefined
                  }
                  onPointerEnter={
                    cutMode && onToggleWords && decoded
                      ? (e) => {
                          if (e.buttons === 1) onPaintMove?.(idx);
                        }
                      : undefined
                  }
                  onClick={(e) => {
                    if (cutMode && onToggleWords && decoded) {
                      e.preventDefault();
                      return;
                    }
                    if (onToggleWords && decoded && e.altKey) {
                      e.preventDefault();
                      onToggleWords([idx]);
                      return;
                    }
                    if (onToggleWords && decoded && wordCut && !e.shiftKey) {
                      e.preventDefault();
                      onToggleWords([idx], false);
                      return;
                    }
                    onWordClick(idx, w.start);
                  }}
                  title={
                    w.bleep && !wordCut
                      ? "Bip'lendi · kaldırmak için seç ve B'ye bas"
                      : wordCut
                      ? "Kesildi · geri getirmek için tıkla (o ana gitmek için Shift+tıkla)"
                      : cutMode
                        ? "Videodan kesmek için tıkla veya sürükle"
                        : filler
                          ? "Dolgu sesi · kesmek için Delete veya Alt+tıkla"
                          : undefined
                  }
                  className={`-mx-px inline-block cursor-pointer rounded-[4px] px-[3px] py-px transition-[background,color,opacity] duration-150 ease-[ease] hover:bg-raised motion-reduce:transition-none ${
                    i === active && !wordCut
                      ? "bg-cini font-[550] text-white shadow-[0_1px_4px_rgba(71,109,230,0.4)]"
                      : w.bleep && !wordCut
                        ? "bg-orange-500/15 text-orange-300 light:text-orange-700 underline decoration-orange-400/80 decoration-wavy underline-offset-[3.5px]"
                        : wordCut
                        ? "text-fg-3/45 line-through decoration-fg-3/75 hover:text-fg-2"
                        : marks[i] === "2"
                          ? "bg-[#e8b54a] text-[#1a1408]"
                          : marks[i] === "1"
                            ? "bg-[rgba(232,181,74,0.22)]"
                            : !decoded
                              ? "text-firuze"
                              : inSel
                                ? "bg-cini-wash ring-1 ring-cini/50"
                                : filler
                                  ? "bg-amber-500/10 text-fg-2 underline decoration-amber-400/75 decoration-dotted underline-offset-[3.5px]"
                                  : ""
                  }`}
                >
                  {w.text}
                </span>{" "}
              </span>
            );
          })}
        </p>
      )}
      {onEdit && !editing && (
        <span className="absolute top-[3px] right-1.5 hidden gap-0.5 rounded-ui bg-raised p-0.5 group-hover/cue:flex focus-within:flex">
          <IconButton onClick={() => setEditing(true)} title="Metni düzenle (çift tıkla)" aria-label="Satırı düzenle">
            <IconEdit />
          </IconButton>
          {speaker !== undefined && onSpeaker && (
            <SpeakerMenu
              names={speakerNames!}
              current={speaker}
              title="Bu satırı söyleyen"
              align="right"
              onPick={(s) => onSpeaker(cue.start, cue.end, s)}
              trigger={(toggle) => (
                <IconButton onClick={toggle} title="Bu satırın konuşmacısı" aria-label="Bu satırın konuşmacısını değiştir">
                  <IconSpeaker />
                </IconButton>
              )}
            />
          )}
          {onRetime && onShift && (
            <IconButton onClick={() => setTiming((t) => !t)} title="Zamanı düzenle" aria-label="Satırın zamanını düzenle">
              <IconClock />
            </IconButton>
          )}
          {onToggleWords ? (
            <IconButton
              onClick={() =>
                onToggleWords(
                  Array.from({ length: cue.words.length }, (_, k) => cue.first + k),
                  !allCueCut,
                )
              }
              title={allCueCut ? "Satırı geri getir" : "Satırı videodan kes"}
              aria-label={allCueCut ? "Satırı geri getir" : "Satırı videodan kes"}
            >
              {allCueCut ? <IconUndo /> : <IconScissors />}
            </IconButton>
          ) : (
            <IconButton onClick={() => onEdit(cue.first, cue.words.length, "")} title="Satırı sil" aria-label="Satırı sil">
              <IconTrash />
            </IconButton>
          )}
        </span>
      )}
      {timing && onRetime && onShift && (
        <TimingEditor cue={cue} now={now} onRetime={onRetime} onShift={onShift} onClose={() => setTiming(false)} />
      )}
    </li>
  );
},
// Cues are rebuilt on every progress update; only re-render rows that changed.
(a, b) =>
  a.active === b.active &&
  a.tentativeFrom === b.tentativeFrom &&
  a.marks === b.marks &&
  a.onSeek === b.onSeek &&
  a.onEdit === b.onEdit &&
  a.onRetime === b.onRetime &&
  a.onShift === b.onShift &&
  a.speakerNames === b.speakerNames &&
  a.turnEnd === b.turnEnd &&
  a.onSpeaker === b.onSpeaker &&
  a.jc.on === b.jc.on &&
  a.jc.gap === b.jc.gap &&
  a.jc.fillers === b.jc.fillers &&
  a.firstGap === b.firstGap &&
  a.cutMode === b.cutMode &&
  a.selectedFrom === b.selectedFrom &&
  a.selectedTo === b.selectedTo &&
  a.onWordClick === b.onWordClick &&
  a.onToggleWords === b.onToggleWords &&
  a.onToggleGap === b.onToggleGap &&
  a.cue.first === b.cue.first &&
  a.cue.words.length === b.cue.words.length &&
  a.cue.words.every((w, i) => w === b.cue.words[i]));

const CHIP_BTN =
  "inline-flex h-6 cursor-pointer items-center gap-1 rounded-md border px-2 text-[11.5px] font-medium tabular-nums select-none transition-colors duration-150 [font-feature-settings:'tnum'_1]";

export function Transcript({
  words,
  tentative,
  running,
  waiting,
  time,
  playing,
  onSeek,
  onEdit,
  onRetime,
  onShift,
  found,
  lang,
  speakerNames,
  onSpeaker,
  jumpCut = DEFAULT_JUMP_CUT,
  spanStart = 0,
  onToggleWords,
  onToggleGap,
  onToggleAllFillers,
  onToggleAllGaps,
  onToggleBleep,
  onClearBleeps,
  cutSummary,
}: Props) {
  // The playhead for "Şu an" buttons, without re-rendering rows as it moves.
  const timeRef = useRef(time);
  timeRef.current = time;
  const now = useCallback(() => timeRef.current, []);
  const all = useMemo(() => (tentative.length ? words.concat(tentative) : words), [words, tentative]);
  const cues = useMemo(() => importedCues(all) ?? buildCues(all, READING_RULES), [all]);

  // Mode where single-clicking or dragging across words directly cuts/restores them.
  const [cutMode, setCutMode] = useState(false);
  // Selected word range [from, to] in `words` (set by clicking a word or selecting text).
  const [selection, setSelection] = useState<[number, number] | null>(null);
  const paintTargetRef = useRef<boolean | null>(null);

  useEffect(() => {
    if (!onToggleWords) {
      setCutMode(false);
      setSelection(null);
    }
  }, [onToggleWords]);

  const onPaintStart = useCallback(
    (idx: number, targetCut: boolean) => {
      paintTargetRef.current = targetCut;
      setSelection(null);
      onToggleWords?.([idx], targetCut);
    },
    [onToggleWords],
  );

  const onPaintMove = useCallback(
    (idx: number) => {
      if (paintTargetRef.current === null) return;
      onToggleWords?.([idx], paintTargetRef.current);
    },
    [onToggleWords],
  );

  useEffect(() => {
    const up = () => {
      paintTargetRef.current = null;
    };
    window.addEventListener("pointerup", up);
    return () => window.removeEventListener("pointerup", up);
  }, []);

  const onWordClick = useCallback(
    (idx: number, start: number) => {
      // Ignore single-word click if user just finished selecting a multi-word range.
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed && sel.toString().trim().includes(" ")) return;
      setSelection([idx, idx]);
      onSeek(start);
    },
    [onSeek],
  );

  // Track native text selection across words inside the transcript list.
  const list = useRef<HTMLOListElement>(null);
  useEffect(() => {
    if (!onToggleWords && !onToggleBleep) return;
    const onSelect = () => {
      const sel = window.getSelection();
      const root = list.current;
      if (!sel || sel.isCollapsed || !root || !sel.rangeCount) return;
      const range = sel.getRangeAt(0);
      if (!root.contains(range.commonAncestorContainer)) return;
      const findIdx = (node: Node | null): number => {
        const el = (node instanceof HTMLElement ? node : node?.parentElement)?.closest<HTMLElement>("[data-word-index]");
        return el ? Number(el.dataset.wordIndex) : -1;
      };
      const a = findIdx(range.startContainer);
      const b = findIdx(range.endContainer);
      if (a >= 0 && b >= 0) {
        setSelection([Math.min(a, b), Math.max(a, b)]);
      }
    };
    document.addEventListener("selectionchange", onSelect);
    return () => document.removeEventListener("selectionchange", onSelect);
  }, [onToggleWords, onToggleBleep]);

  // B bleeps (or un-bleeps) the selected word or range of words.
  useEffect(() => {
    if (!onToggleBleep || !selection) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "b" || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      e.preventDefault();
      const [a, b] = selection;
      const indices: number[] = [];
      for (let i = a; i <= b; i++) if (i >= 0 && i < words.length) indices.push(i);
      if (indices.length) {
        onToggleBleep(indices);
        window.getSelection()?.removeAllRanges();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onToggleBleep, selection, words.length]);

  // Delete / Backspace cuts (or restores) the selected word or range of words.
  useEffect(() => {
    if (!onToggleWords || !selection) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      e.preventDefault();
      const [a, b] = selection;
      const indices: number[] = [];
      for (let i = a; i <= b; i++) if (i >= 0 && i < words.length) indices.push(i);
      if (indices.length) {
        onToggleWords(indices);
        window.getSelection()?.removeAllRanges();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onToggleWords, selection, words.length]);

  // Stats for fillers and long silences across the decoded transcript.
  const stats = useMemo(() => {
    let fillersTotal = 0;
    let fillersCut = 0;
    let gapsTotal = 0;
    let gapsCut = 0;
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      if (isFiller(w.text)) {
        fillersTotal++;
        if (isWordCut(w, jumpCut)) fillersCut++;
      }
      if (wordGap(words, i, spanStart) >= jumpCut.gap - 1e-6) {
        gapsTotal++;
        if (isGapCut(w, jumpCut)) gapsCut++;
      }
    }
    return { fillersTotal, fillersCut, gapsTotal, gapsCut };
  }, [words, jumpCut, spanStart]);
  const bleepCount = useMemo(() => words.reduce((n, w) => n + (w.bleep ? 1 : 0), 0), [words]);

  // Per cue, a string of find marks (see CueRow); "" where nothing is marked.
  const marks = useMemo(() => {
    if (!found?.matches.length) return null;
    const m = new Uint8Array(all.length);
    found.matches.forEach((h, k) => m.fill(k === found.current ? 2 : 1, h.first, h.last + 1));
    return cues.map((c) => {
      const part = m.subarray(c.first, c.first + c.words.length);
      return part.some(Boolean) ? part.join("") : "";
    });
  }, [all, cues, found]);
  // Per cue that starts a speaker's turn, where the turn ends.
  const turnEnds = useMemo(() => {
    if (!speakerNames) return null;
    const out = new Map<number, number>();
    let start = -1;
    cues.forEach((c, i) => {
      if (i === 0 || speakerOf(c) !== speakerOf(cues[i - 1])) start = i;
      out.set(start, c.end);
    });
    return out;
  }, [cues, speakerNames]);
  const active = playing || time > 0 ? activeIndex(all, time) : -1;
  const userScrolledAt = useRef(0);

  // Follow the playhead, unless the reader scrolled on their own recently.
  const activeCue = active < 0 ? -1 : cues.findIndex((c) => active < c.first + c.words.length);
  useEffect(() => {
    if (activeCue < 0 || !playing || Date.now() - userScrolledAt.current < 4000) return;
    list.current?.children[activeCue]?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [activeCue, playing]);

  // Bring the current find hit into view.
  const hit = found?.matches[found.current]?.first ?? -1;
  const hitCue = hit < 0 ? -1 : cues.findIndex((c) => hit < c.first + c.words.length);
  useEffect(() => {
    if (hitCue >= 0) list.current?.children[hitCue]?.scrollIntoView({ block: "nearest" });
  }, [hitCue, hit]);

  // While decoding, keep the newest line in view if the reader is at the end.
  // The list scrolls inside its panel (the nearest scrollable ancestor).
  const nearEnd = useRef(true);
  useEffect(() => {
    const el = list.current?.closest("[data-scroll]");
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
      <EmptyNote aria-live="polite">
        {waiting
          ? "Model hazırlanıyor, bitince yazıya dökme başlayacak."
          : running
            ? "Konuşma bekleniyor…"
            : "Bu dosyada konuşma bulunamadı."}
      </EmptyNote>
    );
  }

  const selCount = selection ? selection[1] - selection[0] + 1 : 0;
  const selAllCut =
    selection !== null &&
    selCount > 0 &&
    Array.from({ length: selCount }, (_, k) => selection[0] + k).every((idx) => words[idx] && isWordCut(words[idx], jumpCut));
  const selAllBleep =
    selection !== null &&
    selCount > 0 &&
    Array.from({ length: selCount }, (_, k) => selection[0] + k).every((idx) => words[idx]?.bleep);
  const savedSec = cutSummary ? Math.max(0, cutSummary.before - cutSummary.after) : 0;

  return (
    <div>
      {(onToggleWords || onToggleBleep) && !running && words.length > 0 && (
        <div
          className="sticky top-0 z-10 flex flex-wrap items-center gap-1.5 border-b border-line-soft bg-pane/95 px-3 py-1.5 backdrop-blur-md"
          role="toolbar"
          aria-label="Metinden kurgu araçları"
        >
          {onToggleWords && (
          <button
            type="button"
            aria-pressed={cutMode}
            onClick={() => setCutMode((v) => !v)}
            title={
              cutMode
                ? "Kurgu modu açık: kelimelere tıklayarak veya sürükleyerek videodan kes"
                : "Kurgu modu: açıldığında kelimelere tek tıklayarak videodan kesersin (normal modda Delete veya Alt+tıkla)"
            }
            className={`${CHIP_BTN} ${
              cutMode
                ? "border-cini bg-cini text-white shadow-[0_1px_3px_rgba(71,109,230,0.35)]"
                : "border-line bg-well text-fg-2 hover:border-line-strong hover:bg-raised hover:text-fg"
            }`}
          >
            <IconScissors size={12} />
            <span>Kurgu</span>
          </button>
          )}

          {selection && !cutMode && onToggleWords && (
            <button
              type="button"
              onClick={() => {
                const indices = Array.from({ length: selCount }, (_, k) => selection[0] + k);
                onToggleWords(indices);
                window.getSelection()?.removeAllRanges();
              }}
              title="Seçili kelimeleri videodan kes veya geri getir (Delete / Backspace)"
              className={`${CHIP_BTN} border-cini/45 bg-cini-wash text-fg hover:bg-cini hover:text-white`}
            >
              {selAllCut ? <IconUndo size={12} /> : <IconScissors size={12} />}
              <span>
                {selAllCut
                  ? selCount > 1
                    ? `${selCount} kelimeyi geri al`
                    : "Kelimeyi geri al"
                  : selCount > 1
                    ? `${selCount} kelimeyi kes`
                    : "Kelimeyi kes"}
              </span>
            </button>
          )}

          {selection && !cutMode && onToggleBleep && (
            <button
              type="button"
              onClick={() => {
                const indices = Array.from({ length: selCount }, (_, k) => selection[0] + k);
                onToggleBleep(indices);
                window.getSelection()?.removeAllRanges();
              }}
              title="Seçili kelimeleri bip sesiyle değiştir veya bip'i kaldır (B)"
              className={`${CHIP_BTN} border-orange-400/45 bg-orange-500/12 text-orange-300 light:text-orange-700 hover:bg-orange-500/20`}
            >
              <IconBleep size={12} />
              <span>
                {selAllBleep
                  ? selCount > 1
                    ? `${selCount} kelimenin bip'ini kaldır`
                    : "Bip'i kaldır"
                  : selCount > 1
                    ? `${selCount} kelimeyi bip'le`
                    : "Kelimeyi bip'le"}
              </span>
            </button>
          )}

          {bleepCount > 0 && onClearBleeps && (
            <button
              type="button"
              onClick={onClearBleeps}
              title="Tüm bip'leri kaldır"
              className={`${CHIP_BTN} border-line bg-well text-fg-2 hover:border-line-strong hover:bg-raised hover:text-fg`}
            >
              <IconBleep size={12} />
              <span>{bleepCount} bip · temizle</span>
            </button>
          )}

          {stats.gapsTotal > 0 && onToggleAllGaps && (
            <button
              type="button"
              aria-pressed={stats.gapsCut === stats.gapsTotal}
              onClick={onToggleAllGaps}
              title={
                stats.gapsCut === stats.gapsTotal
                  ? "Kısaltılan tüm uzun sessizlikleri geri getir"
                  : `Metindeki ${stats.gapsTotal} uzun sessizliği (≥ ${fmtGap(jumpCut.gap)}) tek tıkla kısalt`
              }
              className={`${CHIP_BTN} ${
                stats.gapsCut === stats.gapsTotal
                  ? "border-firuze/45 bg-firuze/12 text-firuze hover:bg-firuze/18"
                  : "border-line bg-well text-fg-2 hover:border-line-strong hover:bg-raised hover:text-fg"
              }`}
            >
              <span className="text-[10px] leading-none" aria-hidden>
                ⏸
              </span>
              <span>
                {stats.gapsCut === stats.gapsTotal
                  ? `${stats.gapsTotal} boşluk kısaltıldı`
                  : `${stats.gapsTotal - stats.gapsCut} boşluk kısalt`}
              </span>
            </button>
          )}

          {stats.fillersTotal > 0 && onToggleAllFillers && (
            <button
              type="button"
              aria-pressed={stats.fillersCut === stats.fillersTotal}
              onClick={onToggleAllFillers}
              title={
                stats.fillersCut === stats.fillersTotal
                  ? "Silinen tüm dolgu seslerini (ııı, eee) geri getir"
                  : `Metindeki ${stats.fillersTotal} dolgu sesini (ııı, eee, hmm) tek tıkla videodan kes`
              }
              className={`${CHIP_BTN} ${
                stats.fillersCut === stats.fillersTotal
                  ? "border-amber-400/45 bg-amber-500/12 text-amber-300 light:text-amber-700 hover:bg-amber-500/18"
                  : "border-line bg-well text-fg-2 hover:border-line-strong hover:bg-raised hover:text-fg"
              }`}
            >
              <span className="text-[10.5px] opacity-80" aria-hidden>
                “ııı”
              </span>
              <span>
                {stats.fillersCut === stats.fillersTotal
                  ? `${stats.fillersTotal} dolgu silindi`
                  : `${stats.fillersTotal - stats.fillersCut} dolgu sil`}
              </span>
            </button>
          )}

          {savedSec >= 0.05 && (
            <span
              className="ml-auto text-[11px] font-medium text-firuze tabular-nums [font-feature-settings:'tnum'_1]"
              title={`${cutSummary!.count} kesim ile video ${fmtDuration(savedSec)} kısaldı (${clock(cutSummary!.before)} → ${clock(cutSummary!.after)})`}
            >
              −{savedSec < 60 ? fmtGap(savedSec) : fmtDuration(savedSec)}
            </span>
          )}
        </div>
      )}

      <ol className="m-0 list-none p-0 pb-6" ref={list} lang={lang}>
        {cues.map((c, i) => {
          const end = c.first + c.words.length;
          const selFrom = selection && selection[1] >= c.first && selection[0] < end ? selection[0] : -1;
          const selTo = selection && selection[1] >= c.first && selection[0] < end ? selection[1] : -1;
          return (
            <CueRow
              key={c.first}
              cue={c}
              active={active >= c.first && active < end ? active - c.first : -1}
              tentativeFrom={Math.min(c.words.length, Math.max(0, words.length - c.first))}
              marks={marks?.[i] ?? ""}
              onSeek={onSeek}
              onEdit={onEdit}
              onRetime={onRetime}
              onShift={onShift}
              now={now}
              speakerNames={speakerNames}
              turnEnd={turnEnds?.get(i)}
              onSpeaker={onSpeaker}
              jc={jumpCut}
              firstGap={wordGap(all, c.first, spanStart)}
              cutMode={cutMode}
              selectedFrom={selFrom}
              selectedTo={selTo}
              onWordClick={onWordClick}
              onToggleWords={onToggleWords}
              onToggleGap={onToggleGap}
              onPaintStart={onPaintStart}
              onPaintMove={onPaintMove}
            />
          );
        })}
      </ol>
    </div>
  );
}
