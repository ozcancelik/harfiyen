// The web app's processing steps, run in Node: transcribe, punctuate, translate, tell speakers apart, find cuts.
// Each step reports progress as a 0..1 share.

import { diarize, Features } from "../../src/diarize";
import type { DecodeOptions, DecodingMethod, SpeechLang, Word } from "../../src/engine";
import { OnlineFbank } from "../../src/engine/fbank";
import { findCuts, DEFAULT_JUMP_CUT, type JumpCut } from "../../src/lib/cuts";
import { fromLabels } from "../../src/lib/speakers";
import { wordsIn } from "../../src/lib/trim";
import { placeTranslation, sourceKey, splitSentences, type Translation } from "../../src/lib/translation";
import { writeNumbers, type NumberMode } from "../../src/lib/numbers";
import { BandTracker } from "../../src/render/aura";
import { plainWord } from "../../src/punct/turkish";
import { pcmChunks, probe } from "./audio";
import { signal } from "./jobs";
import type { Waveform } from "./project";
import { formatter, speakerEmbedder, speechEngine, translator } from "./engines";
import { isMtLang, LANG_NAMES } from "./lang";
import { mtRoute, SPEECH_MODELS, type ModelId } from "./models";
import { MT_LANGS, type MtLang } from "../../src/engine/languages";
import type { Transcript } from "./transcript";

const MT_LIST = MT_LANGS.join(", ");

export type Progress = (share: number, message?: string) => void;

/** The app's three accuracy settings (Hızlı, Dengeli, En doğru) as Seda decoding. Whisper and Duyu ignore them. */
export type Accuracy = "fast" | "balanced" | "best";
export const METHODS: Record<Accuracy, DecodingMethod> = { fast: "greedy", balanced: "beam", best: "beam-lm" };

export interface TranscribeOptions {
  file: string;
  model: ModelId;
  lang: SpeechLang;
  accuracy: Accuracy;
  start?: number;
  end?: number;
  punctuate: boolean;
  numbers: NumberMode;
}

const optionsFor = (accuracy: Accuracy, lang: SpeechLang): DecodeOptions => ({
  method: METHODS[accuracy],
  lang,
  maxActivePaths: 4,
  lmScale: 0.6,
  lodrScale: -0.5,
});

/** Words as the model wrote them; Seda's have no punctuation or capitals yet. */
export async function recognize(o: TranscribeOptions, progress: Progress): Promise<{ words: Word[]; duration: number }> {
  const info = await probe(o.file);
  if (!info.hasAudio) throw new Error("Bu dosyada ses kanalı yok.");
  const info_ = SPEECH_MODELS[o.model];
  if (!info_.langs.includes(o.lang)) throw new Error(`${info_.name} ${LANG_NAMES[o.lang] ?? o.lang} bilmiyor; Whisper seçilmeli.`);
  const start = o.start ?? 0;
  const end = Math.min(o.end ?? info.duration, info.duration);
  progress(0, `${info_.name} yükleniyor`);
  const engine = await speechEngine(o.model);
  const rec = engine.createRecognizer(optionsFor(o.accuracy, o.lang));
  const words: Word[] = [];
  const take = () => words.push(...rec.takeCommitted());
  const span = Math.max(1, end - start);
  for await (const pcm of pcmChunks(o.file, start, end)) {
    rec.acceptWaveform(pcm);
    while (rec.isReady()) {
      await rec.decodeChunk();
      take();
      progress(Math.min(1, rec.decodedSeconds / span), "yazıya dökülüyor");
    }
  }
  rec.inputFinished();
  while (rec.isReady()) await rec.decodeChunk();
  rec.flush();
  take();
  progress(1);
  // Times are the file's, as in the app.
  return { words: start ? words.map((w) => ({ ...w, start: w.start + start, end: w.end + start })) : words, duration: info.duration };
}

/** Punctuation and capitals, as the app's applyPunct: words already in digits keep their writing. */
export async function punctuate(words: Word[], progress: Progress): Promise<Word[]> {
  if (!words.length) return words;
  const model = await formatter("punct");
  const written = await model.run(
    words.map((w) => plainWord(w.text) || w.text),
    (done, total) => progress(done / total, "noktalama"),
  );
  const keep = (old: string, now: string) =>
    /\d/.test(old) ? old.replace(/[.,;:!?…]+$/, "") + (/[.,;:!?…]+$/.exec(now)?.[0] ?? "") : now;
  return words.map((w, i) => ({ ...w, text: keep(w.text, written[i]) }));
}

export async function transcribe(o: TranscribeOptions, progress: Progress) {
  const { words: raw, duration } = await recognize(o, (s, m) => progress(s * (o.punctuate ? 0.9 : 1), m));
  let words = raw;
  // Whisper and Duyu punctuate by themselves.
  if (o.punctuate && !SPEECH_MODELS[o.model].punctuates && o.lang === "tr") {
    words = await punctuate(words, (s, m) => progress(0.9 + s * 0.1, m));
  }
  return { words: writeNumbers(words, o.lang === "tr" ? o.numbers : "keep"), duration };
}

