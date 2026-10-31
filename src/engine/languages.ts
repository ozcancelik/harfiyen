// The languages Whisper is offered in. `token` is the language's place in Whisper's own order: its token id is
// the start-of-transcript id + token (English 1, Turkish 10). Only languages written with spaces between words
// and left to right are listed: the word-based editing and captions rely on both.

export const SPEECH_LANGS = [
  { code: "tr", name: "Türkçe", token: 10 },
  { code: "en", name: "İngilizce", token: 1 },
  { code: "de", name: "Almanca", token: 3 },
  { code: "fr", name: "Fransızca", token: 7 },
  { code: "es", name: "İspanyolca", token: 4 },
  { code: "it", name: "İtalyanca", token: 16 },
  { code: "pt", name: "Portekizce", token: 9 },
  { code: "nl", name: "Hollandaca", token: 13 },
  { code: "ru", name: "Rusça", token: 5 },
  { code: "uk", name: "Ukraynaca", token: 22 },
  { code: "pl", name: "Lehçe", token: 11 },
  { code: "cs", name: "Çekçe", token: 25 },
  { code: "ro", name: "Romence", token: 26 },
  { code: "hu", name: "Macarca", token: 28 },
  { code: "el", name: "Yunanca", token: 23 },
  { code: "bg", name: "Bulgarca", token: 34 },
  { code: "sv", name: "İsveççe", token: 15 },
  { code: "da", name: "Danca", token: 27 },
  { code: "no", name: "Norveççe", token: 30 },
  { code: "fi", name: "Fince", token: 19 },
  { code: "hr", name: "Hırvatça", token: 33 },
  { code: "sr", name: "Sırpça", token: 45 },
  { code: "sq", name: "Arnavutça", token: 59 },
  { code: "az", name: "Azerice", token: 46 },
  { code: "kk", name: "Kazakça", token: 58 },
  { code: "uz", name: "Özbekçe", token: 79 },
  { code: "ka", name: "Gürcüce", token: 71 },
  { code: "hi", name: "Hintçe", token: 18 },
  { code: "id", name: "Endonezce", token: 17 },
  { code: "vi", name: "Vietnamca", token: 20 },
  { code: "ko", name: "Korece", token: 6 },
] as const;

/** The language spoken in the media. Seda, Mihu and Duyu know Turkish only; Whisper knows all of them. */
export type SpeechLang = (typeof SPEECH_LANGS)[number]["code"];

export const LANG_TOKEN = Object.fromEntries(SPEECH_LANGS.map((l) => [l.code, l.token])) as Record<SpeechLang, number>;

/** Languages with a ready quality bar; the rest are experimental, shown with a note. */
export const MAIN_LANGS: readonly SpeechLang[] = ["tr", "en", "de", "fr", "es", "it", "pt", "nl", "ru", "pl"];

/** Languages translation covers: Turkish and English, and the ones with a model to and from English. */
export const MT_LANGS = ["tr", "en", "de", "fr", "es", "ru"] as const satisfies readonly SpeechLang[];
export type MtLang = (typeof MT_LANGS)[number];

export const isMtLang = (l: string): l is MtLang => (MT_LANGS as readonly string[]).includes(l);
