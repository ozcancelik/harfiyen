import { useCallback, useEffect, useRef, useState } from "react";
import type { CaptionSettings } from "../captions/style";
import type { Word } from "../engine";
import type { FromRender, ToRender } from "../worker/render.worker";

export type BurnState =
  | { status: "idle" }
  | { status: "running"; progress: number; fps: number }
  | { status: "done"; url: string; size: number; elapsed: number }
  | { status: "error"; message: string };

/** Writes captions into the video in a dedicated WebGPU worker. */
export function useBurner() {
  const worker = useRef<Worker | null>(null);
  const jobId = useRef(0);
  const [state, setState] = useState<BurnState>({ status: "idle" });

  const ensureWorker = useCallback(() => {
    if (worker.current) return worker.current;
    const w = new Worker(new URL("../worker/render.worker.ts", import.meta.url), { type: "module" });
    w.onmessage = (ev: MessageEvent<FromRender>) => {
      const m = ev.data;
      if (m.jobId !== jobId.current) return;
      switch (m.type) {
        case "progress":
          setState({ status: "running", progress: m.progress, fps: m.fps });
          break;
        case "done":
          setState({ status: "done", url: URL.createObjectURL(m.blob), size: m.blob.size, elapsed: m.elapsed });
          break;
        case "cancelled":
          setState({ status: "idle" });
          break;
        case "error":
          setState({ status: "error", message: m.message });
          break;
      }
    };
    worker.current = w;
    return w;
  }, []);

  useEffect(() => () => worker.current?.terminate(), []);

  // Free the previous result when it is replaced.
  const url = state.status === "done" ? state.url : null;
  useEffect(() => () => void (url && URL.revokeObjectURL(url)), [url]);

  const burn = useCallback(
    (file: File, words: Word[], settings: CaptionSettings, bands: Float32Array) => {
      const id = ++jobId.current;
      setState({ status: "running", progress: 0, fps: 0 });
      const msg: ToRender = { type: "burn", jobId: id, file, words, settings, bands };
      ensureWorker().postMessage(msg);
    },
    [ensureWorker],
  );

  const cancel = useCallback(() => {
    worker.current?.postMessage({ type: "cancel", jobId: jobId.current } satisfies ToRender);
    jobId.current++;
    setState({ status: "idle" });
  }, []);

  const reset = useCallback(() => setState({ status: "idle" }), []);

  return { state, burn, cancel, reset };
}
