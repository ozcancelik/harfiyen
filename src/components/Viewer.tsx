import { useEffect, useMemo, useRef, useState } from "react";
import { loadCaptionFont } from "../captions/fonts";
import { CaptionRenderer } from "../captions/renderer";
import type { CaptionSettings } from "../captions/style";
import type { Word } from "../engine";
import { clock } from "../lib/format";
import type { Player } from "../lib/usePlayer";
import { levelsAt, paletteById, type AuraFrame, type AuraLevels } from "../render/aura";
import { createCompositor, type Compositor } from "../render/compositor";
import { IconCollapse, IconExpand, IconPause, IconPlay } from "./icons";

/** Audio files get a 16:9 black frame so captions can still be previewed. */
const AUDIO_FRAME = { w: 1920, h: 1080 };

/**
 * The player. The media element only decodes and plays sound; the picture
 * and the caption are drawn by the same compositor that burns captions into
 * the exported video (WebGPU, with a 2D fallback). Going fullscreen enlarges
 * this whole stage, so captions stay visible.
 */
export function Viewer({
  player,
  words,
  settings,
  liveTime = null,
  liveLevels,
  bands,
  children,
}: {
  /** Raw microphone levels while recording (updated in place). */
  liveLevels?: React.RefObject<AuraLevels | null>;
  /** Aura band levels, for audio-only projects. */
  bands: Float32Array;
  player: Player;
  words: Word[];
  settings: CaptionSettings;
  /** Live microphone: show the caption at this time, with no media element. */
  liveTime?: number | null;
  /** Shown instead of the picture when no file is open. */
  children?: React.ReactNode;
}) {
  const stage = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [compositor, setCompositor] = useState<Compositor | null>(null);
  const [frame, setFrame] = useState(AUDIO_FRAME);
  const [fontTick, setFontTick] = useState(0);
  const [fullscreen, setFullscreen] = useState(false);
  const [idle, setIdle] = useState(false);
  const { el, isVideo, url } = player;
  const live = !url && liveTime !== null;
  const active = !!url || live;
  const liveRef = useRef(0);
  liveRef.current = liveTime ?? 0;
  const bandsRef = useRef(bands);
  bandsRef.current = bands;
  const paletteRef = useRef(paletteById(settings.aura).colors);
  paletteRef.current = paletteById(settings.aura).colors;

  // One compositor per canvas.
  useEffect(() => {
    if (!active) return;
    let c: Compositor | null = null;
    let live = true;
    createCompositor(canvas.current!).then((x) => {
      if (live) setCompositor((c = x));
      else x.destroy();
    });
    return () => {
      live = false;
      c?.destroy();
      setCompositor(null);
    };
  }, [active, url]);

  useEffect(() => {
    let live = true;
    loadCaptionFont(settings.font, document.fonts).then(() => live && setFontTick((n) => n + 1));
    return () => {
      live = false;
    };
  }, [settings.font]);

  useEffect(() => {
    if (!el || !isVideo) {
      setFrame(AUDIO_FRAME);
      return;
    }
    const v = el as HTMLVideoElement;
    const update = () => v.videoWidth && setFrame({ w: v.videoWidth, h: v.videoHeight });
    update();
    v.addEventListener("loadedmetadata", update);
    return () => v.removeEventListener("loadedmetadata", update);
  }, [el, isVideo]);

  const captions = useMemo(
    () => (words.length ? new CaptionRenderer(words, settings, frame.w, frame.h) : null),
    // fontTick: lay out again once the font file has loaded.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [words, settings, frame, fontTick],
  );

  // The loop reads these through refs, so new words (every progress update)
  // never restart it; restarting would reset the aura's clock and stutter.
  const captionsRef = useRef(captions);
  captionsRef.current = captions;
  const auraClock = useRef(performance.now());
  const smooth = useRef<AuraLevels>({ low: 0, mid: 0, high: 0 });

  // Render loop: redraw only when the picture, caption or size changed.
  useEffect(() => {
    const c = canvas.current;
    const st = stage.current;
    if (!compositor || !c || !st || (!el && !live)) return;
    let raf = 0;
    let last = "";
    const loop = () => {
      const dpr = window.devicePixelRatio || 1;
      const fit = Math.min(1, (st.clientWidth * dpr) / frame.w, (st.clientHeight * dpr) / frame.h);
      const w = Math.max(2, Math.round(frame.w * fit));
      const h = Math.max(2, Math.round(frame.h * fit));
      const t = el && !live ? el.currentTime : liveRef.current;
      const cap = captionsRef.current?.frame(t) ?? null;
      // Audio-only: the aura. It follows the media clock (so the export
      // matches); while recording it drifts with the wall clock instead.
      let aura: AuraFrame | null = null;
      if (!isVideo || live) {
        let levels = levelsAt(bandsRef.current, t);
        const raw = live ? liveLevels?.current : null;
        if (raw) {
          // Mic levels arrive every ~100 ms; ease towards them every frame.
          const sm = smooth.current;
          for (const k of ["low", "mid", "high"] as const) {
            sm[k] += (raw[k] - sm[k]) * (raw[k] > sm[k] ? 0.35 : 0.08);
          }
          levels = { ...sm };
        }
        aura = {
          kind: "aura",
          time: live ? (performance.now() - auraClock.current) / 1000 : t,
          levels,
          palette: paletteRef.current,
        };
      }
      const key = aura
        ? `${w}x${h}|${aura.time}|${aura.palette}|${bandsRef.current.length}|${cap ? `${cap.key}|${cap.scale}` : ""}`
        : `${w}x${h}|${t}|${el?.readyState}|${cap ? `${cap.key}|${cap.scale}` : ""}`;
      if (key !== last) {
        last = key;
        compositor.resize(w, h);
        compositor.render(aura ?? (isVideo && el ? (el as HTMLVideoElement) : null), cap);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [compositor, el, isVideo, frame, live, liveLevels]);

  useEffect(() => {
    const on = () => setFullscreen(document.fullscreenElement === stage.current);
    document.addEventListener("fullscreenchange", on);
    return () => document.removeEventListener("fullscreenchange", on);
  }, []);

  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void stage.current?.requestFullscreen();
  };

  // Keyboard: space play/pause, arrows seek, F fullscreen.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (!url || t.closest("input, textarea, select, [contenteditable]") || e.metaKey || e.ctrlKey) return;
      if (e.key === " " && !t.closest("button")) player.toggle();
      else if (e.key === "ArrowLeft" && !t.closest("[role=slider]")) player.seek(player.time - 5);
      else if (e.key === "ArrowRight" && !t.closest("[role=slider]")) player.seek(player.time + 5);
      else if (e.key === "f" || e.key === "F") toggleFullscreen();
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // Hide the fullscreen controls while the pointer rests.
  useEffect(() => {
    if (!fullscreen) return;
    let timer = 0;
    const wake = () => {
      setIdle(false);
      clearTimeout(timer);
      timer = window.setTimeout(() => setIdle(true), 2200);
    };
    wake();
    const st = stage.current!;
    st.addEventListener("pointermove", wake);
    return () => {
      clearTimeout(timer);
      st.removeEventListener("pointermove", wake);
    };
  }, [fullscreen]);

  return (
    <div
      ref={stage}
      className={`stage${fullscreen ? " stage--fullscreen" : ""}${fullscreen && idle && player.playing ? " stage--idle" : ""}`}
    >
      {live ? (
        <>
          <canvas ref={canvas} className="stage__canvas" aria-label="Canlı altyazı" />
          {!words.length && (
            <p className="stage__note stage__note--live">
              <span className="rec-dot" aria-hidden /> Dinleniyor, konuşmaya başlayabilirsin
            </p>
          )}
        </>
      ) : url ? (
        <>
          {isVideo ? (
            <video ref={player.ref} src={url} className="media-source" playsInline preload="auto" />
          ) : (
            <audio ref={player.ref} src={url} className="media-source" preload="auto" />
          )}
          <canvas
            ref={canvas}
            className="stage__canvas"
            onClick={player.toggle}
            onDoubleClick={toggleFullscreen}
            aria-label={player.playing ? "Duraklat" : "Oynat"}
          />
          <div className="stage__hud">
            <button className="hud-btn" onClick={player.toggle} aria-label={player.playing ? "Duraklat" : "Oynat"}>
              {player.playing ? <IconPause /> : <IconPlay />}
            </button>
            <span className="hud-time">
              {clock(player.time)} / {clock(player.duration)}
            </span>
            {fullscreen && (
              <input
                className="hud-seek"
                type="range"
                min={0}
                max={player.duration || 1}
                step={0.01}
                value={player.time}
                onChange={(e) => player.seek(Number(e.target.value))}
                aria-label="Konum"
              />
            )}
            <button
              className="hud-btn hud-btn--end"
              onClick={toggleFullscreen}
              aria-label={fullscreen ? "Tam ekrandan çık" : "Tam ekran"}
              title="Tam ekran (F)"
            >
              {fullscreen ? <IconCollapse /> : <IconExpand />}
            </button>
          </div>
        </>
      ) : (
        children
      )}
    </div>
  );
}
