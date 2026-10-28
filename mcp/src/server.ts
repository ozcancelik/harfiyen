// Harfiyen as an MCP server over stdio. Audio and video stay on this computer, as in the web app.

import { copyFileSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { Word } from "../../src/engine";
import { alignText } from "../../src/lib/align";
import { buildCues, SUBTITLE_RULES } from "../../src/lib/cues";
import { replaceRange } from "../../src/lib/edit";
import { toJson, toSrt, toText, toVtt } from "../../src/lib/exporters";
import { findMatches, replaceMatches } from "../../src/lib/find";
import { clock } from "../../src/lib/format";
import { assign, labelWords, merge, rename } from "../../src/lib/speakers";
import { parseSubtitles } from "../../src/lib/subtitles";
import { retime, shiftAll, shiftSpan } from "../../src/lib/timing";
import { writeNumbers } from "../../src/lib/numbers";
import { sourceKey } from "../../src/lib/translation";
import { renderCaptions, DEFAULT_CAPTIONS } from "./captions";
import * as jobs from "./jobs";
import { lookOf } from "./appstyle";
import { dubBySentence, dubKey, dubLines, dubWavPath, loadDub, placeLines, saveDub, speak, timeToDub, wordsFromText, writeDubWav, type DubMeta } from "./dub";
import { BUNDLED } from "./fonts";
import { installed, modelDir, SPEECH_MODELS } from "./models";
import { fitVoice, speaker, VOICE_INFO, type Voice, type VoiceLang, type VoiceModel } from "./voices";
import { METHODS, planCuts, punctuate, tellSpeakers, transcribe, translate, waveformOf } from "./pipeline";
import { PROJECT_EXT, readProject, writeProject } from "./project";
import { probe } from "./audio";
import * as store from "./transcript";
import type { Transcript } from "./transcript";

// stdout carries the protocol: anything printed there would corrupt it.
console.log = console.error;

const server = new McpServer({ name: "harfiyen", version: "0.1.0" });

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const fail = (e: unknown) => ({ isError: true, content: [{ type: "text" as const, text: e instanceof Error ? e.message : String(e) }] });
const abs = (p: string) => resolve(p.replace(/^~(?=\/)/, process.env.HOME ?? "~"));

type Extra = { _meta?: { progressToken?: string | number }; sendNotification: (n: never) => Promise<void> };

/** Runs heavy work as a job: waits for it, sending progress to the client, or hands back the job id. */
async function heavy(tool: string, extra: Extra, background: boolean | undefined, work: (report: jobs.Report) => Promise<string>) {
  let last = 0;
  const token = extra._meta?.progressToken;
  const { job, done } = jobs.start(tool, work, (j) => {
    const now = Date.now();
    if (token === undefined || now - last < 1000) return;
    last = now;
    void extra
      .sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: Math.round(j.progress * 100), total: 100, message: j.message } } as never)
      .catch(() => {});
  });
  if (background) return text(`İş başlatıldı: ${job.id}. İlerlemesi job_status ile sorulabilir.`);
  const finished = await done;
  return finished.state === "error" ? fail(finished.error) : text(finished.result ?? "");
}

const view = (t: Transcript, language: "transcript" | "translation" = "transcript"): Word[] => {
  if (language === "translation") {
    if (!t.translation) throw new Error("Bu transkriptin çevirisi yok; önce translate çalıştırılmalı.");
    return labelWords(t.translation.words, t.speakers);
  }
  return labelWords(t.words, t.speakers);
};

/** The translation was made from other words than the transcript has now (the app says the same). */
const stale = (t: Transcript) => !!t.translation && t.translation.source !== sourceKey(t.words);

const summary = (t: Transcript) =>
  `${t.id}  ${t.name}  ${t.words.length} kelime  ${clock(t.duration)}  ${t.lang}${t.model ? `  ${t.model}` : ""}` +
  `${t.translation ? (stale(t) ? "  çeviri eski" : "  çeviri var") : ""}${t.speakers ? `  ${t.speakers.names.length} konuşmacı` : ""}`;

function render(t: Transcript, format: "lines" | "text" | "srt" | "vtt" | "json", language: "transcript" | "translation"): string {
  const words = view(t, language);
  const names = t.speakers?.names;
  switch (format) {
    case "srt":
      return toSrt(buildCues(words, SUBTITLE_RULES), names);
    case "vtt":
      return toVtt(buildCues(words, SUBTITLE_RULES), names);
    case "text":
      return toText(words, names);
    case "json":
      return toJson(words, { id: t.id, name: t.name, lang: language === "translation" ? t.translation?.lang : t.lang, duration: t.duration }, names);
    default:
      // The word range of each line, so edit_words can address it.
      return buildCues(words, SUBTITLE_RULES)
        .map((c) => `[${c.first}..${c.first + c.words.length - 1}] ${clock(c.start)} ${c.words.map((w) => w.text).join(" ")}`)
        .join("\n");
  }
}

