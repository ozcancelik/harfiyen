import { useCallback, useEffect, useRef, useState } from "react";
import type { Word } from "../engine";
import type { FromMt, ToMt } from "../worker/mt.worker";
import type { SpeechLang } from "../engine";
import { isMtLang } from "../engine/languages";
import { mtRoute } from "../models";
import { placeTranslation, sourceKey, splitSentences, type Translation, type TranslationLang } from "./translation";

export type TranslateState =
  | { status: "idle" }
  | { status: "download"; loaded: number; total: number }
  | { status: "running"; done: number; total: number }
  | { status: "error"; message: string };

/** What a running translation shows: its label and how far along it is (0..1); null when none runs. */
export function translateProgress(s: TranslateState): { label: string; value: number } | null {
  if (s.status === "download") {
    const value = s.loaded / (s.total || 1);
    return { label: `Çeviri modeli indiriliyor %${Math.floor(value * 100)}`, value };
  }
  if (s.status === "running") {
    return s.done
      ? { label: `Çevriliyor ${s.done} / ${s.total}`, value: s.done / s.total }
      : { label: "Çeviri modeli hazırlanıyor", value: 0 };
  }
  return null;
}

/** The language a transcript in `from` is translated into unless another is chosen: English, or Turkish for English. */
export const translationLang = (from: SpeechLang): TranslationLang => (from === "en" ? "tr" : "en");

/** Translates the transcript into its other language in its own worker, a sentence at a time. */
export function useTranslator() {
  const worker = useRef<Worker | null>(null);
  const jobId = useRef(0);
  const pending = useRef<{ words: Word[]; lang: TranslationLang; onDone: (t: Translation) => void } | null>(null);
  const sentences = useRef<ReturnType<typeof splitSentences>>([]);
  const [state, setState] = useState<TranslateState>({ status: "idle" });

  const ensureWorker = useCallback(() => {
    if (worker.current) return worker.current;
    const w = new Worker(new URL("../worker/mt.worker.ts", import.meta.url), { type: "module" });
    w.onmessage = (ev: MessageEvent<FromMt>) => {
      const m = ev.data;
      if (m.jobId !== jobId.current) return;
      switch (m.type) {
        case "download":
          setState({ status: "download", loaded: m.loaded, total: m.total });
          break;
        case "progress":
          setState({ status: "running", done: m.done, total: m.total });
          break;
        case "done": {
          const { words, lang, onDone } = pending.current!;
          pending.current = null;
          setState({ status: "idle" });
          onDone({
            lang,
            words: placeTranslation(words, sentences.current, m.texts),
            source: sourceKey(words),
          });
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
  }, []);

  useEffect(() => () => worker.current?.terminate(), []);

  /** `words` are in `from`, translated into `lang`. `onDone` gets the translation, unless another call or cancel() came first. */
  const translate = useCallback(
    (words: Word[], from: SpeechLang, lang: TranslationLang, onDone: (t: Translation) => void) => {
      if (!isMtLang(from) || from === lang) return;
      const w = ensureWorker();
      w.postMessage({ type: "cancel", jobId: jobId.current } satisfies ToMt);
      const id = ++jobId.current;
      pending.current = { words, lang, onDone };
      sentences.current = splitSentences(words);
      setState({ status: "running", done: 0, total: sentences.current.length });
      w.postMessage({
        type: "translate",
        jobId: id,
        pairs: mtRoute(from, lang),
        sentences: sentences.current.map((s) => s.text),
      } satisfies ToMt);
    },
    [ensureWorker],
  );

  const cancel = useCallback(() => {
    worker.current?.postMessage({ type: "cancel", jobId: jobId.current } satisfies ToMt);
    jobId.current++;
    pending.current = null;
    setState({ status: "idle" });
  }, []);

  return { state, translate, cancel };
}
