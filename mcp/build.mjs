// Builds what the npm package ships: dist/server.js (the server and the app code it imports, in one file) and
// dist/render-host (the video writer's page, the one src/chrome.ts otherwise builds on first use). Run from the repo: `npm run build` in mcp/.

import { rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build as bundle } from "esbuild";
import { build as vite } from "vite";

const mcp = dirname(fileURLToPath(import.meta.url));
const repo = resolve(mcp, "..");
const dist = join(mcp, "dist");

rmSync(dist, { recursive: true, force: true });

await bundle({
  entryPoints: [join(mcp, "src", "server.ts")],
  outfile: join(dist, "server.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  // Native, or binaries found by their own path; vite is only the development fallback in chrome.ts.
  external: ["onnxruntime-node", "puppeteer-core", "ffmpeg-static", "@ffprobe-installer/ffprobe", "vite"],
  banner: { js: '#!/usr/bin/env node\nimport { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);' },
  legalComments: "none",
  logLevel: "info",
});

// Same options as builtPage() in src/chrome.ts, so the page is the one the server would have built itself.
await vite({
  root: repo,
  configFile: false,
  logLevel: "error",
  publicDir: false,
  optimizeDeps: { exclude: ["onnxruntime-web"] },
  worker: { format: "es" },
  build: {
    outDir: join(dist, "render-host"),
    emptyOutDir: true,
    target: "es2022",
    assetsInlineLimit: 0,
    rollupOptions: { input: join(mcp, "render-host", "index.html") },
  },
});