const trimmed = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)}\n… (${s.length - max} karakter daha var; max_chars artırılabilir)` : s);

const Format = z.enum(["lines", "text", "srt", "vtt", "json"]);
const Language = z.enum(["transcript", "translation"]).default("transcript");
const Background = z.boolean().optional().describe("true: iş arka planda sürer, job_status ile sorulur");

server.registerTool(
  "status",
  {
    title: "Durum",
    description: "Hangi modellerin diskte olduğunu, ffmpeg'in kurulu olup olmadığını ve kayıtlı transkriptleri gösterir.",
    inputSchema: {},
  },
  async () => {
    const ok = await probe("/dev/null").then(() => true, (e: Error) => !/çalıştırılamadı/.test(e.message));
    const m = installed();
    return text(
      JSON.stringify(
        {
          ffmpeg: ok,
          ...m,
          voices: Object.fromEntries((Object.keys(VOICE_INFO) as VoiceModel[]).map((v) => [v, { ...VOICE_INFO[v], installed: existsSync(join(modelDir(VOICE_INFO[v].dir), "model.json")) }])),
          fonts: BUNDLED.map((f) => f.family),
          transcripts: store.list().length,
        },
        null,
        2,
      ),
    );
  },
);

server.registerTool(
  "transcribe",
  {
    title: "Yazıya dök",
    description:
      "Bir ses ya da video dosyasını kelime zamanlı yazıya döker. Seda çıktısına noktalama ve büyük harf eklenir, sayılar yazılır. Whisper CPU'da yavaştır (gerçek zamandan uzun sürebilir). Sonuç bir transkript kimliğidir; diğer araçlar onunla çalışır.",
    inputSchema: {
      file: z.string().describe("Ses ya da video dosyasının yolu"),
      model: z.enum(["seda", "duyu", "whisper-turbo", "whisper-turbo-q4"]).default("seda"),
      lang: z.enum(["tr", "en"]).default("tr").describe("Videodaki dil; İngilizceyi yalnızca Whisper bilir"),
      accuracy: z.enum(["fast", "balanced", "best"]).default("best").describe("Yalnızca Seda: Hızlı, Dengeli, En doğru"),
      start: z.number().min(0).optional().describe("Başlangıç, saniye"),
      end: z.number().min(0).optional().describe("Bitiş, saniye"),
      punctuate: z.boolean().default(true).describe("Noktalama ve büyük harf (Seda için)"),
      numbers: z.enum(["rule", "all", "keep"]).default("rule").describe("rule: 1–9 yazıyla, 10 ve üstü rakamla; all: hepsi rakam; keep: dokunma"),
      name: z.string().optional(),
      background: Background,
    },
  },
  (a, extra) =>
    heavy("transcribe", extra as unknown as Extra, a.background, async (report) => {
      const file = abs(a.file);
      const { words, duration } = await transcribe({ ...a, file }, report);
      const t = store.create({
        name: a.name ?? basename(file, extname(file)),
        source: file,
        range: a.start !== undefined || a.end !== undefined ? { start: a.start ?? 0, end: Math.min(a.end ?? duration, duration) } : undefined,
        duration,
        model: SPEECH_MODELS[a.model].name,
        modelId: a.model,
        method: METHODS[a.accuracy],
        lang: a.lang,
        words,
      });
      const lines = render(t, "lines", "transcript");
      return `${summary(t)}\n\n${trimmed(lines, 4000)}`;
    }),
);

server.registerTool(
  "import_subtitles",
  {
    title: "SRT / VTT aç",
    description: "Hazır bir SRT ya da VTT dosyasını transkript olarak açar. Satırlar ve zamanlar korunur. İstenirse video için source verilir.",
    inputSchema: {
      path: z.string(),
      source: z.string().optional().describe("Altyazının ait olduğu video ya da ses dosyası"),
      lang: z.enum(["tr", "en"]).default("tr"),
    },
  },
  async (a) => {
    try {
      const bytes = readFileSync(abs(a.path));
      let content: string;
      try {
        content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        content = new TextDecoder("windows-1254").decode(bytes);
      }
      const words = parseSubtitles(content);
      const source = a.source ? abs(a.source) : undefined;
      const duration = source ? (await probe(source)).duration : (words.at(-1)?.end ?? 0);
      const t = store.create({ name: basename(a.path, extname(a.path)), source, duration, lang: a.lang, words, imported: basename(a.path) });
      return text(summary(t));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "import_project",
  {
    title: "Harfiyen projesi aç",
    description:
      "Web uygulamasında kaydedilmiş bir .harfiyen proje dosyasını transkript olarak açar: kelimeler, çeviri, konuşmacılar ve bölüm seçimi gelir. Medya dosyası projede yoktur; source verilmezse dosyanın yanında projenin kayıtlı medya adı aranır, bulunamazsa set_source ile verilir. Uygulamanın altyazı stili ve kadrajı saklanır, projeyi geri yazarken kaybolmaz.",
    inputSchema: {
      path: z.string().describe(".harfiyen dosyasının yolu"),
      source: z.string().optional().describe("Projenin ses ya da video dosyası"),
    },
  },
  async (a) => {
    try {
      const file = abs(a.path);
      const t = store.create(readProject(readFileSync(file, "utf8"), file, a.source ? abs(a.source) : undefined));
      const note = t.source ? "" : "\nMedya dosyası bulunamadı: konuşmacı ayırma, boşluk kesme ve video için set_source gerekir.";
      return text(`${summary(t)}${note}`);
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "set_source",
  {
    title: "Medya dosyasını bağla",
    description: "Transkriptin ses ya da video dosyasını belirler (örneğin proje açılırken bulunamadıysa).",
    inputSchema: { id: z.string(), source: z.string() },
  },
  async (a) => {
    try {
      const t = store.load(a.id);
      const file = abs(a.source);
      const info = await probe(file);
      if (!info.hasAudio) throw new Error("Bu dosyada ses kanalı yok.");
      t.source = file;
      t.duration = info.duration;
      store.save(t);
      return text(`Bağlandı: ${file} (${clock(info.duration)})`);
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "export_project",
  {
    title: "Harfiyen projesi olarak kaydet",
    description:
      "Transkripti web uygulamasının açabileceği bir .harfiyen proje dosyasına yazar. Medya dosyası projeye girmez; uygulamada projeyi açınca dosya yeniden bağlanır. Medya varsa ses dalgası ve aura verisi de hesaplanıp eklenir (bölüm seçilmiş transkriptlerde eklenmez).",
    inputSchema: {
      id: z.string(),
      output: z.string().describe(`Yazılacak dosyanın yolu (${PROJECT_EXT})`),
      waveform: z.boolean().default(true).describe("Medyadan dalga formu ve ses düzeyi hesapla"),
      background: Background,
    },
  },
  (a, extra) =>
    heavy("export_project", extra as unknown as Extra, a.background, async (report) => {
      const t = store.load(a.id);
      const out = abs(a.output.endsWith(PROJECT_EXT) ? a.output : a.output + PROJECT_EXT);
      const wave = a.waveform && t.source && !t.range ? await waveformOf(t.source, t.duration, report) : undefined;
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, writeProject(t, wave));
      return `Yazıldı: ${out}${wave ? "" : "\nDalga formu eklenmedi; uygulama medya bağlanınca kendisi okur."}`;
    }),
);

server.registerTool(
  "list_transcripts",
  { title: "Transkriptler", description: "Kayıtlı transkriptleri listeler.", inputSchema: {} },
  async () => text(store.list().map(summary).join("\n") || "Kayıtlı transkript yok."),
);

server.registerTool(
  "get_transcript",
  {
    title: "Transkripti oku",
    description:
      "Transkripti okur. lines: her satırın kelime aralığı ve zamanıyla (edit_words bu aralıklarla çalışır); text, srt, vtt, json de olur. language=translation çeviriyi verir.",
    inputSchema: { id: z.string(), format: Format.default("lines"), language: Language, max_chars: z.number().int().positive().default(20000) },
  },
  async (a) => {
    try {
      const t = store.load(a.id);
      const warn = a.language === "translation" && stale(t) ? "Not: Transkript çeviriden sonra değişti; çeviri eski. translate ile yenilenir.\n\n" : "";
      return text(warn + trimmed(render(t, a.format, a.language), a.max_chars));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "export_transcript",
  {
    title: "Dışa aktar",
    description: "Transkripti SRT, VTT, düz metin ya da kelime zamanlı JSON olarak dosyaya yazar.",
    inputSchema: { id: z.string(), format: z.enum(["srt", "vtt", "text", "json"]), language: Language, output: z.string().describe("Yazılacak dosyanın yolu") },
  },
  async (a) => {
    try {
      const t = store.load(a.id);
      const out = abs(a.output);
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, render(t, a.format, a.language));
      return text(`Yazıldı: ${out}`);
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "edit_words",
  {
    title: "Kelimeleri düzelt",
    description:
      "get_transcript lines çıktısındaki [ilk..son] aralığındaki kelimeleri verilen metinle değiştirir; değişmeyen kelimelerin zamanı korunur. Boş metin siler.",
    inputSchema: { id: z.string(), first: z.number().int().min(0), count: z.number().int().min(1), text: z.string() },
  },
  async (a) => {
    try {
      const t = store.load(a.id);
      if (a.first >= t.words.length) throw new Error(`Kelime sırası ${a.first} aralık dışında (0..${t.words.length - 1}).`);
      store.checkpoint(t, `edit_words ${a.first}..${a.first + a.count - 1}`);
      t.words = replaceRange(t.words, a.first, a.count, a.text);
      store.save(t);
      return text(`Güncellendi. ${summary(t)}`);
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "find_replace",
  {
    title: "Bul ve değiştir",
    description: "Yanlış tanınan bir kelimeyi ya da ismi bütün transkriptte (ya da çeviride) düzeltir. Büyük/küçük harfe bakmaz. Önce find_text ile nerede olduğuna bakılabilir.",
    inputSchema: {
      id: z.string(),
      query: z.string(),
      replacement: z.string(),
      whole_word: z.boolean().default(false),
      language: Language,
      dry_run: z.boolean().default(false).describe("true: yalnızca kaç eşleşme olduğunu söyler"),
    },
  },
  async (a) => {
    try {
      const t = store.load(a.id);
      const tr = a.language === "translation";
      if (tr && !t.translation) throw new Error("Bu transkriptin çevirisi yok.");
      const words = tr ? t.translation!.words : t.words;
      const lang = tr ? t.translation!.lang : t.lang;
      const matches = findMatches(words, a.query, a.whole_word, lang);
      if (!a.dry_run && matches.length) {
        store.checkpoint(t, `find_replace "${a.query}" → "${a.replacement}"${tr ? " (çeviri)" : ""}`);
        const next = replaceMatches(words, matches, a.replacement, lang);
        if (tr) t.translation = { ...t.translation!, words: next };
        else t.words = next;
        store.save(t);
      }
      return text(`${matches.length} eşleşme${a.dry_run || !matches.length ? "" : " değiştirildi"}.`);
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "find_text",
  {
    title: "Metinde ara",
    description: "Bir kelimeyi ya da ifadeyi transkriptte (ya da çeviride) arar; her eşleşmenin kelime aralığını, zamanını ve çevresindeki metni listeler. edit_words ve retime_words bu aralıklarla çalışır.",
    inputSchema: { id: z.string(), query: z.string(), whole_word: z.boolean().default(false), language: Language, limit: z.number().int().min(1).max(200).default(50) },
  },
  async (a) => {
    try {
      const t = store.load(a.id);
      const tr = a.language === "translation";
      if (tr && !t.translation) throw new Error("Bu transkriptin çevirisi yok.");
      const words = tr ? t.translation!.words : t.words;
      const found = findMatches(words, a.query, a.whole_word, tr ? t.translation!.lang : t.lang);
      const lines = found.slice(0, a.limit).map((m) => {
        const around = words.slice(Math.max(0, m.first - 3), m.last + 4).map((w) => w.text).join(" ");
        return `[${m.first}..${m.last}] ${clock(words[m.first].start)}  …${around}…`;
      });
      return text(`${found.length} eşleşme${found.length > a.limit ? ` (ilk ${a.limit} gösteriliyor)` : ""}.${lines.length ? `\n${lines.join("\n")}` : ""}`);
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "shift_timing",
  {
    title: "Zamanı kaydır",
    description: "Bütün altyazıyı (çevirisiyle birlikte) verilen saniye kadar öne (−) ya da geriye (+) alır.",
    inputSchema: { id: z.string(), seconds: z.number() },
  },
  async (a) => {
    try {
      const t = store.load(a.id);
      store.checkpoint(t, `shift_timing ${a.seconds} sn`);
      t.words = shiftAll(t.words, a.seconds);
      if (t.translation) t.translation = { ...t.translation, words: shiftAll(t.translation.words, a.seconds) };
      store.save(t);
      return text(`${a.seconds} sn kaydırıldı.`);
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "align_text",
  {
    title: "Metni sese hizala",
    description:
      "Elindeki doğru metni (şarkı sözü, konuşma metni) transkriptin zamanlarına hizalar. Kelimeler metinden, zamanlar dökümden gelir. Yeni bir transkript açar; eskisi değişmez.",
    inputSchema: {
      id: z.string(),
      text: z.string(),
      lines: z.boolean().default(false).describe("Her metin satırı ayrı bir altyazı satırı olsun (şarkı sözü, şiir)"),
    },
  },
  async (a) => {
    try {
      const t = store.load(a.id);
      const timed = alignText(t.words, a.text, { lines: a.lines });
      const out = store.create({ ...t, name: `${t.name} (hizalı)`, words: timed.words, speakers: undefined, translation: undefined });
      return text(`${summary(out)}\n${timed.anchored.filter(Boolean).length}/${timed.words.length} kelime dökümle eşleşti.`);
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "translate",
  {
    title: "Çevir",
    description: "Türkçe transkripti İngilizceye, İngilizceyi Türkçeye cümle cümle çevirir; her cümle aslının zamanında kalır.",
    inputSchema: { id: z.string(), background: Background },
  },
  (a, extra) =>
    heavy("translate", extra as unknown as Extra, a.background, async (report) => {
      const t = store.load(a.id);
      store.checkpoint(t, "translate");
      t.translation = await translate(t, report);
      store.save(t);
      return `Çeviri hazır (${t.translation.lang}).\n${render(t, "lines", "translation").slice(0, 3000)}`;
    }),
);

server.registerTool(
  "tell_speakers",
  {
    title: "Konuşmacıları ayır",
    description: "Kimin ne zaman konuştuğunu sesinden bulur. Konuşmacılar \"Konuşmacı 1\", \"Konuşmacı 2\" diye adlanır; rename_speaker ile değişir.",
    inputSchema: { id: z.string(), speakers: z.number().int().min(1).max(12).optional().describe("Kaç kişi konuşuyor; biliniyorsa sonucu iyileştirir"), background: Background },
  },
  (a, extra) =>
    heavy("tell_speakers", extra as unknown as Extra, a.background, async (report) => {
      const t = store.load(a.id);
      store.checkpoint(t, "tell_speakers");
      t.speakers = await tellSpeakers(t, a.speakers, report);
      store.save(t);
      return `${t.speakers.names.length} konuşmacı bulundu.\n${render(t, "lines", "transcript").slice(0, 3000)}`;
    }),
);

server.registerTool(
  "rename_speaker",
  {
    title: "Konuşmacıyı adlandır",
    description: "Konuşmacıya ad verir (SRT, VTT, metin ve videoda bu ad görünür).",
    inputSchema: { id: z.string(), speaker: z.number().int().min(0).describe("Konuşmacının sırası, 0'dan başlar"), name: z.string().min(1) },
  },
  async (a) => {
    try {
      const t = store.load(a.id);
      if (!t.speakers) throw new Error("Önce tell_speakers çalıştırılmalı.");
      if (a.speaker >= t.speakers.names.length) throw new Error(`Konuşmacı ${a.speaker} yok (0..${t.speakers.names.length - 1}).`);
      store.checkpoint(t, `rename_speaker ${a.speaker}`);
      t.speakers = rename(t.speakers, a.speaker, a.name);
      store.save(t);
      return text(`Konuşmacılar: ${t.speakers.names.join(", ")}`);
    } catch (e) {
      return fail(e);
    }
  },
);

const JumpCutShape = {
  gap: z.number().min(0.1).default(0.6).describe("Kesilecek en kısa sessizlik, saniye"),
  pad: z.number().min(0).default(0.15).describe("Konuşmanın iki yanında kalan sessizlik, saniye"),
  fillers: z.boolean().default(true).describe("\"ııı\", \"eee\", \"hmm\" gibi dolgu sesleri de kes"),
};

server.registerTool(
  "plan_jump_cut",
  {
    title: "Boşluk kesme planı",
    description: "Kelimeler arasındaki uzun sessizlikleri ve dolgu seslerini bulur; dosyanın zamanlarıyla kesilecek aralıkları listeler. Dosyaya dokunmaz.",
    inputSchema: { id: z.string(), ...JumpCutShape, background: Background },
  },
  (a, extra) =>
    heavy("plan_jump_cut", extra as unknown as Extra, a.background, async (report) => {
      const t = store.load(a.id);
      report(0, "ses okunuyor");
      const cuts = await planCuts(t, a);
      const total = cuts.reduce((s, c) => s + (c.end - c.start), 0);
      return `${cuts.length} kesim, toplam ${total.toFixed(1)} sn.\n${cuts.map((c) => `${c.start.toFixed(2)}–${c.end.toFixed(2)}`).join("\n")}`;
    }),
);

/** The jump cut's settings for render_captions: left out, the project's (or the defaults) apply. */
const JumpCutOptional = {
  gap: z.number().min(0.1).optional().describe("Kesilecek en kısa sessizlik, saniye (varsayılan 0,6)"),
  pad: z.number().min(0).optional().describe("Konuşmanın iki yanında kalan sessizlik, saniye (varsayılan 0,15)"),
  fillers: z.boolean().optional().describe("\"ııı\", \"eee\", \"hmm\" gibi dolgu sesleri de kes (varsayılan açık)"),
};

server.registerTool(
  "render_captions",
  {
    title: "Altyazılı video",
    description:
      "Altyazıyı videoya yazar (ffmpeg + libass). Transkript web uygulamasının .harfiyen projesinden geldiyse (import_project) projenin altyazı stili, yazı tipi, renkleri, boyutu, kadrajı (kırpma kutusu ya da sığdırma, bulanık zemin) ve boşluk kesme ayarı varsayılan olarak kullanılır; verilen parametreler bunun üstüne yazar, use_project=false projeyi yok sayar. Stiller: klasik (koyu kutu), sade (gölgeli), karaoke (söylenen kelime renkle dolar), akis (kelimeler söylendikçe yerinde belirir), odak (bulanıktan netleşir), vurgu (söylenen kelime renkli işaretleyici), pop (ortada 3 iri zıplayan kelime), netles (ortada tek iri kelime bulanıktan netleşir), tek-kelime (ortada tek iri kelime). Cam stili, aura, logo ve kinetik tipografi yok; projede varsa cevapta not olarak bildirilir. Yalnızca ses dosyasında koyu bir zemin kullanılır.",
    inputSchema: {
      id: z.string(),
      output: z.string().describe("Yazılacak .mp4 dosyasının yolu"),
      use_project: z.boolean().default(true).describe("Transkript bir Harfiyen projesinden geldiyse onun stilini ve kadrajını kullan"),
      style: z.enum(["klasik", "sade", "karaoke", "akis", "odak", "vurgu", "pop", "netles", "tek-kelime"]).optional(),
      emphasis: z.boolean().optional().describe("Sesle vurgula: çevresinden yüksek sesle söylenen kelimeler büyük (ve çoğu stilde vurgu renginde) yazılır"),
      language: Language,
      dub: z.boolean().optional().describe("Seslendirmeyi (dub aracı) karıştır; verilmezse varsa karıştırılır, false ile hiç karıştırılmaz"),
      original_volume: z.number().min(0).max(0.5).default(0).describe("Seslendirmenin altında dosyanın kendi sesi, 0–0,5 (0: hiç duyulmaz, uygulamadaki gibi)"),
      follow_dub: z.boolean().optional().describe("Seslendirmeyle aynı dildeki altyazı sesin zamanını izler (varsayılan açık)"),
      font: z
        .string()
        .optional()
        .describe(`Paketli yazı tiplerinden biri (${BUNDLED.map((f) => f.family).join(", ")}) ya da sistemde kurulu bir yazı tipi adı`),
      font_file: z.string().optional().describe("Kendi yazı tipin (TTF ya da OTF); verilirse font yerine bu kullanılır"),
      bold: z.boolean().optional().describe("Kalın; verilmezse yazı tipine göre (Anton, Bangers gibi tek kalınlıklılarda kapalı)"),
      uppercase: z.boolean().optional().describe("Türkçe kurala uygun büyük harf (i → İ); verilmezse yazı tipine göre (Luckiest Guy, Bangers, Bebas Neue yalnızca büyük harf bildiği için açık)"),
      size: z.number().min(0.02).max(0.15).optional().describe("Yazı boyu, kare yüksekliğinin payı; büyük stiller (pop, tek-kelime, netles) bunu ayrıca büyütür"),
      position: z.enum(["alt", "orta", "ust"]).optional().describe("Verilmezse stile göre: tek kelimelik stiller ortada, diğerleri altta"),
      text_background: z.enum(["box", "outline", "shadow"]).optional().describe("Yazının zemini: koyu kutu, kontur ya da gölge"),
      color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
      accent: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().describe("Vurgu rengi (karaoke dolgusu, vurgu kutusu)"),
      speaker_names: z.boolean().optional().describe("Konuşan değişince adı yazılsın (varsayılan: proje ne diyorsa, yoksa açık)"),
      aspect: z.enum(["9:16", "4:5", "1:1", "16:9"]).optional().describe("Kadraj; verilirse projenin kırpma kutusu yok sayılır ve ortadan kırpılır"),
      fit: z.enum(["fill", "fit"]).optional().describe("fill: kareyi kapla, taşanı kes; fit: tamamı görünsün, boşluk siyah ya da bulanık"),
      backdrop: z.enum(["black", "blur"]).optional().describe("fit'te görüntünün çevresi: siyah ya da görüntünün kendisi bulanık"),
      jump_cut: z.boolean().optional().describe("Sessizlikleri ve dolgu seslerini videodan çıkar; verilmezse projenin ayarı"),
      ...JumpCutOptional,
      codec: z.enum(["h264", "hevc"]).default("h264"),
      crf: z.number().int().min(10).max(35).default(20).describe("Kalite; düşük daha iyi"),
      width: z.number().int().min(240).max(3840).optional().describe("Çıkış genişliği, piksel"),
      background: Background,
    },
  },
  (a, extra) =>
    heavy("render_captions", extra as unknown as Extra, a.background, async (report) => {
      const t = store.load(a.id);
      const look = a.use_project ? lookOf(t.app) : lookOf(undefined);
      // The project's size, position and background belong to its own style: with another style asked for, they are left out.
      const ownStyle = a.style === undefined || a.style === look.style;
      const fromProject = ownStyle ? look.captions : { ...look.captions, size: undefined, sizeBasis: undefined, position: undefined, background: undefined };
      const size =
        a.size !== undefined
          ? { size: a.size }
          : fromProject.size !== undefined
            ? { size: fromProject.size, sizeBasis: fromProject.sizeBasis }
            : { size: DEFAULT_CAPTIONS.size };
      // A ratio asked for here replaces the project's crop; a fit asked for drops the crop box (a box is a fill).
      const ownCrop = a.aspect === undefined;
      const fit = a.fit ?? (ownCrop ? look.fit : undefined) ?? "fill";
      const jumpCut =
        a.jump_cut === false
          ? undefined
          : a.jump_cut === true || look.jumpCut
            ? { gap: a.gap ?? look.jumpCut?.gap, pad: a.pad ?? look.jumpCut?.pad, fillers: a.fillers ?? look.jumpCut?.fillers }
            : undefined;
      const r = await renderCaptions(
        t,
        {
          output: abs(a.output),
          captions: {
            style: a.style ?? look.style ?? DEFAULT_CAPTIONS.style,
            font: a.font ?? look.captions.font ?? DEFAULT_CAPTIONS.font,
            bold: a.bold,
            uppercase: a.uppercase ?? look.captions.uppercase,
            ...size,
            position: a.position ?? fromProject.position,
            background: a.text_background ?? fromProject.background,
            color: a.color ?? look.captions.color ?? DEFAULT_CAPTIONS.color,
            accent: a.accent ?? look.captions.accent ?? DEFAULT_CAPTIONS.accent,
          },
          emphasis: a.emphasis ?? look.emphasis ?? false,
          speakerNames: a.speaker_names ?? look.speakerNames,
          fontFile: a.font_file ? abs(a.font_file) : undefined,
          aspect: a.aspect ?? (ownCrop ? look.aspect : undefined),
          fit,
          backdrop: a.backdrop ?? (ownCrop ? look.backdrop : undefined),
          cropBox: ownCrop && fit === "fill" ? look.cropBox : undefined,
          jumpCut,
          language: a.language,
          dub: a.dub,
          original: a.original_volume,
          followDub: a.follow_dub,
          codec: a.codec,
          crf: a.crf,
          width: a.width,
        },
        report,
      );
      const given = [
        a.style === undefined && look.used.style,
        ownCrop && a.fit === undefined && look.used.crop,
        a.jump_cut === undefined && look.used.jumpCut,
      ].filter(Boolean);
      const used = given.length ? `\nProjeden: ${given.join(", ")}` : "";
      const notes = look.notes.map((n) => `\nNot: ${n}`).join("");
      const dubbed = r.dubbed ? `\nSeslendirme karıştırıldı (orijinal ses %${Math.round(a.original_volume * 100)}).` : "";
      const more = r.notes.map((n) => `\nNot: ${n}`).join("");
      return `Yazıldı: ${r.output}\n${r.size}, ${r.seconds.toFixed(1)} sn${r.cuts ? `, ${r.cuts} kesim` : ""}${used}${dubbed}${notes}${more}`;
    }),
);

server.registerTool(
  "retime_words",
  {
    title: "Kelime zamanını düzelt",
    description:
      "Bir satırın ya da tek kelimenin zamanını değiştirir (get_transcript lines ya da find_text'teki [ilk..son] aralığıyla). Ya yeni start ve end saniyesi verilir, ya da shift ile olduğu gibi öne (−) ya da geriye (+) kaydırılır. Zamanlar önceki ve sonraki kelimeleri geçmez; bitişik kelime aradaki sınırla birlikte uzar ya da kısalır.",
    inputSchema: {
      id: z.string(),
      first: z.number().int().min(0),
      count: z.number().int().min(1).default(1),
      start: z.number().min(0).optional().describe("Yeni başlangıç, saniye"),
      end: z.number().min(0).optional().describe("Yeni bitiş, saniye"),
      shift: z.number().optional().describe("Süresini değiştirmeden kaydır, saniye"),
    },
  },
  async (a) => {
    try {
      const t = store.load(a.id);
      if (a.first + a.count > t.words.length) throw new Error(`Aralık ${a.first}..${a.first + a.count - 1} dışarıda (0..${t.words.length - 1}).`);
      if (a.shift === undefined && a.start === undefined && a.end === undefined) throw new Error("start, end ya da shift verilmeli.");
      const w0 = t.words[a.first];
      const w1 = t.words[a.first + a.count - 1];
      store.checkpoint(t, `retime_words ${a.first}..${a.first + a.count - 1}`);
      t.words = a.shift !== undefined ? shiftSpan(t.words, a.first, a.count, a.shift) : retime(t.words, a.first, a.count, a.start ?? w0.start, a.end ?? w1.end);
      store.save(t);
      const n0 = t.words[a.first];
      const n1 = t.words[a.first + a.count - 1];
      return text(`${w0.start.toFixed(2)}–${w1.end.toFixed(2)} → ${n0.start.toFixed(2)}–${n1.end.toFixed(2)} sn`);
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "edit_translation",
  {
    title: "Çeviriyi düzelt",
    description: "get_transcript'in language=translation çıktısındaki [ilk..son] aralığındaki çeviri kelimelerini verilen metinle değiştirir. Boş metin siler.",
    inputSchema: { id: z.string(), first: z.number().int().min(0), count: z.number().int().min(1), text: z.string() },
  },
  async (a) => {
    try {
      const t = store.load(a.id);
      if (!t.translation) throw new Error("Bu transkriptin çevirisi yok.");
      if (a.first >= t.translation.words.length) throw new Error(`Kelime sırası ${a.first} aralık dışında (0..${t.translation.words.length - 1}).`);
      store.checkpoint(t, `edit_translation ${a.first}..${a.first + a.count - 1}`);
      t.translation = { ...t.translation, words: replaceRange(t.translation.words, a.first, a.count, a.text) };
      store.save(t);
      return text(`Güncellendi. ${summary(t)}`);
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "assign_speaker",
  {
    title: "Konuşmacı ata",
    description:
      "Bir satırı ya da zaman aralığını bir konuşmacıya verir (kelime aralığı first+count ya da start+end saniye). speaker mevcut bir konuşmacının sırasıdır; yeni bir kişi için konuşmacı sayısına eşit bir sıra verilir (name ile adlanır). tell_speakers'ın yanlış böldüğü yeri düzeltir; konuşmacı hiç ayrılmamışsa elle de başlanabilir.",
    inputSchema: {
      id: z.string(),
      speaker: z.number().int().min(0),
      first: z.number().int().min(0).optional(),
      count: z.number().int().min(1).default(1),
      start: z.number().min(0).optional(),
      end: z.number().min(0).optional(),
      name: z.string().optional().describe("Yeni konuşmacının adı"),
    },
  },
  async (a) => {
    try {
      const t = store.load(a.id);
      let start = a.start;
      let end = a.end;
      if (a.first !== undefined) {
        if (a.first + a.count > t.words.length) throw new Error(`Aralık ${a.first}..${a.first + a.count - 1} dışarıda (0..${t.words.length - 1}).`);
        start = t.words[a.first].start;
        end = t.words[a.first + a.count - 1].end;
      }
      if (start === undefined || end === undefined || end <= start) throw new Error("Bir kelime aralığı (first, count) ya da zaman aralığı (start, end) verilmeli.");
      const sp = t.speakers ?? { names: [], turns: [] };
      if (a.speaker > sp.names.length) throw new Error(`Konuşmacı ${a.speaker} yok; yeni kişi için ${sp.names.length} verilmeli (0..${sp.names.length - 1} mevcut).`);
      store.checkpoint(t, `assign_speaker ${a.speaker} ${start.toFixed(1)}–${end.toFixed(1)}`);
      let next = assign(sp, start, end, a.speaker);
      // Unused speakers are dropped and the rest renumbered, so the new one is found by the turn it was given.
      const given = next.turns.find((x) => x.start <= start! + 1e-6 && x.end >= end! - 1e-6)?.speaker;
      if (a.name && given !== undefined) next = rename(next, given, a.name);
      t.speakers = next;
      store.save(t);
      return text(`Konuşmacılar: ${next.names.join(", ")}`);
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "merge_speakers",
  {
    title: "Konuşmacıları birleştir",
    description: "Aynı kişi iki kez çıktıysa birini ötekine katar: from'un bütün konuşmaları into'nun olur, from silinir ve sonrakiler yeniden numaralanır.",
    inputSchema: { id: z.string(), from: z.number().int().min(0), into: z.number().int().min(0) },
  },
  async (a) => {
    try {
      const t = store.load(a.id);
      if (!t.speakers) throw new Error("Önce tell_speakers çalıştırılmalı.");
      const n = t.speakers.names.length;
      if (a.from >= n || a.into >= n || a.from === a.into) throw new Error(`Geçersiz konuşmacılar: 0..${n - 1} arasında, birbirinden farklı iki sıra verilmeli.`);
      store.checkpoint(t, `merge_speakers ${a.from} → ${a.into}`);
      t.speakers = merge(t.speakers, a.from, a.into);
      store.save(t);
      return text(`Konuşmacılar: ${t.speakers.names.join(", ")}`);
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "apply_numbers",
  {
    title: "Sayı yazımı",
    description: "Transkriptteki sayıları seçilen biçimde yazar: rule (1–9 yazıyla, 10 ve üstü rakamla, TDK'ya göre), all (hepsi rakamla) ya da keep (dokunma). Metni düzelttikten sonra yeniden uygulamak için. Yalnızca Türkçe transkriptte çalışır.",
    inputSchema: { id: z.string(), mode: z.enum(["rule", "all", "keep"]).default("rule") },
  },
  async (a) => {
    try {
      const t = store.load(a.id);
      if (t.lang !== "tr") throw new Error("Sayı kuralları Türkçe transkript içindir.");
      store.checkpoint(t, `apply_numbers ${a.mode}`);
      const next = writeNumbers(t.words, a.mode);
      t.words = next;
      store.save(t);
      return text(`${a.mode}: ${next.length} kelime.`);
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "punctuate",
  {
    title: "Noktalama ve büyük harf",
    description: "Transkripti yeniden noktalar ve büyük harfle yazar (Seda'nın formatter modeliyle), sonra sayıları yazar. Metni elle düzelttikten sonra ya da noktalamasız kalmış bir transkriptte kullanılır. Yalnızca Türkçe transkriptte çalışır.",
    inputSchema: { id: z.string(), numbers: z.enum(["rule", "all", "keep"]).default("rule"), background: Background },
  },
  (a, extra) =>
    heavy("punctuate", extra as unknown as Extra, a.background, async (report) => {
      const t = store.load(a.id);
      if (t.lang !== "tr") throw new Error("Noktalama modeli Türkçe içindir.");
      report(0, "noktalama modeli yükleniyor");
      const written = await punctuate(t.words, report);
      store.checkpoint(t, "punctuate");
      t.words = writeNumbers(written, a.numbers);
      store.save(t);
      return `Noktalandı. ${summary(t)}\n${render(t, "lines", "transcript").slice(0, 3000)}`;
    }),
);

server.registerTool(
  "undo",
  {
    title: "Geri al",
    description: "Transkriptteki son düzenlemeyi (ya da son steps düzenlemeyi) geri alır: kelimeler, zamanlar, çeviri ve konuşmacılar önceki hâline döner. Son 20 düzenleme saklanır.",
    inputSchema: { id: z.string(), steps: z.number().int().min(1).max(20).default(1) },
  },
  async (a) => {
    try {
      const labels = store.undo(a.id, a.steps);
      return text(`Geri alındı: ${labels.join(", ")}\n${summary(store.load(a.id))}`);
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "history",
  {
    title: "Düzenleme geçmişi",
    description: "Geri alınabilecek düzenlemeleri, en yenisi önce, listeler.",
    inputSchema: { id: z.string() },
  },
  async (a) => {
    const h = store.history(a.id);
    return text(h.length ? h.map((x, i) => `${i + 1}. ${x.label}  (${x.at.slice(0, 19).replace("T", " ")})`).join("\n") : "Geri alınacak bir düzenleme yok.");
  },
);

const VoiceShape = {
  voice: z.enum(["ema", "mini", "ahenk", "supertonic"]).default("ema").describe("Ses modeli: ema (EMA Lightning, varsayılan), mini (Antalia Mini), ahenk (Ahenk Cep: rakamları en iyi okuyan, biraz yavaş), supertonic (Türkçe ve İngilizce, 10 ses). İngilizce okuma her zaman Supertonic'tir."),
  style: z.enum(["M1", "M2", "M3", "M4", "M5", "F1", "F2", "F3", "F4", "F5"]).default("M3").describe("Yalnızca Supertonic'in sesi: M erkek, F kadın"),
  pitch: z.number().min(-4).max(4).default(0).describe("Ses tonu, yarım ton adımlarla; negatif daha kalın. Supertonic'te yok"),
  seed: z.number().int().min(0).default(0).describe("Aynı sesi farklı bir vurguyla okutur"),
};

/** The voice a tool asked for, moved to Supertonic where the language needs it. */
function voiceOf(a: { voice: VoiceModel; style: string; pitch: number; seed: number }, lang: VoiceLang) {
  const asked: Voice = { lang, model: a.voice, style: a.style, pitch: a.pitch, seed: a.seed };
  const voice = fitVoice(asked);
  const note = voice.model !== asked.model ? `\nNot: ${lang === "en" ? "İngilizceyi" : "Bu dili"} yalnızca Supertonic okur; ses Supertonic'e çevrildi.` : "";
  return { voice, note };
}

