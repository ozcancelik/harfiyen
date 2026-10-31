import { useCallback, useEffect, useRef, useState } from "react";
import { buildCues, cueText, importedCues, READING_RULES } from "./cues";
import type { Word } from "../engine";
import { dubWav, type DubClip } from "../tts/dub";
import type { StoredDub } from "./projectStore";
import { RATE } from "../tts/ema";
import { splitSentences } from "./translation";
import { isMtLang } from "../engine/languages";
import type { DubLang, DubLine, DubOverflow, FromTts, ToTts, Voice, VoiceModel } from "../worker/tts.worker";

export type { DubLang, DubOverflow, Voice, VoiceModel };
export const DEFAULT_VOICE: Voice = { lang: "tr", model: "ema", style: "M3", pitch: 0, seed: 0 };

/** Only Supertonic reads a language other than Turkish; a saved voice from before languages reads Turkish. */
export function fitVoice(v: Voice): Voice {
  const lang = isMtLang(v.lang) ? v.lang : "tr";
  return { ...v, lang, model: lang === "tr" ? v.model : "supertonic" };
}

export const sameVoice = (a: Voice, b: Voice) =>
  a.lang === b.lang &&
  a.model === b.model &&
  a.style === b.style &&
  a.pitch === b.pitch &&
  a.seed === b.seed;
/** Read when the transcript has no line yet. */
const SAMPLE: Record<DubLang, string> = {
  tr: "Merhaba, seslendirme bu sesle yapılacak.",
  en: "Hello, the dub will be read in this voice.",
  de: "Hallo, die Synchronisation wird mit dieser Stimme gesprochen.",
  fr: "Bonjour, le doublage sera lu avec cette voix.",
  es: "Hola, el doblaje se leerá con esta voz.",
  ru: "Здравствуйте, дубляж будет озвучен этим голосом.",
};

/**
 * Read a sentence at a time: a translation, and any language but Turkish. A translated sentence keeps its
 * source's start, but its words are not timed, so caption lines would cut it at made-up places; read whole, it
 * also sounds like one sentence. A Turkish transcript is read a caption line at a time.
 */
export const dubBySentence = (voiceLang: DubLang, transcriptLang: string) =>
  voiceLang !== transcriptLang || voiceLang !== "tr";

