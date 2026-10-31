import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv, type Plugin } from "vite";

// Cross-origin isolation lets onnxruntime-web use SharedArrayBuffer
// (multi-threaded wasm). Production hosting needs the same headers. Safari
// also wants CORP on scripts that module workers import, or it blocks them.
const isolation = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "same-origin",
};

// Microphone, WebGPU and SharedArrayBuffer need a secure context, which a LAN
// address over plain HTTP is not. If a local mkcert certificate exists in
// .cert/ (git-ignored), serve over HTTPS on the network; see the README.
const cert = ".cert/dev.pem";
const key = ".cert/dev-key.pem";
const https = existsSync(cert) && existsSync(key) ? { cert: readFileSync(cert), key: readFileSync(key) } : undefined;

// Shown next to the logo, linking to CHANGELOG.md.
const { version } = JSON.parse(readFileSync("package.json", "utf8"));
// Identifies one build. The page and sw.js both carry it, so a page can tell whether the worker that just took over is newer than the code it runs.
const buildId = Date.now().toString(36);

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_");
  const wasmUrl = env.VITE_ORT_WASM_URL;
  const wasmModule = "\0harfiyen-ort-wasm-url";

  const remoteWasm = (): Plugin => ({
    name: "harfiyen-remote-wasm",
    // Resolve before Vite emits the large WASM asset, including in workers.
    enforce: "pre",
    resolveId(id) {
      if (wasmUrl && id === "onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url") return wasmModule;
    },
    load(id) {
      if (id === wasmModule) return `export default ${JSON.stringify(wasmUrl)};`;
    },
    transform(code, id) {
      if (!wasmUrl || !id.includes("/onnxruntime-web/")) return;
      // ORT's bundled loader also references this asset independently.
      const replaced = code.replace(
        /new URL\(\s*["']ort-wasm-simd-threaded\.asyncify\.wasm["']\s*,\s*import\.meta\.url\s*\)/g,
        `new URL(${JSON.stringify(wasmUrl)})`,
      );
      if (replaced !== code) return { code: replaced, map: null };
    },
  });

  // Emits sw.js with the app shell asset list (HTML, JS, workers, CSS, fonts,
  // icons, and model.json manifests). Large model weights and the 27 MB ONNX
  // WASM binary are excluded because modelStore.ts manages them in seda-models-v1.
  const offlineSw = (): Plugin => ({
    name: "harfiyen-offline-sw",
    apply: "build",
    closeBundle() {
      const outDir = "dist";
      if (!existsSync(outDir)) return;
      const urls: string[] = ["/"];
      const walk = (dir: string, rel = "") => {
        for (const entry of readdirSync(dir)) {
          if (entry === ".DS_Store" || entry === "_headers" || entry === "sw.js") continue;
          const full = join(dir, entry);
          const path = rel ? `${rel}/${entry}` : entry;
          if (statSync(full).isDirectory()) {
            walk(full, path);
            continue;
          }
          if (
            path.endsWith(".map") ||
            path.endsWith(".onnx") ||
            path.endsWith(".bin") ||
            path.includes("ort-wasm-simd-threaded.asyncify.wasm") ||
            (path.startsWith("models/") && !path.endsWith("/model.json"))
          ) {
            continue;
          }
          urls.push(`/${ path.split("\\").join(posix.sep)}`);
        }
      };
      walk(outDir);
      const hash = createHash("sha256").update(version).update(urls.join("\n")).digest("hex").slice(0, 10);
      const cacheName = `harfiyen-shell-${hash}`;
      const sw = `// Generated at build time — caches the Harfiyen app shell for full offline use.
const CACHE_NAME = ${JSON.stringify(cacheName)};
const BUILD_ID = ${JSON.stringify(buildId)};
const PRECACHE = ${JSON.stringify(urls)};

function cleanResponse(res) {
  if (!res.redirected) return res;
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  });
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) =>
        Promise.all(
          PRECACHE.map((url) =>
            fetch(url, { cache: "reload" })
              .then((res) => (res.ok ? cache.put(url, cleanResponse(res)) : undefined))
              .catch(() => undefined),
          ),
        ),
      )
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k.startsWith("harfiyen-shell-") && k !== CACHE_NAME)
            .map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim())
      .then(() => self.clients.matchAll({ type: "window" }))
      .then((clients) => clients.forEach((c) => c.postMessage({ type: "sw-build", id: BUILD_ID }))),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET" || req.headers.has("range")) return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Model weights and the large ONNX WASM binary live in "seda-models-v1" (modelStore.ts).
  if (
    url.pathname.endsWith(".onnx") ||
    url.pathname.endsWith(".bin") ||
    url.pathname.includes("ort-wasm-simd-threaded.asyncify.wasm") ||
    (url.pathname.includes("/models/") && !url.pathname.endsWith("/model.json"))
  ) {
    return;
  }

  // Navigation and model.json: try network first for fresh updates, fall back to cache when offline.
  if (req.mode === "navigate" || url.pathname.endsWith("/model.json")) {
    event.respondWith(
      fetch(req)
        .then(async (res) => {
          if (res.ok) {
            const cache = await caches.open(CACHE_NAME);
            cache
              .put(req.mode === "navigate" ? "/index.html" : url.pathname, cleanResponse(res.clone()))
              .catch(() => {});
          }
          return res;
        })
        .catch(async () => {
          const cache = await caches.open(CACHE_NAME);
          const hit =
            (await cache.match(url.pathname)) ||
            (req.mode === "navigate" ? (await cache.match("/index.html")) || (await cache.match("/")) : undefined);
          if (hit) return hit;
          throw new Error("Offline");
        }),
    );
    return;
  }

  // App shell assets (JS, workers, .mjs, CSS, fonts, icons): Cache-First.
  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      const hit = (await cache.match(url.pathname)) || (await cache.match(req));
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) cache.put(url.pathname, cleanResponse(res.clone())).catch(() => {});
      return res;
    }),
  );
});
`;
      writeFileSync(join(outDir, "sw.js"), sw, "utf8");
    },
  });

  return {
    plugins: [react(), tailwindcss(), remoteWasm(), offlineSw()],
    define: { __APP_VERSION__: JSON.stringify(version), __BUILD_ID__: JSON.stringify(buildId) },
    server: { headers: isolation, https, host: !!https },
    preview: { headers: isolation, https, host: !!https },
    optimizeDeps: { exclude: ["onnxruntime-web"] },
    worker: { format: "es", plugins: () => [remoteWasm()] },
    build: { target: "es2022", assetsInlineLimit: 0 },
  };
});