server.registerTool(
  "dub",
  {
    title: "Seslendir",
    description:
      "Transkripti (ya da çevirisini) yapay bir sesle okuyup her satırı kendi zamanında yerleştirir. Yerine sığmayan satır 1,35 kata kadar hızlı okunur, taşan son satırlar öncekilerin sessizliğine kayar. Sonuç kaydedilir: render_captions seslendirmeyi videoya karıştırır, altyazıyı sesin zamanına uydurur; export_dub WAV olarak verir. Türkçe videoya İngilizce voice-over için önce translate, sonra language=translation. Supertonic dışındaki sesler hızlıdır; Supertonic gerçek zamanın birkaç katı hızında çalışır.",
    inputSchema: { id: z.string(), language: Language, ...VoiceShape, background: Background },
  },
  (a, extra) =>
    heavy("dub", extra as unknown as Extra, a.background, async (report) => {
      const t = store.load(a.id);
      const tr = a.language === "translation";
      if (tr && !t.translation) throw new Error("Bu transkriptin çevirisi yok; önce translate çalıştırılmalı.");
      const words = tr ? t.translation!.words : t.words;
      const lang = tr ? t.translation!.lang : t.lang;
      if (!words.length) throw new Error("Okunacak metin yok.");
      const { voice, note } = voiceOf(a, lang);
      const lines = dubLines(words, dubBySentence(lang, t.lang));
      const end = t.range?.end ?? t.duration;
      const started = Date.now();
      const { clips, overflow } = await placeLines(lines, t.duration, end, voice, report);
      const meta: DubMeta = {
        voice,
        language: a.language,
        key: dubKey(words),
        duration: t.duration,
        end,
        lines,
        clips: clips.map((c) => ({ line: c.line, start: c.start, seconds: c.audio.length / 48000 })),
        overflow,
        elapsed: (Date.now() - started) / 1000,
      };
      saveDub(t.id, meta, clips);
      const spoken = meta.clips.reduce((n, c) => n + c.seconds, 0);
      const warn = overflow ? `\nUyarı: ${overflow.start.toFixed(1)}. saniyedeki son cümle sığmıyor, ${overflow.seconds.toFixed(1)} sn taşıyor; cümle kısaltılabilir.` : "";
      return `Seslendirildi: ${meta.clips.length}/${lines.length} satır, ${spoken.toFixed(1)} sn ses (${VOICE_INFO[voice.model].name}${voice.model === "supertonic" ? ` ${voice.style}` : ""}), ${meta.elapsed.toFixed(1)} sn sürdü.${warn}${note}`;
    }),
);