/** Turn plain user text into timed placeholder words (one cue per sentence or line). */
export function wordsFromText(text: string): Word[] {
  const sentences = text
    .split(/(?:\r?\n)+|(?<=[.!?…]["'”’»)\]]*)\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const out: Word[] = [];
  let t = 0;
  for (const s of sentences) {
    const parts = s.split(/\s+/).filter(Boolean);
    if (!parts.length) continue;
    if (out.length) t += 1.5;
    parts.forEach((w, i) => {
      const d = ([...w].length + 1) * 0.06;
      out.push({ text: w, start: t, end: t + d, ...(i === 0 && { cue: true }) });
      t += d;
    });
  }
  return out;
}

/** Plain text of `words`, one cue per line. */
export function textFromWords(words: Word[]): string {
  const cues = importedCues(words) ?? buildCues(words, READING_RULES);
  return cues.map(cueText).join("\n");
}

/** What the dub reads: `words` a sentence or a caption line at a time (dubBySentence). */
function dubLines(words: Word[], bySentence: boolean): SpokenLine[] {
  const imported = importedCues(words);
  if (imported)
    return imported.map((c) => ({
      start: c.start,
      end: c.end,
      text: cueText(c),
      first: c.first,
      count: c.words.length,
    }));
  if (bySentence)
    return splitSentences(words).map((s) => ({
      start: words[s.first].start,
      end: words[s.first + s.count - 1].end,
      text: s.text,
      first: s.first,
      count: s.count,
    }));
  return buildCues(words, READING_RULES).map((c) => ({
    start: c.start,
    end: c.end,
    text: cueText(c),
    first: c.first,
    count: c.words.length,
  }));
}

/** A line of the dub, and the `count` words from `first` it reads. */
interface SpokenLine extends DubLine {
  first: number;
  count: number;
}

/**
 * The words as the dub says them: each line's words moved and stretched, in proportion, onto the span its clip
 * takes. A translated line's words share its span by length, so they keep doing so. Words the dub has no clip
 * for keep their times.
 */
function timeToDub(words: Word[], lines: SpokenLine[], clips: DubClip[]): Word[] {
  const out = words.slice();
  for (const c of clips) {
    const l = lines[c.line];
    if (!l?.count) continue;
    const from = words[l.first].start;
    const span = words[l.first + l.count - 1].end - from;
    const scale = span > 0 ? c.audio.length / RATE / span : 0;
    for (let i = l.first; i < l.first + l.count; i++) {
      const w = words[i];
      out[i] = { ...w, start: c.start + (w.start - from) * scale, end: c.start + (w.end - from) * scale };
    }
  }
  return out;
}

/**
 * A fingerprint of the words a dub reads (FNV-1a over their text and start times): the dub is out of date once
 * it changes. Kept with the project, so a reopened dub knows too.
 */
export function dubKey(words: Word[]): string {
  let h = 0x811c9dc5;
  for (const w of words) {
    const s = `${w.text}@${Math.round(w.start * 1000)} `;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  }
  return `${words.length}:${(h >>> 0).toString(16)}`;
}

/** A finished dub as the project keeps it: the speech in 16 bits, half the room. */
export function storedDub(d: Extract<DubState, { status: "done" }>): StoredDub {
  return {
    voice: d.voice,
    key: d.key,
    end: d.end,
    duration: d.duration,
    overflow: d.overflow,
    elapsed: d.elapsed,
    clips: d.clips.map((c) => ({
      line: c.line,
      start: c.start,
      audio: Int16Array.from(c.audio, (v) => Math.round(Math.max(-1, Math.min(1, v)) * 32767)),
    })),
  };
}

/** A short sample of the voice: model download, then synthesis, then playback. */
export type PreviewState =
  | { status: "idle" }
  | { status: "download"; loaded: number; total: number }
  | { status: "running" }
  | { status: "playing" };

export type DubState =
  | { status: "idle" }
  | { status: "download"; loaded: number; total: number }
  | { status: "running"; done: number; total: number }
  /**
   * `key` (dubKey of the words read), `voice` and `end` are what it was made from, to tell when it is out of
   * date; `timed`, the words at the times the dub says them, for captions that follow it. `overflow`: the last
   * line heard still runs past `end`. `restored`: read back from the project, not made now.
   */
  | {
      status: "done";
      clips: DubClip[];
      url: string;
      key: string;
      duration: number;
      timed: Word[];
      restored?: boolean;
      voice: Voice;
      end: number;
      overflow: DubOverflow | null;
      elapsed: number;
    }
  | { status: "error"; message: string };

export interface DubResult {
  clips: DubClip[];
  wav: Blob;
  duration: number;
  timed: Word[];
  voice: Voice;
  elapsed: number;
}

/** Reads the transcript aloud with the chosen voice model in its own worker, one line at a time. */
export function useDubber() {
  const worker = useRef<Worker | null>(null);
  const jobId = useRef(0);
  const pending = useRef<{
    words: Word[];
    lines: SpokenLine[];
    duration: number;
    end: number;
    voice: Voice;
    onDone?: (r: DubResult) => void;
  } | null>(null);
  const [state, setState] = useState<DubState>({ status: "idle" });
  // Previews run alongside a finished dub without touching it, so they count their own jobs; the worker sees
  // them as negative ids.
  const previewId = useRef(0);
  const sample = useRef<HTMLAudioElement | null>(null);
  const [preview, setPreview] = useState<PreviewState>({ status: "idle" });

  const stopSample = useCallback(() => {
    const a = sample.current;
    if (!a) return;
    a.pause();
    URL.revokeObjectURL(a.src);
    sample.current = null;
  }, []);

  const ensureWorker = useCallback(() => {
    if (worker.current) return worker.current;
    const w = new Worker(new URL("../worker/tts.worker.ts", import.meta.url), { type: "module" });
    w.onmessage = (ev: MessageEvent<FromTts>) => {
      const m = ev.data;
      if (m.jobId < 0) {
        if (m.jobId !== -previewId.current) return;
        if (m.type === "download") setPreview({ status: "download", loaded: m.loaded, total: m.total });
        else if (m.type === "error") setPreview({ status: "idle" });
        else if (m.type === "preview") {
          const a = new Audio(URL.createObjectURL(dubWav([{ line: 0, start: 0, audio: m.audio }], m.audio.length / RATE)));
          a.onended = () => {
            stopSample();
            setPreview({ status: "idle" });
          };
          sample.current = a;
          setPreview({ status: "playing" });
          void a.play().catch(() => a.onended?.(new Event("ended")));
        }
        return;
      }
      if (m.jobId !== jobId.current) return;
      switch (m.type) {
        case "download":
          setState({ status: "download", loaded: m.loaded, total: m.total });
          break;
        case "progress":
          setState({ status: "running", done: m.done, total: m.total });
          break;
        case "done": {
          const { words, lines, duration, end, voice, onDone } = pending.current!;
          const last = m.clips.at(-1);
          const totalDuration = Math.max(duration, last ? last.start + last.audio.length / RATE : 0);
          const wav = dubWav(m.clips, totalDuration);
          const url = URL.createObjectURL(wav);
          const timed = timeToDub(words, lines, m.clips);
          const key = end > 0 ? dubKey(words) : dubKey(timed);
          const finalEnd = end > 0 ? end : totalDuration;
          setState({
            status: "done",
            clips: m.clips,
            url,
            key,
            duration: totalDuration,
            timed,
            voice,
            end: finalEnd,
            overflow: m.overflow,
            elapsed: m.elapsed,
          });
          onDone?.({ clips: m.clips, wav, duration: totalDuration, timed, voice, elapsed: m.elapsed });
          break;
        }
        case "cancelled":
          setState({ status: "idle" });
          break;
        case "error":
          setState({ status: "error", message: m.message });
          break;
      }
    };
    worker.current = w;
    return w;
  }, [stopSample]);

  useEffect(
    () => () => {
      worker.current?.terminate();
      stopSample();
    },
    [stopSample],
  );

  // Free the previous result when it is replaced.
  const url = state.status === "done" ? state.url : null;
  useEffect(() => () => void (url && URL.revokeObjectURL(url)), [url]);

  /** `end`: where the dub must be over by (the video's end, or the trim's); 0 for standalone text. */
  const dub = useCallback(
    (
      words: Word[],
      duration: number,
      end: number,
      voice: Voice,
      bySentence: boolean,
      onDone?: (r: DubResult) => void,
    ) => {
      const id = ++jobId.current;
      const lines = dubLines(words, bySentence);
      pending.current = { words, lines, duration, end, voice, onDone };
      setState({ status: "running", done: 0, total: 0 });
      ensureWorker().postMessage({
        type: "dub",
        jobId: id,
        lines: lines.map(({ start, end, text }) => ({ start, end, text })),
        duration,
        end,
        voice,
      } satisfies ToTts);
    },
    [ensureWorker],
  );

  /** Reads the first line of `words` with `voice`; a second call while one runs stops it. */
  const listen = useCallback(
    (words: Word[], voice: Voice, bySentence: boolean, sampleText?: string) => {
      stopSample();
      const id = ++previewId.current;
      // A sample already on its way is dropped when it arrives: its id is out of date.
      if (preview.status !== "idle") {
        setPreview({ status: "idle" });
        return;
      }
      const source = sampleText?.trim() ? wordsFromText(sampleText) : words;
      const text = dubLines(source, bySentence)[0]?.text.trim() || SAMPLE[voice.lang];
      setPreview({ status: "running" });
      ensureWorker().postMessage({ type: "preview", jobId: -id, text, voice } satisfies ToTts);
    },
    [ensureWorker, stopSample, preview.status],
  );

  const cancel = useCallback(() => {
    worker.current?.postMessage({ type: "cancel", jobId: jobId.current } satisfies ToTts);
    jobId.current++;
    setState({ status: "idle" });
  }, []);

  const reset = useCallback(() => {
    jobId.current++;
    setState({ status: "idle" });
  }, []);

  /** A dub kept with the project; `words` are those it should read now, for its captions' times. */
  const restore = useCallback((d: StoredDub, words: Word[], bySentence: boolean) => {
    jobId.current++;
    const clips: DubClip[] = d.clips.map((c) => ({
      line: c.line,
      start: c.start,
      audio: Float32Array.from(c.audio, (v) => v / 32768),
    }));
    // Out of date (the words changed since): shown as such, its captions not used.
    const timed = d.key === dubKey(words) ? timeToDub(words, dubLines(words, bySentence), clips) : words;
    setState({
      status: "done",
      clips,
      url: URL.createObjectURL(dubWav(clips, d.duration)),
      key: d.key,
      duration: d.duration,
      timed,
      restored: true,
      voice: d.voice,
      end: d.end,
      overflow: d.overflow,
      elapsed: d.elapsed,
    });
  }, []);

  return { state, dub, cancel, reset, restore, preview, listen };
}

/** How loud the file's own sound stays under the dub: from silent up to half. */
export const MAX_ORIGINAL = 0.5;

/**
 * Plays the dub in step with the media element, whose own sound is turned down to `original` (0 to 1)
 * meanwhile. The media element stays the clock: the dub follows its play, pause, seek, rate and mute.
 * `volume` is the listener's level and scales both; without a dub it is the element's volume.
 */
export function useDubPlayback(
  el: HTMLMediaElement | null,
  url: string | null,
  on: boolean,
  original: number,
  volume = 1,
) {
  const level = useRef(volume);
  level.current = volume;
  const playing = useRef<HTMLAudioElement | null>(null);
  useEffect(() => {
    if (!el || !url || !on) return;
    const dub = new Audio(url);
    playing.current = dub;
    const sync = () => {
      dub.playbackRate = el.playbackRate;
      dub.muted = el.muted;
      dub.volume = level.current;
      if (Math.abs(dub.currentTime - el.currentTime) > 0.15) dub.currentTime = el.currentTime;
      if (el.paused) dub.pause();
      else void dub.play().catch(() => {});
    };
    const events = ["play", "pause", "ended", "seeked", "ratechange", "volumechange", "timeupdate"];
    events.forEach((e) => el.addEventListener(e, sync));
    sync();
    return () => {
      events.forEach((e) => el.removeEventListener(e, sync));
      dub.pause();
      dub.removeAttribute("src");
      playing.current = null;
    };
  }, [el, url, on]);
  // Apart, so moving a level does not restart the dub.
  useEffect(() => {
    if (playing.current) playing.current.volume = volume;
    if (!el) return;
    const own = url && on ? Math.max(0, Math.min(1, original)) : 1;
    el.volume = Math.max(0, Math.min(1, own * volume));
  }, [el, url, on, original, volume]);
}
