// The languages by code, for what is said to the user and for checking what they ask for.

import { isMtLang, MT_LANGS, SPEECH_LANGS, type SpeechLang } from "../../src/engine/languages";

export { isMtLang, MT_LANGS, SPEECH_LANGS };

/** Language names as the app writes them, by code. */
export const LANG_NAMES: Record<string, string> = Object.fromEntries(SPEECH_LANGS.map((l) => [l.code, l.name]));

const [first, ...rest] = SPEECH_LANGS.map((l) => l.code) as SpeechLang[];
/** The codes for a zod enum: Whisper's languages. */
export const SPEECH_CODES = [first, ...rest] as [SpeechLang, ...SpeechLang[]];
