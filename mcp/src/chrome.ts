// The web app's own video writer, run in headless Chrome. ffmpeg and libass cannot draw the glass, aura, logo or
// kinetic styles (they are WebGPU shaders and canvas code in src/render), so for those the app's render worker
// (src/worker/render.worker.ts) is loaded in a page (render-host/) and given the job; the output is the app's.
//
// Chrome is the one already installed (puppeteer-core downloads none). The page is built once with Vite and kept
// in the MCP's home folder; it is built again when anything under src/ or render-host/ changes.

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { homedir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import puppeteer from "puppeteer-core";
import type { BurnJob, BurnResult } from "../render-host/host";
import type { Progress } from "./pipeline";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const home = process.env.HARFIYEN_MCP_HOME ?? join(homedir(), ".harfiyen-mcp");
const PAGE = "mcp/render-host/index.html";

/** The installed Chrome: CHROME if set, else the usual places. null when there is none. */
export function findChrome(): string | null {
  const env = process.env.CHROME;
  if (env) return existsSync(env) ? env : null;
  const places: string[] = [];
  if (process.platform === "darwin") {
    places.push("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium");
  } else if (process.platform === "win32") {
    for (const base of [process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA]) {
      if (base) places.push(join(base, "Google", "Chrome", "Application", "chrome.exe"));
    }
  } else {
    for (const name of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]) {
      try {
        places.push(execFileSync("which", [name], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim());
      } catch {
        // Not installed under this name.
      }
    }
  }
  return places.find((p) => p && existsSync(p)) ?? null;
}

/** Changes whenever the app's code or the page does, so a stale build is never used. */
function sourceStamp(): string {
  const h = createHash("sha1");
  for (const dir of [join(repo, "src"), join(repo, "mcp", "render-host")]) {
    const files = (readdirSync(dir, { recursive: true }) as string[]).sort();
    for (const f of files) {
      const s = statSync(join(dir, f));
      if (s.isFile()) h.update(`${f}:${s.size}:${Math.round(s.mtimeMs)};`);
    }
  }
  return h.digest("hex").slice(0, 12);
}

/** The built page, made on first use (a few seconds) and then kept. */
async function builtPage(progress: Progress): Promise<string> {
  const cache = join(home, "render-host");
  const dir = join(cache, sourceStamp());
  if (existsSync(join(dir, PAGE))) return dir;
  progress(0, "video yazıcı derleniyor (ilk kullanım)");
  const { build } = await import("vite");
  await build({
    root: repo,
    configFile: false,
    logLevel: "error",
    // The app's public/ holds the models, gigabytes the video writer never reads.
    publicDir: false,
    optimizeDeps: { exclude: ["onnxruntime-web"] },
    worker: { format: "es" },
    build: { outDir: dir, emptyOutDir: true, target: "es2022", assetsInlineLimit: 0, rollupOptions: { input: join(repo, PAGE) } },
  });
  // Older builds are not needed any more.
  for (const old of readdirSync(cache)) if (join(cache, old) !== dir) rmSync(join(cache, old), { recursive: true, force: true });
  return dir;
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".svg": "image/svg+xml",
};

/** An image file served with its MIME type so the browser's Image() decodes SVGs as well. */
export interface ImageInput {
  bytes: Buffer;
  type: string;
}

/** What the page fetches besides its own files. */
export interface Inputs {
  source: string;
  /** 16-bit mono PCM at 48 kHz from the file's start. */
  dub?: Buffer;
  bands?: Float32Array;
  loudness?: Float32Array;
  /** The caption font's file (TTF, OTF, WOFF, WOFF2). */
  font?: Buffer;
  logo?: ImageInput;
  photo?: ImageInput;
}

const bytes = (f: Float32Array) => Buffer.from(f.buffer, f.byteOffset, f.byteLength);

/** Local server for the page and its inputs. Only this machine can reach it. */
function serve(dir: string, inputs: Inputs): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    const path = decodeURIComponent((req.url ?? "/").split("?")[0]);
    const send = (body: Buffer | undefined, type = "application/octet-stream") => {
      if (!body) return void res.writeHead(404).end();
      res.writeHead(200, { "Content-Type": type, "Content-Length": body.length }).end(body);
    };
    if (path === "/__source") {
      res.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": statSync(inputs.source).size });
      return void createReadStream(inputs.source).pipe(res);
    }
    if (path === "/__dub") return send(inputs.dub);
    if (path === "/__font") return send(inputs.font);
    if (path === "/__logo") return send(inputs.logo?.bytes, inputs.logo?.type);
    if (path === "/__photo") return send(inputs.photo?.bytes, inputs.photo?.type);
    if (path === "/__bands") return send(inputs.bands && bytes(inputs.bands));
    if (path === "/__loudness") return send(inputs.loudness && bytes(inputs.loudness));
    // The built page's files; never outside its folder.
    const file = resolve(dir, "." + path);
    if (!file.startsWith(dir + "/") && file !== dir) return void res.writeHead(403).end();
    if (!existsSync(file) || !statSync(file).isFile()) return void res.writeHead(404).end();
    res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream" });
    createReadStream(file).pipe(res);
  });
  return new Promise((done, fail) => {
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => done({ server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}` }));
  });
}

/** No progress for this long and the render is taken as stuck. */
const STUCK_MS = 180_000;

/**
 * Writes the job's video to `output` with the app's render worker in Chrome. The file appears only when it is
 * whole: it is written beside it and moved in place at the end.
 */
export async function renderInChrome(job: BurnJob, inputs: Inputs, output: string, progress: Progress): Promise<BurnResult> {
  const chrome = findChrome();
  if (!chrome) throw new Error(missingChrome());
  const dir = await builtPage(progress);
  const { server, url } = await serve(dir, inputs);
  const part = `${output}.part`;
  mkdirSync(dirname(output), { recursive: true });
  const out = createWriteStream(part);
  const darwin = process.platform === "darwin";
  const browser = await puppeteer
    .launch({
      executablePath: chrome,
      headless: true,
      args: ["--enable-unsafe-webgpu", "--enable-gpu", "--ignore-gpu-blocklist", ...(darwin ? ["--use-angle=metal"] : [])],
    })
    .catch((e) => {
      server.close();
      throw new Error(`Chrome açılamadı (${chrome}): ${e instanceof Error ? e.message : e}`);
    });
  let ok = false;
  try {
    const page = await browser.newPage();
    let last = Date.now();
    let shown = 0;
    let pageError = "";
    page.on("pageerror", (e) => (pageError = e instanceof Error ? e.message : String(e)));
    await page.exposeFunction("harfiyenChunk", (b64: string) => void out.write(Buffer.from(b64, "base64")));
    await page.exposeFunction("harfiyenProgress", (share: number) => {
      last = Date.now();
      if (share - shown >= 0.01) {
        shown = share;
        progress(share, "video yazılıyor");
      }
    });
    await page.goto(`${url}/${PAGE}`);
    await page.waitForFunction(() => typeof (window as unknown as { burn?: unknown }).burn === "function", { timeout: 60_000 }).catch(() => {
      throw new Error(`Video yazıcı sayfası açılmadı${pageError ? `: ${pageError}` : ""}.`);
    });
    const watchdog = setInterval(() => {
      if (Date.now() - last > STUCK_MS) void browser.close();
    }, 10_000);
    try {
      const result = (await page.evaluate((j) => window.burn(j), job as never)) as BurnResult;
      ok = true;
      return result;
    } catch (e) {
      throw new Error(`Chrome'da video yazılamadı: ${(e instanceof Error ? e.message : String(e)).replace(/^Error: /, "")}`);
    } finally {
      clearInterval(watchdog);
    }
  } finally {
    await new Promise<void>((done) => out.end(done));
    await browser.close().catch(() => {});
    server.close();
    if (ok) renameSync(part, output);
    else rmSync(part, { force: true });
  }
}

export const missingChrome = () =>
  "Chrome bulunamadı. Cam, aura ve kinetik stiller uygulamanın kendi çizimini kullanır ve Chrome ister; Chrome kurulu değilse kur, başka bir yerdeyse yolunu CHROME ortam değişkeniyle ver.";
