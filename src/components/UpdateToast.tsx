import { useEffect, useState } from "react";
import { IconClose } from "./icons";

/**
 * Shown when a service worker from a newer build takes over a page that runs
 * older code. Reloading is the user's call: a running transcription would be
 * lost.
 */
export function UpdateToast({ busy }: { busy: boolean }) {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    // A worker announces its build once it takes over. A page that already
    // runs that build (a cold start after a deploy) needs no reload.
    const onMessage = (e: MessageEvent) => {
      if (e.data?.type === "sw-build" && e.data.id !== __BUILD_ID__) setReady(true);
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, []);

  if (!ready) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 top-3 z-50 flex justify-center px-4">
      <div
        role="status"
        className="pointer-events-auto flex max-w-full items-center gap-3 rounded-full border border-popover-line bg-popover py-1.5 pr-1.5 pl-4 text-[13px] text-fg shadow-[0_8px_30px_rgba(0,0,0,0.35)]"
      >
        <span className="size-2 flex-none rounded-full bg-firuze shadow-[0_0_8px_rgba(54,194,180,0.7)]" aria-hidden />
        <span className="min-w-0">
          <span className="font-medium text-fg-strong">Yeni sürüm hazır</span>
          {busy && <span className="text-fg-3"> · işlem sürüyor, yenileyince kesilir</span>}
        </span>
        <button
          type="button"
          className="flex-none rounded-full border-0 bg-cini px-3.5 py-1.5 font-medium text-white transition-colors hover:bg-cini-press"
          onClick={() => location.reload()}
        >
          Yenile
        </button>
        <button
          type="button"
          className="-ml-1 flex size-7 flex-none items-center justify-center rounded-full border-0 bg-raised p-0 text-fg transition-colors hover:bg-raised-hover hover:text-fg-strong"
          aria-label="Kapat"
          onClick={() => setReady(false)}
        >
          <IconClose size={14} />
        </button>
      </div>
    </div>
  );
}
