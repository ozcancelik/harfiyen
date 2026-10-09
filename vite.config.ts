import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv, type Plugin } from "vite";

// Cross-origin isolation lets onnxruntime-web use SharedArrayBuffer
// (multi-threaded wasm). Production hosting needs the same two headers.
const isolation = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

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

  return {
    plugins: [react(), remoteWasm()],
    server: { headers: isolation },
    preview: { headers: isolation },
    optimizeDeps: { exclude: ["onnxruntime-web"] },
    worker: { format: "es", plugins: () => [remoteWasm()] },
    build: { target: "es2022", assetsInlineLimit: 0 },
  };
});
