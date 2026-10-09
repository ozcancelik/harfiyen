import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Cross-origin isolation lets onnxruntime-web use SharedArrayBuffer
// (multi-threaded wasm). Production hosting needs the same two headers.
const isolation = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

export default defineConfig({
  plugins: [react()],
  server: { headers: isolation },
  preview: { headers: isolation },
  optimizeDeps: { exclude: ["onnxruntime-web"] },
  worker: { format: "es" },
  build: { target: "es2022", assetsInlineLimit: 0 },
});