server.registerTool(
  "export_dub",
  {
    title: "Seslendirmeyi WAV yaz",
    description: "dub ile yapılmış seslendirmeyi (orijinal ses karışmadan) 16 bit, 48 kHz, mono WAV dosyası olarak yazar.",
    inputSchema: { id: z.string(), output: z.string().describe("Yazılacak .wav dosyasının yolu") },
  },
  async (a) => {
    try {
      store.load(a.id);
      if (!loadDub(a.id) || !existsSync(dubWavPath(a.id))) throw new Error("Bu transkriptin seslendirmesi yok; önce dub çalıştırılmalı.");
      const out = abs(a.output);
      mkdirSync(dirname(out), { recursive: true });
      copyFileSync(dubWavPath(a.id), out);
      return text(`Yazıldı: ${out}`);
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "preview_voice",
  {
    title: "Sesi dinle",
    description: "Bir sesin kısa bir örneğini WAV dosyası olarak yazar; seslendirmeden önce ses, ton ve seed seçmek için. Metin verilmezse örnek bir cümle okunur.",
    inputSchema: {
      output: z.string().describe("Yazılacak .wav dosyasının yolu"),
      text: z.string().optional(),
      lang: z.enum(["tr", "en"]).default("tr"),
      ...VoiceShape,
      background: Background,
    },
  },
  (a, extra) =>
    heavy("preview_voice", extra as unknown as Extra, a.background, async (report) => {
      const { voice, note } = voiceOf(a, a.lang);
      const sample = a.text?.trim() || (a.lang === "en" ? "Hello, the dub will be read in this voice." : "Merhaba, seslendirme bu sesle yapılacak.");
      report(0, "ses yükleniyor");
      const audio = await speak(await speaker(voice.model), sample, voice);
      const out = abs(a.output);
      writeDubWav(out, [{ line: 0, start: 0, audio }], 0);
      return `Yazıldı: ${out} (${(audio.length / 48000).toFixed(1)} sn)${note}`;
    }),
);

server.registerTool(
  "speak_text",
  {
    title: "Metin seslendir",
    description:
      "Dosya olmadan, yazılan ya da yapıştırılan metni yapay sesle okur. Her cümle ya da satır ayrı okunur; kelimeler sesin zamanıyla bir transkripte yerleşir (ses WAV dosyası o transkriptin medyası olur). Çıkan transkriptle render_captions koyu zeminli, seslendirmeli altyazılı bir video yapar. output verilirse WAV ayrıca oraya yazılır.",
    inputSchema: {
      text: z.string().min(1),
      lang: z.enum(["tr", "en"]).default("tr"),
      name: z.string().optional(),
      output: z.string().optional().describe("WAV'ın ayrıca yazılacağı yol"),
      ...VoiceShape,
      background: Background,
    },
  },
  (a, extra) =>
    heavy("speak_text", extra as unknown as Extra, a.background, async (report) => {
      const { voice, note } = voiceOf(a, a.lang);
      const words = wordsFromText(a.text);
      if (!words.length) throw new Error("Okunacak metin yok.");
      const lines = dubLines(words, dubBySentence(a.lang, a.lang));
      // No media clock: lines follow one another.
      const { clips } = await placeLines(lines, 0, 0, voice, report);
      const timed = timeToDub(words, lines, clips.map((c) => ({ line: c.line, start: c.start, seconds: c.audio.length / 48000 })));
      const last = clips.at(-1);
      const duration = last ? last.start + last.audio.length / 48000 : 0;
      const t = store.create({ name: a.name ?? a.text.trim().slice(0, 40), duration, lang: a.lang, words: timed, model: VOICE_INFO[voice.model].name });
      const wav = join(dirname(dubWavPath(t.id)), `${t.id}.speech.wav`);
      writeDubWav(wav, clips, duration);
      t.source = wav;
      store.save(t);
      if (a.output) {
        const out = abs(a.output);
        mkdirSync(dirname(out), { recursive: true });
        copyFileSync(wav, out);
      }
      return `${summary(t)}\n${duration.toFixed(1)} sn ses: ${wav}${a.output ? `\nAyrıca yazıldı: ${abs(a.output)}` : ""}${note}`;
    }),
);

server.registerTool(
  "job_status",
  {
    title: "İş durumu",
    description: "Arka planda başlatılan bir işin durumunu ve bittiyse sonucunu verir.",
    inputSchema: { job_id: z.string() },
  },
  async (a) => {
    const j = jobs.get(a.job_id);
    return j ? text(jobs.describe(j)) : fail(`"${a.job_id}" kimlikli iş yok (sunucu yeniden başlamış olabilir).`);
  },
);

await server.connect(new StdioServerTransport());
