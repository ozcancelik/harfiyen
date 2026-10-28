// Harfiyen as an MCP server over stdio. Audio and video stay on this computer, as in the web app.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, dirname, extname, resolve } from "node:path";
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
import { labelWords, rename } from "../../src/lib/speakers";
import { parseSubtitles } from "../../src/lib/subtitles";
import { shiftAll } from "../../src/lib/timing";
import { renderCaptions, DEFAULT_CAPTIONS } from "./captions";
import * as jobs from "./jobs";
import { BUNDLED } from "./fonts";
import { installed, SPEECH_MODELS } from "./models";
import { planCuts, tellSpeakers, transcribe, translate } from "./pipeline";
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

const summary = (t: Transcript) =>
  `${t.id}  ${t.name}  ${t.words.length} kelime  ${clock(t.duration)}  ${t.lang}${t.model ? `  ${t.model}` : ""}` +
  `${t.translation ? "  çeviri var" : ""}${t.speakers ? `  ${t.speakers.names.length} konuşmacı` : ""}`;

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
    return text(JSON.stringify({ ffmpeg: ok, ...m, fonts: BUNDLED.map((f) => f.family), transcripts: store.list().length }, null, 2));
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
      const t = store.create({ name: basename(a.path, extname(a.path)), source, duration, lang: a.lang, words });
      return text(summary(t));
    } catch (e) {
      return fail(e);
    }
  },
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
      return text(trimmed(render(store.load(a.id), a.format, a.language), a.max_chars));
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
    description: "Yanlış tanınan bir kelimeyi ya da ismi bütün transkriptte düzeltir. Büyük/küçük harfe bakmaz.",
    inputSchema: {
      id: z.string(),
      query: z.string(),
      replacement: z.string(),
      whole_word: z.boolean().default(false),
      dry_run: z.boolean().default(false).describe("true: yalnızca kaç eşleşme olduğunu söyler"),
    },
  },
  async (a) => {
    try {
      const t = store.load(a.id);
      const matches = findMatches(t.words, a.query, a.whole_word, t.lang);
      if (!a.dry_run && matches.length) {
        t.words = replaceMatches(t.words, matches, a.replacement, t.lang);
        store.save(t);
      }
      return text(`${matches.length} eşleşme${a.dry_run || !matches.length ? "" : " değiştirildi"}.`);
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

server.registerTool(
  "render_captions",
  {
    title: "Altyazılı video",
    description:
      "Altyazıyı videoya yazar (ffmpeg + libass). Stiller: klasik (koyu kutu), sade (gölgeli), karaoke (söylenen kelime renkle dolar), akis (kelimeler söylendikçe yerinde belirir), odak (bulanıktan netleşir), vurgu (söylenen kelime renkli işaretleyici), pop (ortada 3 iri zıplayan kelime), netles (ortada tek iri kelime bulanıktan netleşir), tek-kelime (ortada tek iri kelime). İstenirse boşlukları keser ve 9:16, 4:5, 1:1 ya da 16:9'a kırpar. Cam stili, aura ve kinetik tipografi yok; web uygulamasının dokuz stili var. Yalnızca ses dosyasında koyu bir zemin kullanılır.",
    inputSchema: {
      id: z.string(),
      output: z.string().describe("Yazılacak .mp4 dosyasının yolu"),
      style: z.enum(["klasik", "sade", "karaoke", "akis", "odak", "vurgu", "pop", "netles", "tek-kelime"]).default(DEFAULT_CAPTIONS.style),
      emphasis: z.boolean().default(false).describe("Sesle vurgula: çevresinden yüksek sesle söylenen kelimeler büyük (ve çoğu stilde vurgu renginde) yazılır"),
      language: Language,
      font: z
        .string()
        .default(DEFAULT_CAPTIONS.font)
        .describe(`Paketli yazı tiplerinden biri (${BUNDLED.map((f) => f.family).join(", ")}) ya da sistemde kurulu bir yazı tipi adı`),
      font_file: z.string().optional().describe("Kendi yazı tipin (TTF ya da OTF); verilirse font yerine bu kullanılır"),
      bold: z.boolean().optional().describe("Kalın; verilmezse yazı tipine göre (Anton, Bangers gibi tek kalınlıklılarda kapalı)"),
      uppercase: z.boolean().optional().describe("Türkçe kurala uygun büyük harf (i → İ); verilmezse yazı tipine göre (Luckiest Guy, Bangers, Bebas Neue yalnızca büyük harf bildiği için açık)"),
      size: z.number().min(0.02).max(0.15).default(DEFAULT_CAPTIONS.size).describe("Yazı boyu, kare yüksekliğinin payı"),
      position: z.enum(["alt", "orta", "ust"]).default(DEFAULT_CAPTIONS.position),
      color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default(DEFAULT_CAPTIONS.color),
      accent: z.string().regex(/^#[0-9a-fA-F]{6}$/).default(DEFAULT_CAPTIONS.accent).describe("Vurgu rengi (karaoke dolgusu)"),
      aspect: z.enum(["9:16", "4:5", "1:1", "16:9"]).optional().describe("Kadraj; verilmezse dosyanınki"),
      fit: z.enum(["fill", "fit"]).default("fill").describe("fill: kareyi kapla, taşanı kes; fit: tamamı görünsün, boşluk siyah"),
      jump_cut: z.boolean().default(false).describe("Sessizlikleri ve dolgu seslerini videodan çıkar"),
      ...JumpCutShape,
      codec: z.enum(["h264", "hevc"]).default("h264"),
      crf: z.number().int().min(10).max(35).default(20).describe("Kalite; düşük daha iyi"),
      width: z.number().int().min(240).max(3840).optional().describe("Çıkış genişliği, piksel"),
      background: Background,
    },
  },
  (a, extra) =>
    heavy("render_captions", extra as unknown as Extra, a.background, async (report) => {
      const t = store.load(a.id);
      const r = await renderCaptions(
        t,
        {
          output: abs(a.output),
          captions: { style: a.style, font: a.font, bold: a.bold, uppercase: a.uppercase, size: a.size, position: a.position, color: a.color, accent: a.accent },
          emphasis: a.emphasis,
          fontFile: a.font_file ? abs(a.font_file) : undefined,
          aspect: a.aspect,
          fit: a.fit,
          jumpCut: a.jump_cut ? { gap: a.gap, pad: a.pad, fillers: a.fillers } : undefined,
          language: a.language,
          codec: a.codec,
          crf: a.crf,
          width: a.width,
        },
        report,
      );
      return `Yazıldı: ${r.output}\n${r.size}, ${r.seconds.toFixed(1)} sn${r.cuts ? `, ${r.cuts} kesim` : ""}`;
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
