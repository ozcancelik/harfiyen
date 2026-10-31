import { useEffect } from "react";

const SIZE = 64;
const TRACK = "#2a3039";
const ARC = "#476de6";
const DONE = "#3fb68b";

/** One ring on a dark tile; `null` draws the finished tick instead. */
function icon(percent: number | null): string {
  const c = document.createElement("canvas");
  c.width = c.height = SIZE;
  const g = c.getContext("2d")!;
  g.fillStyle = "#16191d";
  g.beginPath();
  g.roundRect(0, 0, SIZE, SIZE, 14);
  g.fill();
  g.lineWidth = 9;
  g.lineCap = "round";
  g.strokeStyle = percent === null ? DONE : TRACK;
  g.beginPath();
  g.arc(SIZE / 2, SIZE / 2, 21, 0, Math.PI * 2);
  g.stroke();
  if (percent === null) {
    g.beginPath();
    g.moveTo(21, 33);
    g.lineTo(29, 41);
    g.lineTo(43, 24);
    g.stroke();
  } else if (percent > 0) {
    g.strokeStyle = ARC;
    g.beginPath();
    g.arc(SIZE / 2, SIZE / 2, 21, -Math.PI / 2, -Math.PI / 2 + (Math.PI * 2 * percent) / 100);
    g.stroke();
  }
  return c.toDataURL("image/png");
}

let baseTitle: string | null = null;
let baseIcons: HTMLLinkElement[] = [];
/** The icon this hook put in place of the page's own, if any. */
let shownIcon: HTMLLinkElement | null = null;
let stopWaiting: (() => void) | null = null;

function show(href: string | null, title: string | null) {
  if (baseTitle === null) {
    baseTitle = document.title;
    baseIcons = [...document.querySelectorAll<HTMLLinkElement>('link[rel="icon"]')];
  }
  shownIcon?.remove();
  shownIcon = null;
  if (href !== null) {
    for (const l of baseIcons) l.remove();
    shownIcon = document.createElement("link");
    shownIcon.rel = "icon";
    shownIcon.type = "image/png";
    shownIcon.href = href;
    document.head.append(shownIcon);
  } else {
    document.head.append(...baseIcons.filter((l) => !l.isConnected));
  }
  document.title = title ?? baseTitle;
}

/**
 * Shows a job's progress on the browser tab (a ring in the favicon and the
 * percent in the title), so it can be followed from another tab. `percent` is
 * 0-100 while running and `null` otherwise; a job that ends while the tab is
 * hidden leaves a tick and "Hazır" until the tab is looked at again.
 */
export function useTabProgress(percent: number | null) {
  const whole = percent === null ? null : Math.min(100, Math.max(0, Math.floor(percent)));

  useEffect(() => {
    if (whole === null) return;
    stopWaiting?.();
    show(icon(whole), `%${whole} · Harfiyen`);
  }, [whole]);

  const running = whole !== null;
  useEffect(() => {
    if (!running) return;
    return () => {
      if (document.visibilityState === "visible") return show(null, null);
      show(icon(null), "Hazır · Harfiyen");
      const back = () => {
        if (document.visibilityState !== "visible") return;
        stopWaiting?.();
        show(null, null);
      };
      stopWaiting = () => {
        document.removeEventListener("visibilitychange", back);
        stopWaiting = null;
      };
      document.addEventListener("visibilitychange", back);
    };
  }, [running]);
}
