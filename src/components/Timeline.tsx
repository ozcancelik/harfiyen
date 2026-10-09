import { useEffect, useRef } from "react";
import type { Cue } from "../lib/cues";
import { clock } from "../lib/format";
import type { LiveMeter } from "../render/aura";
import { PEAK_STEP } from "../worker/protocol";

/**
 * Editor timeline drawn on one canvas at display refresh rate.
 *
 * - File: the whole recording. The waveform grows in behind a softly
 *   animated "decoded" frontier; caption blocks sit underneath; the playhead
 *   reads the media clock every frame.
 * - Recording: a voice-memo strip fed straight from the microphone meter.
 *   Bars enter on the right and, once the strip is full, scroll left.
 *
 * Nothing is drawn while nothing changes.
 */
export function Timeline({
  peaks,
  duration,
  decoded,
  time,
  media,
  cues,
  live,
  onSeek,
}: {
  peaks: Float32Array;
  duration: number;
  decoded: number;
  /** Fallback clock when there is no media element. */
  time: number;
  media: HTMLMediaElement | null;
  cues: Cue[];
  /** Microphone meter while recording. */
  live: LiveMeter | null;
  onSeek: (t: number) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const total = Math.max(duration, decoded, peaks.length * PEAK_STEP, 1);

  // Latest props for the animation loop, which never restarts.
  const props = useRef({ peaks, total, decoded, time, media, cues, live });
  props.current = { peaks, total, decoded, time, media, cues, live };

  useEffect(() => {
    const c = canvas.current!;
    const g = c.getContext("2d")!;
    const css = getComputedStyle(c);
    const color = (n: string) => css.getPropertyValue(n).trim();
    const C = {
      wave: color("--wave"),
      played: color("--wave-played"),
      empty: color("--line"),
      cue: color("--raised"),
      cueOn: color("--cini"),
      rec: color("--mercan"),
    };
    let raf = 0;
    let shown = props.current.decoded; // animated frontier
    let lastKey = "";

    const draw = () => {
      raf = requestAnimationFrame(draw);
      const p = props.current;
      const dpr = window.devicePixelRatio || 1;
      const w = c.clientWidth;
      const h = c.clientHeight;
      if (!w || !h) return;

      shown += (p.decoded - shown) * 0.12;
      if (Math.abs(p.decoded - shown) < 0.005) shown = p.decoded;
      const t = p.media && !p.live ? p.media.currentTime : p.time;
      const now = performance.now();
      const key = p.live
        ? `live${now}`
        : `${w}x${h}|${dpr}|${shown}|${t}|${p.peaks.length}|${p.total}|${p.cues.length}`;
      if (key === lastKey) return;
      lastKey = key;

      if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
        c.width = Math.round(w * dpr);
        c.height = Math.round(h * dpr);
      }
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, h);

      const waveH = h - 14;
      const mid = 4 + waveH / 2;
      const bar = 2;
      const step = 3;
      const amp = (peak: number) => Math.max(1, Math.min(1, Math.sqrt(peak)) * (waveH / 2 - 2));
      const drawBar = (x: number, a: number) => {
        g.beginPath();
        g.roundRect(x, mid - a, bar, a * 2, 1);
        g.fill();
      };

      if (p.live) {
        // Voice-memo strip: 0.1 s per bar, newest on the right.
        const m = p.live;
        const elapsed = (now - m.startedAt) / 1000;
        const pps = step / m.chunkSeconds;
        const offset = Math.min(0, w - 8 - elapsed * pps);
        g.fillStyle = C.wave;
        const first = Math.max(0, Math.floor(-offset / step) - 1);
        for (let i = first; i < m.peaks.length; i++) {
          const x = offset + i * step;
          if (x > w) break;
          // The newest bar eases in instead of popping.
          const age = elapsed - (i + 1) * m.chunkSeconds;
          const grow = Math.min(1, Math.max(0.2, 1 + age / 0.12));
          drawBar(x, amp(m.peaks[i]) * grow);
        }
        const head = Math.min(w - 6, offset + elapsed * pps);
        g.fillStyle = C.rec;
        g.fillRect(head, 2, 2, h - 4);
        return;
      }

      const total = p.total;
      const frontier = Math.min(w, (shown / total) * w);
      const playX = (t / total) * w;
      for (let x = 0; x < w; x += step) {
        if (x >= frontier) {
          g.fillStyle = C.empty;
          g.fillRect(x, mid - 0.5, bar, 1);
          continue;
        }
        const t0 = (x / w) * total;
        const t1 = ((x + step) / w) * total;
        let pk = 0;
        for (let k = Math.floor(t0 / PEAK_STEP); k < Math.ceil(t1 / PEAK_STEP) && k < p.peaks.length; k++) {
          pk = Math.max(pk, p.peaks[k]);
        }
        // Bars just behind the frontier grow up as it passes.
        const d = (frontier - x) / 36;
        const grow = d >= 1 ? 1 : d * d * (3 - 2 * d);
        g.fillStyle = x < playX ? C.played : C.wave;
        drawBar(x, Math.max(1, amp(pk) * grow));
      }

      // Caption blocks.
      for (const cue of p.cues) {
        const x0 = (cue.start / total) * w;
        const x1 = Math.max(x0 + 2, (cue.end / total) * w);
        g.fillStyle = t >= cue.start && t <= cue.end + 0.3 ? C.cueOn : C.cue;
        g.beginPath();
        g.roundRect(x0, h - 8, x1 - x0, 5, 2);
        g.fill();
      }

      if (t > 0 || p.media) {
        g.fillStyle = "#fff";
        g.fillRect(Math.min(w - 2, Math.max(0, playX - 1)), 0, 2, h);
      }
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  const seekAt = (clientX: number) => {
    if (live) return;
    const r = canvas.current!.getBoundingClientRect();
    onSeek(Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * total);
  };

  return (
    <div
      className={`timeline${live ? " timeline--live" : ""}`}
      role="slider"
      tabIndex={live ? -1 : 0}
      aria-label="Zaman çizelgesi"
      aria-valuemin={0}
      aria-valuemax={Math.round(total)}
      aria-valuenow={Math.round(time)}
      aria-valuetext={clock(time)}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        seekAt(e.clientX);
      }}
      onPointerMove={(e) => e.buttons === 1 && seekAt(e.clientX)}
      onKeyDown={(e) => {
        if (live) return;
        if (e.key === "ArrowRight") onSeek(Math.min(total, time + 5));
        else if (e.key === "ArrowLeft") onSeek(Math.max(0, time - 5));
        else return;
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      <canvas ref={canvas} className="timeline__canvas" />
    </div>
  );
}