/** The language a transcript in `from` is translated into unless another is asked for: English, or Turkish for English. */
export const defaultTarget = (from: string): MtLang => (from === "en" ? "tr" : "en");

export async function translate(t: Transcript, progress: Progress, target?: MtLang): Promise<Translation> {
  if (!t.words.length) throw new Error("Transkript boş.");
  if (!isMtLang(t.lang)) throw new Error(`Çeviri ${LANG_NAMES[t.lang] ?? t.lang} için yok; dil ${MT_LIST} arasında olmalı.`);
  const to = target ?? defaultTarget(t.lang);
  if (to === t.lang) throw new Error("Çeviri dili transkriptin diliyle aynı.");
  const route = mtRoute(t.lang, to);
  progress(0, "çeviri modeli yükleniyor");
  // One after the other: each model is loaded before the sentences start.
  const chain = [];
  for (const pair of route) chain.push(await translator(pair));
  const sentences = splitSentences(t.words);
  const texts: string[] = [];
  for (const [i, s] of sentences.entries()) {
    progress(i / sentences.length, "çevriliyor");
    let text = s.text;
    for (const mt of chain) text = await mt.translate(text);
    texts.push(text);
  }
  progress(1);
  return { lang: to, words: placeTranslation(t.words, sentences, texts), source: sourceKey(t.words) };
}

/** Who speaks when: sets the transcript's speakers from the audio. */
export async function tellSpeakers(t: Transcript, speakers: number | undefined, progress: Progress) {
  if (!t.source) throw new Error("Konuşmacı ayırmak için transkriptin bir ses ya da video dosyası olmalı.");
  const start = t.range?.start ?? 0;
  const end = t.range?.end ?? t.duration;
  const words = wordsIn(t.words, t.range ?? null);
  progress(0, "model yükleniyor");
  const embedder = await speakerEmbedder("speakers");
  const audio = new Features();
  for await (const pcm of pcmChunks(t.source, start, end)) audio.push(pcm);
  audio.finish();
  const labels = await diarize(embedder, audio, start, words, {
    speakers,
    onProgress: (done) => progress(done, "sesler karşılaştırılıyor"),
    isCancelled: () => !!signal()?.aborted,
  });
  if (!labels) throw new Error("İptal edildi.");
  progress(1);
  return fromLabels(words, labels);
}

/** Speech loudness per BAND_RATE frame from the file's start, the way the recognizer's features give it. */
export async function loudnessOf(file: string, end?: number): Promise<Float32Array> {
  const fb = new OnlineFbank(80);
  const bands = new BandTracker();
  const take = () => fb.compute((f) => bands.push(f));
  for await (const pcm of pcmChunks(file, 0, end)) {
    fb.acceptWaveform(pcm);
    take();
  }
  fb.inputFinished();
  take();
  return bands.takeLoudness();
}

/** The stretches the jump cut would take out of the transcript's span, in file time. */
/** `keep`: sound that must stay as well (the dub's lines). */
export async function planCuts(t: Transcript, jc: Partial<JumpCut>, keep: { start: number; end: number }[] = []) {
  if (!t.source) throw new Error("Boşluk kesmek için transkriptin bir ses ya da video dosyası olmalı.");
  const span = t.range ?? { start: 0, end: t.duration };
  const loudness = await loudnessOf(t.source, span.end);
  // A setting left out arrives as undefined, which would overwrite its default.
  const given = Object.fromEntries(Object.entries(jc).filter(([, v]) => v !== undefined));
  return findCuts(t.words, span, { ...DEFAULT_JUMP_CUT, on: true, ...given }, loudness, keep);
}

/** Peak amplitude per this many seconds, as the app's waveform (src/worker/protocol.ts). */
const PEAK_STEP = 0.1;

/** What a project file stores of the sound: peaks for the timeline, aura bands and speech loudness. Whole file, from 0. */
export async function waveformOf(file: string, duration: number, progress: Progress): Promise<Waveform> {
  const fb = new OnlineFbank(80);
  const bands = new BandTracker();
  const peaks = new Float32Array(Math.floor(duration / PEAK_STEP));
  const bands_: Float32Array[] = [];
  const loud: Float32Array[] = [];
  const step = Math.round(16000 * PEAK_STEP);
  let at = 0;
  const take = () => {
    fb.compute((f) => bands.push(f));
    bands_.push(bands.take());
    loud.push(bands.takeLoudness());
  };
  for await (const pcm of pcmChunks(file, 0, duration)) {
    for (let i = 0; i < pcm.length; i++) {
      const k = Math.floor((at + i) / step);
      if (k < peaks.length) peaks[k] = Math.max(peaks[k], Math.abs(pcm[i]));
    }
    at += pcm.length;
    fb.acceptWaveform(pcm);
    take();
    progress(Math.min(1, at / 16000 / Math.max(1, duration)), "ses okunuyor");
  }
  fb.inputFinished();
  take();
  const join = (parts: Float32Array[]) => {
    const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) (out.set(p, o), (o += p.length));
    return out;
  };
  return { peaks, bands: join(bands_), loudness: join(loud) };
}
