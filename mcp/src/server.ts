// Harfiyen as an MCP server over stdio. Audio and video stay on this computer, as in the web app.

import { copyFileSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { Word } from "../../src/engine";
import { alignText } from "../../src/lib/align";
import { buildCues, importedCues, SUBTITLE_RULES } from "../../src/lib/cues";
import {
  DEFAULT_JUMP_CUT,
  findCuts,
  isFiller,
  keptLength,
  keptParts,
  restoreAllCuts,
  toggleGapCut,
  toggleWordsCut,
  wordGap,
  wordsThrough,
} from "../../src/lib/cuts";
import { replaceRange } from "../../src/lib/edit";
import { toJson, toSrt, toText, toVtt } from "../../src/lib/exporters";
import { findMatches, replaceMatches } from "../../src/lib/find";
import { clock } from "../../src/lib/format";
import { assign, labelWords, merge, rename } from "../../src/lib/speakers";
import { parseSubtitles } from "../../src/lib/subtitles";
import { retime, shiftAll, shiftSpan } from "../../src/lib/timing";
import { wordsIn } from "../../src/lib/trim";
import { writeNumbers } from "../../src/lib/numbers";
import { sourceKey } from "../../src/lib/translation";
import { renderCaptions, DEFAULT_CAPTIONS, type RenderOptions } from "./captions";
import { findChrome, missingChrome } from "./chrome";
import { renderChrome, type ChromeStyle } from "./chromeCaptions";
import * as jobs from "./jobs";
import { fontIdOf, lookOf, saveLookToApp } from "./appstyle";
import { dubBySentence, dubKey, dubLines, dubWavPath, loadDub, placeLines, removeDub, saveDub, speak, timeToDub, wordsFromText, writeDubWav, type DubMeta } from "./dub";
import { BUNDLED } from "./fonts";
import { download, plan } from "./download";
import { installed, isReady, SPEECH_MODELS, UNIT_IDS, UNITS } from "./models";
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

type Extra = { _meta?: { progressToken?: string | number }; signal?: AbortSignal; sendNotification: (n: never) => Promise<void> };

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
  if (background) return text(`İş başlatıldı: ${job.id}. İlerlemesi job_status ile sorulabilir, cancel_job ile durdurulabilir.`);
  const onAbort = () => jobs.cancel(job.id);
  extra.signal?.addEventListener("abort", onAbort, { once: true });
  const finished = await done.finally(() => extra.signal?.removeEventListener("abort", onAbort));
  if (finished.state === "cancelled") return fail(jobs.CANCELLED);
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

const summary = (t: Transcript) => {
  const inSpan = t.range ? wordsIn(t.words, t.range).length : t.words.length;
  const words = t.range && inSpan !== t.words.length ? `${inSpan}/${t.words.length} kelime` : `${t.words.length} kelime`;
  const cutCount = t.words.filter((w) => w.cut).length;
  const gapCount = t.words.filter((w) => w.cutGap).length;
  const cuts = cutCount || gapCount ? ` (${[cutCount && `${cutCount} kelime kesik`, gapCount && `${gapCount} boşluk kısaltıldı`].filter(Boolean).join(", ")})` : "";
  const span = t.range ? `  ${clock(t.range.start)}–${clock(t.range.end)}/${clock(t.duration)}` : `  ${clock(t.duration)}`;
  return (
    `${t.id}  ${t.name}  ${words}${cuts}${span}  ${t.lang}${t.model ? `  ${t.model}` : ""}` +
    `${t.translation ? (stale(t) ? "  çeviri eski" : "  çeviri var") : ""}${t.speakers ? `  ${t.speakers.names.length} konuşmacı` : ""}`
  );
};

function render(t: Transcript, format: "lines" | "text" | "srt" | "vtt" | "json", language: "transcript" | "translation", full = false): string {
  const all = view(t, language);
  const range = full ? null : (t.range ?? null);
  const names = t.speakers?.names;
  if (format === "lines") {
    // Word indices stay the whole transcript's so edit_words, cut_words and retime_words can address them.
    const spanStart = range?.start ?? 0;
    const cues = importedCues(all) ?? buildCues(all, SUBTITLE_RULES);
    return cues
      .filter((c) => !range || (c.end > range.start && c.start < range.end))
      .map((c) => {
        const textParts = c.words.map((w, i) => {
          const idx = c.first + i;
          const g = wordGap(all, idx, spanStart);
          const gapNote =
            g >= 0.6 || w.cutGap !== undefined
              ? `${w.cutGap ? `[~⏸ ${g.toFixed(1)}s~] ` : `[⏸ ${g.toFixed(1)}s] `}`
              : "";
          const wordText = w.cut ? `~${w.text}~` : w.text;
          return `${gapNote}${wordText}`;
        });
        return `[${c.first}..${c.first + c.words.length - 1}] ${clock(c.start)} ${textParts.join(" ")}`;
      })
      .join("\n");
  }
  const span = range ?? { start: 0, end: t.duration || (all.at(-1)?.end ?? 0) };
  const hasCuts = !full && t.words.some((w) => w.cut === true || w.cutGap === true);
  const cuts = hasCuts ? findCuts(t.words, span, { ...DEFAULT_JUMP_CUT, on: false }, new Float32Array(0)) : [];
  const words = cuts.length ? wordsThrough(all, span, cuts) : wordsIn(all, range, true);
  const duration = cuts.length ? keptLength(keptParts(span, cuts)) : range ? range.end - range.start : t.duration;
  const cues = () => importedCues(words) ?? buildCues(words, SUBTITLE_RULES);
  switch (format) {
    case "srt":
      return toSrt(cues(), names);
    case "vtt":
      return toVtt(cues(), names);
    case "text":
      return toText(words, names);
    case "json":
      return toJson(words, { id: t.id, name: t.name, lang: language === "translation" ? t.translation?.lang : t.lang, duration }, names);
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
    description: "Hangi modellerin diskte olduğunu, indirilebilecek eksik modelleri (boyutlarıyla), ffmpeg'in kurulu olup olmadığını ve kayıtlı transkriptleri gösterir.",
    inputSchema: {},
  },
  async () => {
    const ok = await probe("/dev/null").then(() => true, (e: Error) => !/çalıştırılamadı/.test(e.message));
    const m = installed();
    return text(
      JSON.stringify(
        {
          ffmpeg: ok,
          chrome: findChrome(),
          ...m,
          voices: Object.fromEntries((Object.keys(VOICE_INFO) as VoiceModel[]).map((v) => [v, { ...VOICE_INFO[v], installed: isReady(`voice-${v}`) }])),
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
  "download_models",
  {
    title: "Modelleri indir",
    description:
      "Eksik modelleri model sunucusundan bu bilgisayara indirir (status eksik olanları boyutlarıyla listeler). İndirme yüzlerce MB olabilir; " +
      "KULLANICI KABUL ETMEDEN indirme. İstemci kullanıcıya soru sorabiliyorsa araç onayı kendisi sorar; sormuyorsa önce kullanıcıya sor, kabul ederse onay: true ile çağır. " +
      "onay verilmeden çağrılırsa yalnızca ne indirileceğini ve boyutunu söyler.",
    inputSchema: {
      models: z.array(z.enum(UNIT_IDS)).min(1).describe("İndirilecek modeller: " + Object.values(UNITS).map((u) => `${u.id} (${u.name}, ~${u.mb} MB)`).join("; ")),
      onay: z.boolean().optional().describe("Kullanıcı bu indirmeyi açıkça kabul ettiyse true"),
      background: Background,
    },
  },
  async (a, extra) => {
    try {
      const p = await plan(a.models);
      if (!p.units.length) return text("İstenen modellerin hepsi zaten kurulu.");
      const mb = Math.ceil(p.bytes / 1e6);
      const list = p.units.map((u) => `- ${u.name} (~${u.mb} MB)`).join("\n");
      const summary = `${list}\nToplam yaklaşık ${mb} MB, şuraya indirilir: ${p.root}`;
      let agreed = false;
      if (server.server.getClientCapabilities()?.elicitation) {
        // The client asks the user itself, so the answer does not pass through the model.
        try {
          const r = await server.server.elicitInput({
            message: `Şu modeller indirilsin mi?\n${summary}`,
            requestedSchema: { type: "object", properties: { onay: { type: "boolean", title: "İndir", description: `${mb} MB indirilecek` } }, required: ["onay"] },
          });
          if (r.action !== "accept" || r.content?.onay !== true) return text("Kullanıcı indirmeyi kabul etmedi; hiçbir şey indirilmedi.");
          agreed = true;
        } catch {
          // The client could not show the question; fall back to asking through the conversation.
        }
      }
      if (!agreed && a.onay !== true) {
        return text(`İndirme için kullanıcının onayı gerekiyor:\n${summary}\nKullanıcıya sor; kabul ederse bu aracı aynı modellerle onay: true vererek yeniden çağır. Hiçbir şey indirilmedi.`);
      }
      return await heavy("download_models", extra, a.background, async (report) => {
        await download(p, report);
        return `İndirildi:\n${list}`;
      });
    } catch (e) {
      return fail(e);
    }
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
  "set_range",
  {
    title: "Bölüm seç",
    description:
      "Transkriptin üzerinde çalışılacak ve dışa aktarılacak bölümünü (kesitini) belirler; yeniden yazıya döküm yapmaz. Saniye olarak (start, end) ya da get_transcript lines / find_text çıktısındaki kelime sırasıyla (first ve last ya da count) verilir. render_captions, dub, plan_jump_cut, tell_speakers ve export_transcript yalnızca bu bölümü işler; clear=true bütün dosyaya döner. undo ile geri alınabilir.",
    inputSchema: {
      id: z.string(),
      start: z.number().min(0).optional().describe("Başlangıç, saniye"),
      end: z.number().min(0).optional().describe("Bitiş, saniye"),
      first: z.number().int().min(0).optional().describe("Başlangıç kelimesinin sırası (0'dan)"),
      last: z.number().int().min(0).optional().describe("Bitiş kelimesinin sırası (dahil)"),
      count: z.number().int().min(1).optional().describe("first'ten itibaren kaç kelime (last yerine)"),
      pad: z.number().min(0).default(0.15).describe("Kelime sırası (first) verildiğinde ilk kelimeden önce ve son kelimeden sonra bırakılacak pay, saniye"),
      clear: z.boolean().default(false).describe("true: bölüm seçimini kaldırır, bütün dosyaya döner"),
    },
  },
  async (a) => {
    try {
      const t = store.load(a.id);
      const max = t.duration || (t.words.at(-1)?.end ?? 0);
      if (a.clear) {
        if (!t.range) return text(`Zaten bütün dosya seçili (${clock(max)}).`);
        store.checkpoint(t, "set_range (tümü)");
        t.range = undefined;
        store.save(t);
        return text(`Bölüm seçimi kaldırıldı.\n${summary(t)}`);
      }
      let start = a.start;
      let end = a.end;
      if (a.first !== undefined) {
        if (!t.words.length) throw new Error("Transkriptte kelime yok.");
        const last = a.last ?? (a.count !== undefined ? a.first + a.count - 1 : a.first);
        if (a.first >= t.words.length || last >= t.words.length || last < a.first) {
          throw new Error(`Kelime aralığı ${a.first}..${last} geçersiz (0..${t.words.length - 1}).`);
        }
        start = start ?? Math.max(0, t.words[a.first].start - a.pad);
        end = end ?? Math.min(max, t.words[last].end + a.pad);
      }
      if (start === undefined && end === undefined) {
        throw new Error("start, end, first ya da clear=true verilmeli.");
      }
      const s = Math.max(0, start ?? t.range?.start ?? 0);
      const e = Math.min(max, end ?? t.range?.end ?? max);
      if (e <= s) throw new Error(`Bitiş (${e.toFixed(2)} sn) başlangıçtan (${s.toFixed(2)} sn) büyük olmalı.`);
      const whole = s <= 0.01 && e >= max - 0.01;
      const next = whole ? undefined : { start: Math.round(s * 1000) / 1000, end: Math.round(e * 1000) / 1000 };
      store.checkpoint(t, next ? `set_range ${clock(next.start)}–${clock(next.end)}` : "set_range (tümü)");
      t.range = next;
      store.save(t);
      const lines = render(t, "lines", "transcript");
      return text(`${summary(t)}${lines ? `\n\n${trimmed(lines, 4000)}` : ""}`);
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
  "rename_transcript",
  {
    title: "Transkripti yeniden adlandır",
    description: "Transkriptin adını değiştirir (.harfiyen projesinde ve list_transcripts çıktısında görünür).",
    inputSchema: { id: z.string(), name: z.string().min(1) },
  },
  async (a) => {
    try {
      const t = store.load(a.id);
      t.name = a.name.trim();
      store.save(t);
      return text(summary(t));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "delete_transcript",
  {
    title: "Transkripti sil",
    description: "Kayıtlı bir transkripti, düzenleme geçmişini ve varsa seslendirme (dub) ses dosyasını diskten siler. Orijinal medya dosyasına dokunulmaz.",
    inputSchema: { id: z.string() },
  },
  async (a) => {
    try {
      const t = store.remove(a.id);
      removeDub(t.id);
      return text(`Silindi: ${t.id}  ${t.name}`);
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "get_transcript",
  {
    title: "Transkripti oku",
    description:
      "Transkripti okur. lines: her satırın kelime aralığı ve zamanıyla (edit_words ve set_range bu aralıklarla çalışır); text, srt, vtt, json de olur. Bölüm seçiliyse (set_range) yalnızca o bölümü verir, full=true bütün transkripti verir. language=translation çeviriyi verir.",
    inputSchema: {
      id: z.string(),
      format: Format.default("lines"),
      language: Language,
      full: z.boolean().default(false).describe("true: bölüm seçimi olsa bile bütün transkripti gösterir"),
      max_chars: z.number().int().positive().default(20000),
    },
  },
  async (a) => {
    try {
      const t = store.load(a.id);
      const warn = a.language === "translation" && stale(t) ? "Not: Transkript çeviriden sonra değişti; çeviri eski. translate ile yenilenir.\n\n" : "";
      return text(warn + trimmed(render(t, a.format, a.language, a.full), a.max_chars));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "export_transcript",
  {
    title: "Dışa aktar",
    description: "Transkripti SRT, VTT, düz metin ya da kelime zamanlı JSON olarak dosyaya yazar. Bölüm seçiliyse (set_range) yalnızca o bölümü 0:00'dan başlayarak yazar; full=true bütün transkripti yazar.",
    inputSchema: {
      id: z.string(),
      format: z.enum(["srt", "vtt", "text", "json"]),
      language: Language,
      full: z.boolean().default(false).describe("true: bölüm seçimi olsa bile bütün transkripti yazar"),
      output: z.string().describe("Yazılacak dosyanın yolu"),
    },
  },
  async (a) => {
    try {
      const t = store.load(a.id);
      const out = abs(a.output);
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, render(t, a.format, a.language, a.full));
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
      "get_transcript lines çıktısındaki [ilk..son] aralığındaki kelimeleri verilen metinle değiştirir; değişmeyen kelimelerin zamanı korunur. Yazım hatası düzeltmek içindir; videodan kelime, cümle veya bölüm kesmek için cut_words kullanılmalı.",
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

const CutRangeSchema = z.object({
  first: z.number().int().min(0).optional().describe("Başlangıç kelimesinin sırası (0'dan)"),
  last: z.number().int().min(0).optional().describe("Bitiş kelimesinin sırası (dahil)"),
  count: z.number().int().min(1).optional().describe("first'ten itibaren kaç kelime (last yerine)"),
  start: z.number().min(0).optional().describe("Başlangıç zamanı, saniye (kelime sırası yerine)"),
  end: z.number().min(0).optional().describe("Bitiş zamanı, saniye"),
});

server.registerTool(
  "cut_words",
  {
    title: "Metinden kurgu (kelime, bölüm, boşluk ve çoklu klip kes)",
    description:
      "Transkript üzerinden videoyu keser; kelimeler silinmez, üstü çizili (~kelime~) olarak işaretlenir ve render_captions / export_transcript çalışırken bu kısımlar tek seferde (single-pass) atlanıp kalanlar birleştirilir.\n" +
      "- mode='keep_only': Videonun farklı yerlerinden birden fazla önemli bölümü seçip tek bir özet klip (ör. 30 sn Reels/Shorts) yapmak için kullanılır. Verilen ranges dışındaki tüm kelimeleri keser ve dış aralığı (range) ilk tutulan kelimeden son tutulan kelimeye daraltır; böylece render_captions tüm parçaları tek bir render geçişinde birleştirir.\n" +
      "- mode='cut': Verilen ranges içindeki kelimeleri/cümleleri videodan çıkarır.\n" +
      "- mode='restore': Verilen ranges içindeki kesilmiş kelimeleri geri getirir.\n" +
      "- mode='reset': El ile yapılan tüm kelime ve boşluk kesimlerini sıfırlar.\n" +
      "Ayrıca fillers=true ile tüm dolgu sesleri ('ııı', 'eee', 'hmm'), silences=true ile uzun sessizlikler, gap_before ile belirli kelimelerin önündeki sessizlikler tek çağrıda kısaltılabilir. undo ile geri alınır.",
    inputSchema: {
      id: z.string(),
      mode: z.enum(["cut", "keep_only", "restore", "reset"]).default("cut"),
      ranges: z.array(CutRangeSchema).optional().describe("Kesilecek veya tutulacak kelime/zaman aralıkları"),
      fillers: z.boolean().optional().describe("true: tüm dolgu seslerini ('ııı', 'eee', 'hmm') keser; false: geri alır"),
      silences: z.boolean().optional().describe("true: min_gap'ten uzun tüm sessizlikleri kısaltır; false: geri alır"),
      min_gap: z.number().min(0.2).default(0.6).describe("silences=true iken kısaltılacak en kısa sessizlik, saniye"),
      gap_before: z.array(z.number().int().min(0)).optional().describe("Önündeki sessizliği kısaltılacak (mode=restore ise geri alınacak) kelimelerin sıraları"),
      pad: z.number().min(0).default(0.15).describe("keep_only modunda ilk kelimeden önce ve son kelimeden sonra bırakılacak pay, saniye"),
    },
  },
  async (a) => {
    try {
      const t = store.load(a.id);
      if (!t.words.length) throw new Error("Transkriptte kelime yok.");
      const maxTime = t.duration || (t.words.at(-1)?.end ?? 0);
      const jc = { ...DEFAULT_JUMP_CUT, on: false, gap: a.min_gap, pad: a.pad };

      if (a.mode === "reset") {
        store.checkpoint(t, "cut_words (sıfırla)");
        t.words = restoreAllCuts(t.words);
        store.save(t);
        return text(`Tüm el kesimleri sıfırlandı.\n${summary(t)}`);
      }

      const picked = new Set<number>();
      for (const r of a.ranges ?? []) {
        if (r.first !== undefined) {
          const last = r.last ?? (r.count !== undefined ? r.first + r.count - 1 : r.first);
          if (r.first >= t.words.length || last >= t.words.length || last < r.first) {
            throw new Error(`Kelime aralığı ${r.first}..${last} geçersiz (0..${t.words.length - 1}).`);
          }
          for (let i = r.first; i <= last; i++) picked.add(i);
        } else if (r.start !== undefined && r.end !== undefined && r.end > r.start) {
          t.words.forEach((w, i) => {
            if (w.end > r.start! && w.start < r.end!) picked.add(i);
          });
        } else {
          throw new Error("Her aralıkta (first, last/count) ya da (start, end) verilmeli.");
        }
      }

      store.checkpoint(t, `cut_words (${a.mode})`);
      let next = t.words.slice();

      if (a.mode === "keep_only") {
        if (!picked.size) throw new Error("keep_only için en az bir kelime aralığı (ranges) seçilmeli.");
        const sorted = [...picked].sort((x, y) => x - y);
        const firstIdx = sorted[0];
        const lastIdx = sorted[sorted.length - 1];
        const spanStart = Math.max(0, next[firstIdx].start - a.pad);
        const spanEnd = Math.min(maxTime, next[lastIdx].end + a.pad);
        t.range = spanStart <= 0.01 && spanEnd >= maxTime - 0.01 ? undefined : { start: Math.round(spanStart * 1000) / 1000, end: Math.round(spanEnd * 1000) / 1000 };
        next = next.map((w, i) => {
          const { cut: _, ...rest } = w;
          return picked.has(i) ? rest : { ...rest, cut: true };
        });
      } else if (picked.size) {
        next = toggleWordsCut(next, [...picked], jc, a.mode === "cut");
      }

      if (a.fillers !== undefined) {
        const fillerIndices: number[] = [];
        next.forEach((w, i) => {
          if (isFiller(w.text)) fillerIndices.push(i);
        });
        next = toggleWordsCut(next, fillerIndices, jc, a.fillers);
      }

      if (a.silences !== undefined) {
        const spanStart = t.range?.start ?? 0;
        const gapIndices: number[] = [];
        next.forEach((_, i) => {
          if (wordGap(next, i, spanStart) >= a.min_gap - 1e-6) gapIndices.push(i);
        });
        for (const idx of gapIndices) next = toggleGapCut(next, idx, jc, a.silences);
      }

      if (a.gap_before?.length) {
        const cutGap = a.mode !== "restore";
        for (const idx of a.gap_before) next = toggleGapCut(next, idx, jc, cutGap);
      }

      t.words = next;
      store.save(t);

      const span = t.range ?? { start: 0, end: maxTime };
      const cuts = findCuts(t.words, span, jc, new Float32Array(0));
      const parts = keptParts(span, cuts);
      const outLen = keptLength(parts);
      const partsText = parts.map((p) => `${clock(p.start)}–${clock(p.end)} (${(p.end - p.start).toFixed(1)}s)`).join(", ");
      return text(
        `${summary(t)}\nTutulan parçalar (${parts.length} parça, çıktı süresi ${outLen.toFixed(1)} sn): ${partsText}`,
      );
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

/** The app's preset each ffmpeg style stands for. */
const STYLE_PRESET: Record<string, string> = {
  klasik: "klasik",
  sade: "sade",
  karaoke: "karaoke",
  akis: "akis",
  odak: "odak",
  vurgu: "vurgu",
  pop: "pop",
  netles: "netles",
  "tek-kelime": "tek",
};

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
      "Altyazıyı videoya yazar. cut_words ile kesilen kelimeler, kısaltılan boşluklar veya mode='keep_only' ile seçilen çoklu önemli bölümler tek bir render geçişinde (single-pass, ses crossfade ile) birleştirilip yazılır. Transkript web uygulamasının .harfiyen projesinden geldiyse (import_project) projenin altyazı stili, yazı tipi, renkleri, boyutu, kadrajı (kırpma kutusu ya da sığdırma, bulanık zemin) ve boşluk kesme ayarı varsayılan olarak kullanılır; verilen parametreler bunun üstüne yazar, use_project=false projeyi yok sayar. Stiller: klasik (koyu kutu), sade (gölgeli), karaoke (söylenen kelime renkle dolar), akis (kelimeler söylendikçe yerinde belirir), odak (bulanıktan netleşir), vurgu (söylenen kelime renkli işaretleyici), pop (ortada 3 iri zıplayan kelime), netles (ortada tek iri kelime bulanıktan netleşir), tek-kelime (ortada tek iri kelime). Video varsayılan olarak uygulamanın kendi çizim koduyla, kurulu Chrome'da yazılır: cam stili, aura, kinetik tipografi, bulanık görüntü, arka plan fotoğrafı ve logo (preset=cam, text_background=glass, kinetic, picture=aura/blur, aura, aura_style, photo_file, logo_file) yalnızca böyle çizilir. Chrome yoksa ffmpeg kullanılır ve cevapta not düşülür (yalnızca Chrome'da olanlar istendiyse hata verilir). Chrome yolunda size uygulamanın boyudur (kısa kenarın payı), bold yoktur.",
    inputSchema: {
      id: z.string(),
      output: z.string().describe("Yazılacak .mp4 dosyasının yolu"),
      use_project: z.boolean().default(true).describe("Transkript bir Harfiyen projesinden geldiyse onun stilini ve kadrajını kullan"),
      style: z.enum(["klasik", "sade", "karaoke", "akis", "odak", "vurgu", "pop", "netles", "tek-kelime"]).optional(),
      engine: z.enum(["auto", "ffmpeg", "chrome"]).default("auto").describe("auto: Chrome kuruluysa uygulamanın kendi çizimiyle (Chrome), değilse ffmpeg; chrome: Chrome şart (yoksa hata); ffmpeg: Chrome'a hiç gitme"),
      preset: z.enum(["klasik", "karaoke", "dolgu", "akis", "odak", "vurgu", "pop", "tek", "netles", "sade", "cam"]).optional().describe("Uygulamanın altyazı stili (Chrome ile yazılır); cam yalnızca burada var"),
      hidden: z.boolean().optional().describe("true: ekrana altyazı ya da kinetik yazı çizmez (yalnızca seslendirme, aura, fotoğraf, logo ya da boşluk kesme için)"),
      kinetic: z.enum(["dugum", "pano", "fizik", "kamera", "poster", "darbe", "maske", "tunel"]).optional().describe("Altyazı yerine tam ekran kinetik tipografi (Chrome ile yazılır)"),
      kinetic_palette: z.enum(["gece", "neon", "krem", "mercan", "firuze"]).optional(),
      kinetic_backdrop: z.enum(["stage", "aura"]).optional().describe("Kinetik sahnenin zemini (görüntü yokken): stage paletin kendi düz zemini, aura sesle hareket eden aura"),
      picture: z.enum(["video", "blur", "aura"]).optional().describe("video: görüntüyü olduğu gibi koru; blur: görüntüyü bulanık ve koyu çiz (yazı her görüntüde okunur); aura: videonun görüntüsü yerine sesle hareket eden aura (Chrome ile yazılır; çıkış 1080p ya da kadrajın şekli)"),
      aura: z.enum(["cini", "gunbatimi", "orman", "lavanta", "gece"]).optional().describe("Aura paleti"),
      aura_style: z.enum(["aura", "halo", "spektrum", "kure", "akis"]).optional().describe("Aura görünümü: spektrum Ufuk, akis Sırtlar"),
      photo_file: z.string().optional().describe("Ses dosyasında ya da görüntüsü gizlenen videoda aura yerine kullanılacak arka plan fotoğrafı ya da sessiz döngüsel videosu (JPEG, PNG, WebP, SVG, MP4, WebM, MOV; Chrome ile yazılır)"),
      photo_blur: z.boolean().optional().describe("Arka plan fotoğrafını ya da videosunu bulanık ve koyu çiz; yazı her görüntüde okunur"),
      logo_file: z.string().optional().describe("Bir köşede gösterilecek logo resmi (PNG, SVG, WebP ya da JPEG; Chrome ile yazılır)"),
      logo_corner: z.enum(["tl", "tr", "bl", "br"]).optional().describe("Logonun köşesi: tl sol üst, tr sağ üst (varsayılan), bl sol alt, br sağ alt"),
      logo_size: z.number().min(0.05).max(0.35).optional().describe("Logonun uzun kenarı, karenin kısa kenarının payı (varsayılan 0,14)"),
      logo_opacity: z.number().min(0.1).max(1).optional().describe("Logonun görünürlüğü, 0,1–1 (1: tam, varsayılan)"),
      emphasis: z.boolean().optional().describe("Sesle vurgula: çevresinden yüksek sesle söylenen kelimeler büyük (ve çoğu stilde vurgu renginde) yazılır"),
      language: Language,
      dub: z.boolean().optional().describe("Seslendirmeyi (dub aracı) karıştır; verilmezse varsa karıştırılır, false ile hiç karıştırılmaz"),
      original_volume: z.number().min(0).max(0.5).default(0).describe("Seslendirmenin altında dosyanın kendi sesi, 0–0,5 (0: hiç duyulmaz, uygulamadaki gibi)"),
      follow_dub: z.boolean().optional().describe("Seslendirmeyle aynı dildeki altyazı sesin zamanını izler (varsayılan açık)"),
      font: z
        .string()
        .optional()
        .describe(`Paketli yazı tiplerinden biri (${BUNDLED.map((f) => f.family).join(", ")}) ya da sistemde kurulu bir yazı tipi adı`),
      font_file: z.string().optional().describe("Kendi yazı tipin (TTF ya da OTF; Chrome yolunda WOFF ve WOFF2 de olur); verilirse font yerine bu kullanılır"),
      bold: z.boolean().optional().describe("Kalın; verilmezse yazı tipine göre (Anton, Bangers gibi tek kalınlıklılarda kapalı)"),
      uppercase: z.boolean().optional().describe("Türkçe kurala uygun büyük harf (i → İ); verilmezse yazı tipine göre (Luckiest Guy, Bangers, Bebas Neue yalnızca büyük harf bildiği için açık)"),
      size: z.number().min(0.02).max(0.15).optional().describe("Yazı boyu, kare yüksekliğinin payı; büyük stiller (pop, tek-kelime, netles) bunu ayrıca büyütür. Chrome yolunda uygulamanın boyudur: kısa kenarın payı, stilin kendi boyu hazır"),
      position: z.enum(["alt", "orta", "ust"]).optional().describe("Verilmezse stile göre: tek kelimelik stiller ortada, diğerleri altta"),
      text_background: z.enum(["box", "outline", "shadow", "glass"]).optional().describe("Yazının zemini: koyu kutu, kontur, gölge ya da buzlu cam (glass yalnızca Chrome ile çizilir)"),
      color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
      accent: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().describe("Vurgu rengi (karaoke dolgusu, vurgu kutusu)"),
      speaker_names: z.boolean().optional().describe("Konuşan değişince adı yazılsın (varsayılan: proje ne diyorsa, yoksa açık)"),
      aspect: z.enum(["9:16", "4:5", "1:1", "16:9"]).optional().describe("Kadraj; verilirse projenin kırpma kutusu yok sayılır ve crop_position konumundan kırpılır"),
      crop_position: z.enum(["orta", "sol", "sag", "ust", "alt"]).optional().describe("fill modunda kırpma kutusunun konumu: orta (varsayılan), sol, sag, ust, alt"),
      fit: z.enum(["fill", "fit"]).optional().describe("fill: kareyi kapla, taşanı kes; fit: tamamı görünsün, boşluk siyah ya da bulanık"),
      backdrop: z.enum(["black", "blur"]).optional().describe("fit'te görüntünün çevresi: siyah ya da görüntünün kendisi bulanık"),
      jump_cut: z.boolean().optional().describe("Sessizlikleri ve dolgu seslerini videodan çıkar; verilmezse projenin ayarı"),
      ...JumpCutOptional,
      save_to_project: z.boolean().default(true).describe("Seçilen stil, kadraj ve boşluk kesme ayarlarını transkripte kaydet (export_project ile .harfiyen dosyasına da geçer)"),
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
      // A ratio or position asked for here replaces the project's crop; a fit asked for drops the crop box (a box is a fill).
      const ownCrop = a.aspect === undefined && a.crop_position === undefined;
      const fit = a.fit ?? (ownCrop ? look.fit : undefined) ?? "fill";
      const jumpCut =
        a.jump_cut === false
          ? undefined
          : a.jump_cut === true || look.jumpCut
            ? { gap: a.gap ?? look.jumpCut?.gap, pad: a.pad ?? look.jumpCut?.pad, fillers: a.fillers ?? look.jumpCut?.fillers }
            : undefined;
      // Asking for a caption or kinetic style turns captions back on when the project had them hidden.
      const hidden = a.hidden ?? (a.style !== undefined || a.preset !== undefined || a.kinetic !== undefined ? false : look.hidden);
      const opts: RenderOptions = {
        output: abs(a.output),
        captions: {
          style: a.style ?? look.style ?? DEFAULT_CAPTIONS.style,
          font: a.font ?? look.captions.font ?? DEFAULT_CAPTIONS.font,
          bold: a.bold,
          uppercase: a.uppercase ?? look.captions.uppercase,
          ...size,
          position: a.position ?? fromProject.position,
          background: a.text_background === "glass" ? "box" : (a.text_background ?? fromProject.background),
          color: a.color ?? look.captions.color ?? DEFAULT_CAPTIONS.color,
          accent: a.accent ?? look.captions.accent ?? DEFAULT_CAPTIONS.accent,
        },
        hidden,
        emphasis: a.emphasis ?? look.emphasis ?? false,
        speakerNames: a.speaker_names ?? look.speakerNames,
        fontFile: a.font_file ? abs(a.font_file) : undefined,
        aspect: a.aspect ?? look.aspect,
        cropPosition: a.crop_position,
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
      };

      // The app's own renderer (Chrome) draws every look as the app does; ffmpeg is the stand-in when there is no Chrome.
      const asked = [
        a.preset,
        a.text_background === "glass" || undefined,
        a.kinetic,
        a.kinetic_palette,
        a.kinetic_backdrop,
        a.picture === "aura" || a.picture === "blur" || undefined,
        a.aura,
        a.aura_style,
        a.photo_file,
        a.photo_blur,
        a.logo_file,
        a.logo_corner,
        a.logo_size,
        a.logo_opacity,
      ].some((x) => x !== undefined);
      const chrome = a.engine === "ffmpeg" ? null : findChrome();
      if (!chrome && (a.engine === "chrome" || asked)) throw new Error(missingChrome());
      const standIn = !chrome && a.engine === "auto" ? "Chrome bulunamadı; altyazı ffmpeg ile yazıldı, uygulamadakinden farklı çizilebilir (konuşmacı adı gibi). Chrome kurulursa uygulamanın kendi çizimi kullanılır." : "";

      const early: string[] = standIn ? [standIn] : [];
      if (look.missingFont && !a.font_file && !a.font && !hidden) {
        early.push("Projede kendi yüklediğin bir yazı tipi var; dosyası projede olmadığı için varsayılan yazı tipi kullanıldı (font_file ile verilebilir).");
      }
      if (look.logo?.on && !a.logo_file) {
        early.push("Projede logo açık; dosyası projede olmadığı için kullanılmadı (logo_file ile verilebilir).");
      }
      if (look.photo && !a.photo_file && a.picture === undefined) {
        early.push("Projede arka plan fotoğrafı var; dosyası projede olmadığı için kullanılmadı (photo_file ile verilebilir).");
      }
      if (!a.logo_file && (a.logo_corner !== undefined || a.logo_size !== undefined || a.logo_opacity !== undefined)) {
        early.push("logo_corner, logo_size ve logo_opacity için logo_file da verilmeli.");
      }
      if (!a.photo_file && a.photo_blur !== undefined) {
        early.push("photo_blur için photo_file da verilmeli.");
      }
      const family = a.font_file ? undefined : (a.font ?? undefined);
      const fontId = family ? fontIdOf(family) : undefined;
      const preset = a.preset ?? (a.style ? STYLE_PRESET[a.style] : look.settings ? undefined : "sade");
      const projectKinetic = !preset && !hidden && (look.settings as { kinetic?: { on?: boolean } } | undefined)?.kinetic?.on === true;
      // A palette or backdrop alone changes the project's kinetic stage; it does not turn one on.
      const kineticPatch = { ...(a.kinetic_palette && { palette: a.kinetic_palette }), ...(a.kinetic_backdrop && { backdrop: a.kinetic_backdrop }) };
      const kinetic = a.kinetic ? { style: a.kinetic, ...kineticPatch } : projectKinetic && Object.keys(kineticPatch).length ? kineticPatch : undefined;
      const stylePatch = {
        ...(fontId && { font: fontId }),
        ...(a.size !== undefined && { size: a.size }),
        ...(a.position && { position: { alt: "bottom", orta: "middle", ust: "top" }[a.position] }),
        ...(a.color && { textColor: a.color }),
        ...(a.accent && { accentColor: a.accent }),
        ...(a.uppercase !== undefined && { uppercase: a.uppercase }),
        ...(a.text_background && { background: a.text_background }),
        ...(a.speaker_names !== undefined && { speakerNames: a.speaker_names }),
        ...(a.aura && { aura: a.aura }),
        ...(a.aura_style && { auraStyle: a.aura_style }),
      };

      if (a.save_to_project) {
        const mediaInfo = t.source ? await probe(t.source).catch(() => null) : null;
        t.app = saveLookToApp(a.use_project ? t.app : undefined, {
          preset,
          patch: stylePatch,
          kinetic,
          picture: a.picture,
          hidden,
          emphasis: a.emphasis,
          speakerNames: a.speaker_names,
          logo: a.logo_file
            ? {
                corner: a.logo_corner ?? look.logo?.corner ?? "tr",
                size: a.logo_size ?? look.logo?.size ?? 0.14,
                opacity: a.logo_opacity ?? look.logo?.opacity ?? 1,
              }
            : undefined,
          photo: a.photo_file ? { blur: a.photo_blur ?? look.photoBlur } : undefined,
          aspect: opts.aspect,
          fit: a.fit,
          backdrop: a.backdrop,
          cropPosition: a.crop_position,
          mediaSize: mediaInfo && mediaInfo.hasVideo ? { width: mediaInfo.width, height: mediaInfo.height } : undefined,
          jumpCut: a.jump_cut,
          jumpCutOpts: jumpCut,
        });
        store.save(t);
      }

      let r: { output: string; seconds: number; cuts: number; size: string; dubbed: boolean; notes: string[] };
      let drawnBy = "";
      if (chrome) {
        if (!kinetic && Object.keys(kineticPatch).length) {
          early.push("kinetic_palette ve kinetic_backdrop yalnızca kinetik tipografi açıkken (kinetic parametresi ya da projede) kullanılır.");
        }
        const c: ChromeStyle = {
          settings: a.use_project ? look.settings : undefined,
          // No style asked for and no project: sade, the look this tool has always started from.
          preset,
          patch: stylePatch,
          kinetic,
          picture: a.picture,
          fontFile: a.font_file ? abs(a.font_file) : undefined,
          logo: a.logo_file
            ? {
                file: abs(a.logo_file),
                corner: a.logo_corner ?? look.logo?.corner ?? "tr",
                size: a.logo_size ?? look.logo?.size ?? 0.14,
                opacity: a.logo_opacity ?? look.logo?.opacity ?? 1,
              }
            : undefined,
          photo: a.photo_file ? { file: abs(a.photo_file), blur: a.photo_blur ?? look.photoBlur } : undefined,
        };
        if (a.bold !== undefined) early.push("bold Chrome yolunda yok; kalınlığı uygulama yazı tipine göre kendisi seçer.");
        const done = await renderChrome(t, opts, c, report);
        r = done;
        drawnBy = `\nUygulamanın kendi çizimiyle yazıldı (Chrome, ${done.gpu}).`;
        if (family && !fontId) r.notes.push(`"${family}" paketli yazı tiplerinden değil; Chrome yolunda yalnızca paketli olanlar kullanılır, projenin yazı tipi kalır.`);
      } else {
        r = await renderCaptions(t, opts, report);
      }
      const given = [
        a.style === undefined && a.hidden === undefined && !chrome && look.used.style,
        ownCrop && a.fit === undefined && look.used.crop,
        a.jump_cut === undefined && look.used.jumpCut,
      ].filter(Boolean);
      const used = given.length ? `\nProjeden: ${given.join(", ")}` : "";
      // What only the app's renderer draws is told about only when ffmpeg stood in for it.
      const notes = [...early, ...(chrome ? [] : look.chromeOnly.map((x) => x.note)), ...look.notes].map((n) => `\nNot: ${n}`).join("");
      const dubbed = r.dubbed ? `\nSeslendirme karıştırıldı (orijinal ses %${Math.round(a.original_volume * 100)}).` : "";
      const more = r.notes.map((n) => `\nNot: ${n}`).join("");
      return `Yazıldı: ${r.output}\n${r.size}, ${r.seconds.toFixed(1)} sn${r.cuts ? `, ${r.cuts} kesim` : ""}${drawnBy}${used}${dubbed}${notes}${more}`;
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

const SpeakerVoices = z
  .array(
    z.object({
      speaker: z.string().describe("Konuşmacının adı (tell_speakers, rename_speaker) ya da numarası (1'den)"),
      voice: VoiceShape.voice.removeDefault().optional(),
      style: VoiceShape.style.removeDefault().optional(),
      pitch: VoiceShape.pitch.removeDefault().optional(),
      seed: VoiceShape.seed.removeDefault().optional(),
    }),
  )
  .optional()
  .describe("Konuşmacı başına ses (önce tell_speakers çalışmış olmalı). Verilmeyen alan yukarıdaki ses ayarından gelir; listede olmayan konuşmacı o sesle okunur.");

const voiceLabel = (v: Voice) => `${VOICE_INFO[v.model].name}${v.model === "supertonic" ? ` ${v.style}` : ""}`;

/** Each listed speaker's voice, by the speaker's number: the base voice with what was given on top. */
function speakerVoicesOf(
  asked: z.infer<typeof SpeakerVoices>,
  t: Transcript,
  base: Voice,
  lang: VoiceLang,
): Map<number, { name: string; voice: Voice }> {
  const out = new Map<number, { name: string; voice: Voice }>();
  if (!asked?.length) return out;
  const names = t.speakers?.names;
  if (!names?.length) throw new Error("Konuşmacı başına ses için önce tell_speakers ile konuşmacılar ayrılmalı.");
  for (const x of asked) {
    const wanted = x.speaker.trim();
    const byName = names.findIndex((n) => n.toLowerCase() === wanted.toLowerCase());
    const index = byName >= 0 ? byName : /^\d+$/.test(wanted) ? Number(wanted) - 1 : -1;
    if (index < 0 || index >= names.length) throw new Error(`"${x.speaker}" diye bir konuşmacı yok; olanlar: ${names.map((n, i) => `${i + 1}. ${n}`).join(", ")}.`);
    const given = { ...(x.voice && { model: x.voice }), ...(x.style && { style: x.style }), ...(x.pitch !== undefined && { pitch: x.pitch }), ...(x.seed !== undefined && { seed: x.seed }) };
    out.set(index, { name: names[index], voice: fitVoice({ ...base, ...given, lang }) });
  }
  return out;
}

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
    inputSchema: { id: z.string(), language: Language, ...VoiceShape, speaker_voices: SpeakerVoices, background: Background },
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
      const allLines = dubLines(words, dubBySentence(lang, t.lang));
      const lines = t.range ? allLines.filter((l) => l.end > t.range!.start && l.start < t.range!.end) : allLines;
      if (!lines.length) throw new Error("Seçili bölümde okunacak metin yok.");
      const keyWords = t.range ? words.filter((w) => w.end > t.range!.start && w.start < t.range!.end) : words;
      // A line is read by whoever says its first word.
      const per = speakerVoicesOf(a.speaker_voices, t, voice, lang);
      const who = per.size ? labelWords(words, t.speakers) : words;
      const voiceAt = (i: number) => per.get(who[lines[i].first]?.speaker ?? -1)?.voice ?? voice;
      const start = t.range?.start ?? 0;
      const end = t.range?.end ?? t.duration;
      const started = Date.now();
      const { clips, overflow } = await placeLines(lines, t.duration, end, per.size ? voiceAt : voice, report, start);
      const meta: DubMeta = {
        voice,
        ...(per.size && { speakerVoices: [...per].map(([speaker, x]) => ({ speaker, name: x.name, voice: x.voice })) }),
        language: a.language,
        key: dubKey(keyWords),
        duration: t.duration,
        ...(t.range && { start }),
        end,
        lines,
        clips: clips.map((c) => ({ line: c.line, start: c.start, seconds: c.audio.length / 48000 })),
        overflow,
        elapsed: (Date.now() - started) / 1000,
      };
      saveDub(t.id, meta, clips);
      const spoken = meta.clips.reduce((n, c) => n + c.seconds, 0);
      const warn = overflow ? `\nUyarı: ${overflow.start.toFixed(1)}. saniyedeki son cümle sığmıyor, ${overflow.seconds.toFixed(1)} sn taşıyor; cümle kısaltılabilir.` : "";
      return `Seslendirildi: ${meta.clips.length}/${lines.length} satır, ${spoken.toFixed(1)} sn ses (${VOICE_INFO[voice.model].name}${voice.model === "supertonic" ? ` ${voice.style}` : ""}), ${meta.elapsed.toFixed(1)} sn sürdü.${per.size ? `\n${[...per].map(([, x]) => `${x.name}: ${voiceLabel(x.voice)}`).join(", ")}` : ""}${warn}${note}`;
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
    description: "Arka planda başlatılan bir işin durumunu ve bittiyse sonucunu verir. job_id verilmezse bütün işleri listeler.",
    inputSchema: { job_id: z.string().optional() },
  },
  async (a) => {
    if (!a.job_id) {
      const all = jobs.list();
      return text(all.length ? all.map(jobs.describe).join("\n") : "Kayıtlı iş yok.");
    }
    const j = jobs.get(a.job_id);
    return j ? text(jobs.describe(j)) : fail(`"${a.job_id}" kimlikli iş yok (sunucu yeniden başlamış olabilir).`);
  },
);

server.registerTool(
  "cancel_job",
  {
    title: "İşi durdur",
    description: "Çalışan ya da sırada bekleyen bir arka plan işini (transcribe, dub, render_captions vb.) ve varsa Chrome / ffmpeg sürecini durdurur. job_id verilmezse o an çalışan (yoksa sıradaki son) işi durdurur.",
    inputSchema: { job_id: z.string().optional().describe("Durdurulacak işin kimliği (j1, j2...); verilmezse çalışan iş") },
  },
  async (a) => {
    try {
      const j = jobs.cancel(a.job_id);
      return text(jobs.describe(j));
    } catch (e) {
      return fail(e);
    }
  },
);

await server.connect(new StdioServerTransport());
