// The page headless Chrome opens (src/chrome.ts): the web app's own render worker behind one window.burn(), so the
// MCP's videos are drawn by the same code as the app's, glass, aura and kinetic styles included. The job comes in
// as JSON; the source video, the dub and the sound's levels are fetched from the MCP's local server, and the
// finished MP4 goes back in chunks.

import { settingsFor, withOverrides, type CaptionSettings, type PresetId } from "../../src/captions/style";
import type { Word } from "../../src/engine";
import { DEFAULT_KINETIC, type KineticSettings } from "../../src/render/kinetic";
import type { DubMix } from "../../src/tts/dub";
import type { Encode, FromRender, ToRender } from "../../src/worker/render.worker";

export interface BurnJob {
  name: string;
  words: Word[];
  /** The project's caption settings as the app saved them; missing: the preset's own. */
  settings?: Partial<CaptionSettings>;
  /** Another preset than the project's. */
  preset?: PresetId;
  /** Settings asked for by hand; they are marked as the user's own, so a preset does not undo them. */
  patch?: Partial<CaptionSettings>;
  /** Kinetic typography in place of the captions (on); what is given replaces the defaults. */
  kinetic?: Partial<KineticSettings>;
  lang: string;
  speakers: string[] | null;
  /** The dub is fetched from /__dub; `original` is how loud the file's own sound stays under it. */
  dub?: { original: number };
  /** Fetch /__bands (the aura and the kinetic stage move with them) and /__loudness (voice emphasis). */
  bands: boolean;
  loudness: boolean;
  encode: Encode;
}

export interface BurnResult {
  size: number;
  elapsed: number;
  gpu: string;
}

interface HostBindings {
  /** Node side: one base64 chunk of the finished MP4. */
  harfiyenChunk(base64: string): Promise<void>;
  harfiyenProgress(share: number, fps: number): Promise<void>;
}

declare global {
  interface Window {
    burn(job: BurnJob): Promise<BurnResult>;
  }
}

const host = window as unknown as Window & HostBindings;

async function gpuInfo(): Promise<string> {
  const adapter = await navigator.gpu?.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) return "WebGPU yok";
  const { vendor, architecture, description } = adapter.info;
  return `WebGPU: ${vendor} ${architecture} ${description}`.trim();
}

/** The settings the job asks for: the project's, another preset's, then what was set by hand. */
function settingsOf(job: BurnJob): CaptionSettings {
  let s: CaptionSettings = job.settings ? { ...settingsFor(job.settings.preset ?? "karaoke"), ...job.settings } : settingsFor("karaoke");
  if (job.preset && job.preset !== s.preset) s = settingsFor(job.preset, s);
  if (job.patch) s = withOverrides(s, job.patch);
  if (job.kinetic) s = { ...s, kinetic: { ...DEFAULT_KINETIC, ...s.kinetic, ...job.kinetic, on: true } };
  return s;
}

/** The dub's PCM (16-bit mono, 48 kHz, from the file's start) as the worker's DubMix: one clip that covers all of it. */
async function dubMix(original: number): Promise<DubMix> {
  const pcm = new Int16Array(await (await fetch("/__dub")).arrayBuffer());
  const audio = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) audio[i] = pcm[i] / 32768;
  return { clips: [{ line: 0, start: 0, audio }], original };
}

const floats = async (path: string) => new Float32Array(await (await fetch(path)).arrayBuffer());

window.burn = async (job) => {
  const blob = await (await fetch("/__source")).blob();
  const file = new File([blob], job.name, { type: blob.type || "video/mp4" });

  const worker = new Worker(new URL("../../src/worker/render.worker.ts", import.meta.url), { type: "module" });
  const done = new Promise<{ file: File | null; size: number; elapsed: number }>((resolve, reject) => {
    worker.onmessage = (ev: MessageEvent<FromRender>) => {
      const m = ev.data;
      if (m.type === "progress") void host.harfiyenProgress(m.progress, m.fps);
      else if (m.type === "done") resolve({ file: m.file, size: m.size, elapsed: m.elapsed });
      else if (m.type === "error") reject(new Error(m.message));
      else if (m.type === "cancelled") reject(new Error("iptal edildi"));
    };
    worker.onerror = (e) => reject(new Error(e.message));
  });

  const msg: ToRender = {
    type: "burn",
    jobId: 1,
    file,
    words: job.words,
    settings: settingsOf(job),
    userFont: null,
    bands: job.bands ? await floats("/__bands") : new Float32Array(0),
    loudness: job.loudness ? await floats("/__loudness") : new Float32Array(0),
    lang: job.lang,
    speakers: job.speakers,
    dub: job.dub ? await dubMix(job.dub.original) : null,
    logo: null,
    photo: null,
    encode: job.encode,
    // null: the worker writes to the browser's private disk and hands the file back.
    handle: null,
  };
  worker.postMessage(msg);
  const result = await done;
  worker.terminate();
  if (!result.file) throw new Error("Çıktı dosyası gelmedi.");

  // 4 MB at a time so a long video never sits in one message.
  const STEP = 4 * 1024 * 1024;
  for (let at = 0; at < result.file.size; at += STEP) {
    const bytes = new Uint8Array(await result.file.slice(at, at + STEP).arrayBuffer());
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    await host.harfiyenChunk(btoa(bin));
  }
  return { size: result.size, elapsed: result.elapsed, gpu: await gpuInfo() };
};
