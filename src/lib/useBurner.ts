import { useCallback, useEffect, useRef, useState } from "react";
import type { CaptionSettings } from "../captions/style";
import { userFontById } from "../captions/userFonts";
import type { Word } from "../engine";
import type { LogoLayer } from "../render/logoLayer";
import type { DubMix } from "../tts/dub";
import type { Encode, FromRender, ToRender } from "../worker/render.worker";

export type BurnState =
  | { status: "idle" }
  /** `remaining`: seconds left, once there is enough progress to tell. */
  | { status: "running"; progress: number; fps: number; remaining: number | null }
  /** `url` to download, or `saved`: the name of the file it was written into. */
  | { status: "done"; url: string | null; saved: string | null; size: number; elapsed: number }
  | { status: "error"; message: string };

type SavePicker = (options: {
  suggestedName: string;
  types: { description: string; accept: Record<string, string[]> }[];
}) => Promise<FileSystemFileHandle>;

/** Asks where to save (Chrome, Edge); null where the browser has no such dialog, undefined when the user cancelled. */
async function pickFile(name: string): Promise<FileSystemFileHandle | null | undefined> {
  const picker = (window as Window & { showSaveFilePicker?: SavePicker }).showSaveFilePicker;
  if (!picker) return null;
  try {
    return await picker({ suggestedName: name, types: [{ description: "MP4 video", accept: { "video/mp4": [".mp4"] } }] });
  } catch (e) {
    // Cancelled; any other refusal (an embedding page, say) falls back to the private disk.
    return e instanceof DOMException && e.name === "AbortError" ? undefined : null;
  }
}

/** Keeps the screen (and so the computer) awake while `on`; taken again when the tab comes back. */
function useWakeLock(on: boolean) {
  useEffect(() => {
    if (!on || !("wakeLock" in navigator)) return;
    let lock: WakeLockSentinel | null = null;
    let done = false;
    const take = async () => {
      if (document.visibilityState !== "visible" || (lock && !lock.released)) return;
      try {
        const next = await navigator.wakeLock.request("screen");
        if (done) void next.release();
        else lock = next;
      } catch {
        // Refused (battery saver, say): the render goes on, the screen may sleep.
      }
    };
    void take();
    document.addEventListener("visibilitychange", take);
    return () => {
      done = true;
      document.removeEventListener("visibilitychange", take);
      void lock?.release();
    };
  }, [on]);
}

/** Writes captions into the video in a dedicated WebGPU worker, straight to disk. */
export function useBurner() {
  const worker = useRef<Worker | null>(null);
  const jobId = useRef(0);
  const startedAt = useRef(0);
  const [state, setState] = useState<BurnState>({ status: "idle" });

  const ensureWorker = useCallback(() => {
    if (worker.current) return worker.current;
    const w = new Worker(new URL("../worker/render.worker.ts", import.meta.url), { type: "module" });
    w.onmessage = (ev: MessageEvent<FromRender>) => {
      const m = ev.data;
      if (m.jobId !== jobId.current) return;
      switch (m.type) {
        case "progress": {
          // Time left from the pace so far, once past the first few seconds (encoders warm up).
          const elapsed = (performance.now() - startedAt.current) / 1000;
          const remaining = m.progress > 0.01 && elapsed > 5 ? (elapsed * (1 - m.progress)) / m.progress : null;
          setState({ status: "running", progress: m.progress, fps: m.fps, remaining });
          break;
        }
        case "done":
          setState({
            status: "done",
            url: m.file && URL.createObjectURL(m.file),
            saved: m.saved,
            size: m.size,
            elapsed: m.elapsed,
          });
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
  useWakeLock(state.status === "running");

  // Free the previous result when it is replaced.
  const url = state.status === "done" ? state.url : null;
  useEffect(() => () => void (url && URL.revokeObjectURL(url)), [url]);

  const burn = useCallback(
    async (
      file: File,
      words: Word[],
      settings: CaptionSettings,
      bands: Float32Array,
      loudness: Float32Array,
      lang: string,
      /** The speakers' names to show over the captions; null not to. */
      speakers: string[] | null,
      encode: Encode,
      dub: DubMix | null,
      logo: LogoLayer | null,
      /** The user's photo, when this project uses it in place of the aura. */
      photo: ImageBitmap | null,
      /** The user's background video file when the background media is a video. */
      photoVideo: Blob | null,
      name: string,
    ) => {
      // The dialog must open straight from the click, before anything else waits.
      const handle = await pickFile(name);
      if (handle === undefined) return;
      const id = ++jobId.current;
      startedAt.current = performance.now();
      setState({ status: "running", progress: 0, fps: 0, remaining: null });
      const userFont = userFontById(settings.font);
      // The worker gets its own copies of the logo and photo: the player keeps drawing the originals.
      const ownLogo = logo && { ...logo, image: await createImageBitmap(logo.image) };
      const ownPhoto = photo && (await createImageBitmap(photo));
      const msg: ToRender = {
        type: "burn",
        jobId: id,
        file,
        words,
        settings,
        userFont,
        bands,
        loudness,
        lang,
        speakers,
        dub,
        logo: ownLogo,
        photo: ownPhoto,
        photoVideo,
        encode,
        handle,
      };
      ensureWorker().postMessage(msg, [...(ownLogo ? [ownLogo.image] : []), ...(ownPhoto ? [ownPhoto] : [])]);
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
