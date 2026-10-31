import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { loadCaptionFont } from "../captions/fonts";
import { CaptionRenderer } from "../captions/renderer";
import { shownPhoto, shownPicture, type CaptionSettings } from "../captions/style";
import type { Word } from "../engine";
import { ASPECTS, cropFor, dragCrop, framing, wholeCrop, type Aspect, type Crop } from "../lib/crop";
import { clock } from "../lib/format";
import type { Player } from "../lib/usePlayer";
import {
  historyAt,
  levelsAt,
  LiveHistory,
  paletteById,
  RelativeLevels,
  usesHistory,
  type AuraFrame,
  type AuraLevels,
} from "../render/aura";
import { createCompositor, type Compositor, type PhotoFrame } from "../render/compositor";
import { backdropFor, KineticRenderer } from "../render/kinetic";
import type { LogoLayer } from "../render/logoLayer";
import { CropOverlay } from "./CropOverlay";
import { IconCollapse, IconCrop, IconExpand, IconPause, IconPlay } from "./icons";
import { RecDot } from "./Indicators";

/** The media element only decodes; the picture is drawn on the canvas. */
const MEDIA = "pointer-events-none absolute size-px opacity-0";
const HUD_BTN = "grid size-[30px] place-items-center rounded-full border-0 bg-white/14 text-white hover:bg-white/26";

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
  loudness,
  speakers,
  children,
  notice,
  lang,
  following = false,
  crop = null,
  onCrop,
  cropLocked = false,
  logo = null,
  photo = null,
  photoVideo = null,
  size = null,
}: {
  /** Raw microphone levels while recording (updated in place). */
  liveLevels?: React.RefObject<AuraLevels | null>;
  /** Aura band levels, for audio-only projects. */
  bands: Float32Array;
  /** Speech loudness, for "Sesle vurgula". */
  loudness: Float32Array;
  /** The speakers' names to show over the captions; null not to. */
  speakers: string[] | null;
  player: Player;
  words: Word[];
  settings: CaptionSettings;
  /** Live microphone: show the caption at this time, with no media element. */
  liveTime?: number | null;
  /** Shown instead of the picture when no file is open. */
  children?: React.ReactNode;
  /** Shown over the picture when it cannot be shown (a codec this browser cannot decode). */
  notice?: React.ReactNode;
  /** Language of the words; decides how they are uppercased. */
  lang: string;
  /** The preview follows a running transcription (see useFollow). */
  following?: boolean;
  /** How the video picture is framed; ignored for audio. */
  crop?: Crop | null;
  /** Frame the video from the player (the crop button); missing hides it. */
  onCrop?: (c: Crop | null) => void;
  /** An export is running: the framing cannot change. */
  cropLocked?: boolean;
  /** The user's logo in its corner; null for none. */
  logo?: LogoLayer | null;
  /** The user's photo, drawn in place of the aura when the settings pick it; null when there is none. */
  photo?: ImageBitmap | null;
  /** Object URL of the user's background video, when the background media is a video. */
  photoVideo?: string | null;
  /** The size the video is written at, when known; the preview draws at it. */
  size?: { w: number; h: number } | null;
}) {
  const stage = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [compositor, setCompositor] = useState<Compositor | null>(null);
  const [bgVideo, setBgVideo] = useState<HTMLVideoElement | null>(null);
  /** The video's own size; the frame drawn is the cropped part of it. */
  const [picture, setPicture] = useState(AUDIO_FRAME);
  const [fontTick, setFontTick] = useState(0);
  const [fullscreen, setFullscreen] = useState(false);
  const [idle, setIdle] = useState(false);
  /** The framing being edited on the player; null when not cropping. */
  const [draft, setDraft] = useState<Crop | null>(null);
  /** Aspect picker pill shown on the player for audio-only / mic / TTS projects. */
  const [pickingAspect, setPickingAspect] = useState(false);
  const [stageSize, setStageSize] = useState({ w: 0, h: 0 });
  const { el, isVideo, url } = player;
  const live = !url && liveTime !== null;
  const active = !!url || live;
  const liveRef = useRef(0);
  liveRef.current = liveTime ?? 0;
  const bandsRef = useRef(bands);
  bandsRef.current = bands;
  const paletteRef = useRef(paletteById(settings.aura).colors);
  paletteRef.current = paletteById(settings.aura).colors;
  const auraStyleRef = useRef(settings.auraStyle ?? "aura");
  auraStyleRef.current = settings.auraStyle ?? "aura";

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

  const activeFont = settings.kinetic?.on ? settings.kinetic.font : settings.font;
  const activeItalic = !settings.kinetic?.on && !!settings.italic;
  useEffect(() => {
    let live = true;
    loadCaptionFont(activeFont, document.fonts, activeItalic).then(() => live && setFontTick((n) => n + 1));
    return () => {
      live = false;
    };
  }, [activeFont, activeItalic]);

  useEffect(() => {
    if (!el || !isVideo) {
      setPicture(AUDIO_FRAME);
      return;
    }
    const v = el as HTMLVideoElement;
    const update = () => v.videoWidth && setPicture({ w: v.videoWidth, h: v.videoHeight });
    update();
    v.addEventListener("loadedmetadata", update);
    return () => v.removeEventListener("loadedmetadata", update);
  }, [el, isVideo]);

  // The video's picture as drawn: null when there is none, or it is left out (the file used for its sound).
  const shownPic = shownPicture(settings, isVideo && !live);
  // Without one, the user's photo may stand in for the aura; the ground is whichever of the two is drawn.
  const photoPic = shownPic ? null : shownPhoto(settings, !!photo);
  const ground = shownPic ?? photoPic;
  const ownPicture = isVideo && !live && picture !== AUDIO_FRAME;
  // A video used for its sound is framed as an audio stage is: its aura in a frame of the shape picked.
  const hasPicture = ownPicture && !!shownPic;
  const canCrop = (hasPicture || !!url || live) && !!onCrop;
  const shown = hasPicture ? (draft ?? crop) : crop;
  // While a slice is being placed the whole picture shows, the slice marked over it; a fitted picture shows as it comes out.
  const placing = hasPicture && !!draft && (draft.fit === "fill" || draft.aspect === "free");
  const framed = useMemo(
    () => (shown && !placing ? framing(shown, picture.w, picture.h) : null),
    [shown, placing, picture],
  );
  const view = framed && !framed.none ? framed : null;
  const placement = hasPicture ? (view?.placement ?? null) : null;
  // Captions and audio stages are laid out on the frame, as in the export: at the size it is written at,
  // so a small video made at 1080p shows its captions as sharp as they come out. Not while cropping
  // (the size follows the crop once it is kept), nor while that size is still of the last frame's shape.
  const ownW = view ? view.size.width : picture.w;
  const ownH = view ? view.size.height : picture.h;
  const sized = ownPicture && !draft && size && Math.abs(size.w / size.h - ownW / ownH) < 0.01 ? size : null;
  const fw = sized ? sized.w : ownW;
  const fh = sized ? sized.h : ownH;
  const frame = useMemo(() => ({ w: fw, h: fh }), [fw, fh]);

  useEffect(() => compositor?.setPlacement(placement), [compositor, placement]);
  // Not while cropping: the frame is still being decided.
  const shownLogo = draft ? null : logo;
  useEffect(() => compositor?.setLogo(shownLogo), [compositor, shownLogo]);

  // Where the canvas shows on the stage (object-contain), for the crop overlay.
  useEffect(() => {
    const st = stage.current;
    if (!st) return;
    const ro = new ResizeObserver(() => setStageSize({ w: st.clientWidth, h: st.clientHeight }));
    ro.observe(st);
    return () => ro.disconnect();
  }, []);
  const fitScale = Math.min(stageSize.w / frame.w, stageSize.h / frame.h) || 0;
  const shownRect = {
    width: frame.w * fitScale,
    height: frame.h * fitScale,
    left: (stageSize.w - frame.w * fitScale) / 2,
    top: (stageSize.h - frame.h * fitScale) / 2,
  };

  const startCrop = () => {
    if (!canCrop || cropLocked) return;
    if (!hasPicture) {
      setPickingAspect((v) => !v);
      return;
    }
    setDraft(crop ?? cropFor("9:16", picture.w, picture.h));
  };
  const pickAudioAspect = (aspect: Aspect) => {
    if (aspect === "16:9" || aspect === "free") onCrop?.(null);
    else onCrop?.({ ...wholeCrop(aspect), fit: "fit" });
  };
  const finishCrop = () => {
    if (!draft) return;
    onCrop?.(framing(draft, picture.w, picture.h).none ? null : draft);
    setDraft(null);
  };
  // A new file, or an export starting, ends the editing without a change.
  useEffect(() => {
    setDraft(null);
    setPickingAspect(false);
  }, [url, cropLocked]);

  // A video's kinetic stage goes over its picture (or its plain ground); an audio project's over the aura or the photo.
  const kineticSettings = useMemo(
    () => settings.kinetic && { ...settings.kinetic, backdrop: backdropFor(settings.kinetic, ground) },
    [settings.kinetic, ground],
  );
  // The stage (and the captions it replaces) follows in a deferred render: building it can take a
  // moment (Fizik works out its whole fall), so the switch shows at once, with "Hazırlanıyor…".
  const stageSettings = useDeferredValue(kineticSettings);
  // Only for what builds a stage anew (palette and font are quick): shown at once, since a delay
  // could not run out while the build holds the page.
  const preparing =
    stageSettings !== kineticSettings &&
    !!kineticSettings?.on &&
    (!stageSettings?.on || stageSettings.style !== kineticSettings.style);
  const useKinetic = !!stageSettings?.on;
  const captions = useMemo(
    () =>
      // No caption while cropping: the frame is still being decided.
      words.length && !draft && !useKinetic
        ? new CaptionRenderer(words, settings, frame.w, frame.h, settings.voiceEmphasis ? loudness : null, lang, speakers)
        : null,
    // fontTick: lay out again once the font file has loaded. Loudness only matters with voiceEmphasis.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [words, settings, frame, fontTick, settings.voiceEmphasis ? loudness : null, lang, speakers, !draft, useKinetic],
  );
  const kinetic = useMemo(
    () =>
      words.length && !draft && useKinetic && stageSettings
        ? new KineticRenderer(words, stageSettings, frame.w, frame.h, loudness, lang, speakers)
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [words, stageSettings, frame, fontTick, loudness, lang, speakers, !draft, useKinetic],
  );
  const blurred = ground === "blur";
  useEffect(() => compositor?.setBlur(blurred), [compositor, blurred]);

  // The loop reads these through refs, so new words (every progress update)
  // never restart it; restarting would reset the aura's clock and stutter.
  const captionsRef = useRef(captions);
  captionsRef.current = captions;
  const kineticRef = useRef(kinetic);
  kineticRef.current = kinetic;
  const auraClock = useRef(performance.now());
  const smooth = useRef<AuraLevels>({ low: 0, mid: 0, high: 0 });
  const slowEnergy = useRef(0);
  const relativeLive = useRef(new RelativeLevels());
  const lastLive = useRef(performance.now());
  const liveHistory = useRef(new LiveHistory());

  // Keep the looping muted background video in sync with the main media clock.
  useEffect(() => {
    if (!bgVideo || !photoPic) return;
    bgVideo.muted = true;
    bgVideo.loop = true;
    if (live) {
      const startLive = () => void bgVideo.play().catch(() => {});
      startLive();
      bgVideo.addEventListener("loadedmetadata", startLive);
      return () => {
        bgVideo.removeEventListener("loadedmetadata", startLive);
        bgVideo.pause();
      };
    }
    if (!el) return;
    const syncTime = () => {
      const d = bgVideo.duration;
      if (Number.isFinite(d) && d > 0 && !bgVideo.seeking) {
        const target = el.currentTime % d;
        if (Math.abs(bgVideo.currentTime - target) > 0.08) bgVideo.currentTime = target;
      }
    };
    const onPlay = () => {
      syncTime();
      void bgVideo.play().catch(() => {});
    };
    const onPause = () => bgVideo.pause();
    const onSeeked = () => {
      if (el.paused) syncTime();
    };
    const onLoaded = () => {
      syncTime();
      if (!el.paused) void bgVideo.play().catch(() => {});
    };
    if (!el.paused) onPlay();
    else syncTime();
    bgVideo.addEventListener("loadedmetadata", onLoaded);
    el.addEventListener("play", onPlay);
    el.addEventListener("pause", onPause);
    el.addEventListener("ended", onPause);
    el.addEventListener("seeked", onSeeked);
    return () => {
      bgVideo.removeEventListener("loadedmetadata", onLoaded);
      el.removeEventListener("play", onPlay);
      el.removeEventListener("pause", onPause);
      el.removeEventListener("ended", onPause);
      el.removeEventListener("seeked", onSeeked);
      bgVideo.pause();
    };
  }, [bgVideo, el, live, photoPic, photoVideo]);

  // Render loop: redraw only when the picture, caption or size changed.
  useEffect(() => {
    const c = canvas.current;
    const st = stage.current;
    if (!compositor || !c || !st || (!el && !live)) return;
    let raf = 0;
    let last = "";
    /** A video frame has been drawn: from then on a seek keeps it up until the new one is decoded. */
    let drawn = false;
    const cropKey = `${placement ? JSON.stringify(placement) : ""}|${shownLogo ? `${shownLogo.corner}${shownLogo.size}${shownLogo.opacity}` : ""}`;
    const photoFrame: PhotoFrame | null =
      photoPic && photo ? { kind: "photo", image: photo, video: bgVideo } : null;
    const loop = () => {
      const dpr = window.devicePixelRatio || 1;
      const fit = Math.min(1, (st.clientWidth * dpr) / frame.w, (st.clientHeight * dpr) / frame.h);
      const w = Math.max(2, Math.round(frame.w * fit));
      const h = Math.max(2, Math.round(frame.h * fit));
      const t = el && !live ? el.currentTime : liveRef.current;
      // No picture (or a video used for its sound) and no photo: the aura. It follows the media clock (so
      // the export matches); while recording it drifts with the wall clock instead.
      let aura: AuraFrame | null = null;
      if (!ground) {
        let levels = levelsAt(bandsRef.current, t);
        const raw = live ? liveLevels?.current : null;
        if (raw) {
          // Mic levels arrive every ~100 ms; ease towards them every frame.
          const sm = smooth.current;
          for (const k of ["low", "mid", "high"] as const) {
            sm[k] += (raw[k] - sm[k]) * (raw[k] > sm[k] ? 0.35 : 0.08);
          }
          // Punch: how far the voice is above its own slow average.
          const e = (sm.low + sm.mid + sm.high) / 3;
          slowEnergy.current += (e - slowEnergy.current) * 0.04;
          const now = performance.now();
          const dt = Math.min(0.1, (now - lastLive.current) / 1000);
          lastLive.current = now;
          const punch = Math.min(1, Math.max(0, (e - slowEnergy.current - 0.04) * 4));
          levels = relativeLive.current.apply({ ...sm, punch }, dt);
        }
        const time = live ? (performance.now() - auraClock.current) / 1000 : t;
        // Ufuk and Sırtlar draw the last seconds: from the bands, or from what the microphone gave so far.
        let history: Float32Array | undefined;
        if (live) liveHistory.current.push(time, levels);
        if (usesHistory(auraStyleRef.current)) {
          const bands = bandsRef.current;
          history = historyAt(live ? liveHistory.current.at : (at) => levelsAt(bands, at), time);
        }
        aura = { kind: "aura", time, levels, palette: paletteRef.current, style: auraStyleRef.current, history };
      }
      const cap = kineticRef.current
        ? kineticRef.current.frame(t, aura?.levels ?? levelsAt(bandsRef.current, t))
        : (captionsRef.current?.frame(t) ?? null);
      const bgKey = bgVideo && photoFrame ? `${bgVideo.currentTime}|${bgVideo.readyState}` : "";
      const key = aura
        ? `${w}x${h}|${aura.time}|${aura.palette}|${aura.style}|${bandsRef.current.length}|${cap ? `${cap.key}|${cap.scale}` : ""}`
        : `${w}x${h}|${t}|${el?.readyState}|${bgKey}|${cropKey}|${cap ? `${cap.key}|${cap.scale}` : ""}`;
      const video = !aura && !photoFrame && isVideo && el ? (el as HTMLVideoElement) : null;
      const activeVideo = video ?? (photoFrame ? bgVideo : null);
      // While scrubbing, the element has no frame (readyState < 2) until the
      // seek lands; drawing then would flash black, so the last frame stays.
      const waiting = !!activeVideo && drawn && activeVideo.readyState < 2;
      if (key !== last && !waiting) {
        last = key;
        compositor.resize(w, h);
        compositor.render(aura ?? photoFrame ?? video, cap);
        if (activeVideo && activeVideo.readyState >= 2) drawn = true;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [compositor, el, isVideo, frame, live, liveLevels, placement, shownLogo, blurred, ground, photoPic, photo, bgVideo]);

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
      if (!url || t.closest("input, textarea, select, [contenteditable], dialog") || e.metaKey || e.ctrlKey) return;
      if (draft) {
        // Cropping: Enter keeps it, Escape drops it, arrows move the slice a pixel (ten with Shift).
        const step = e.shiftKey ? 10 : 1;
        const nudge = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
        if (e.key === "Escape") setDraft(null);
        else if (e.key === "Enter" && !t.closest("button")) finishCrop();
        else if (nudge && placing)
          setDraft(dragCrop(draft, "move", nudge[0] / picture.w, nudge[1] / picture.h, picture.w, picture.h));
        else if (e.key === " " && !t.closest("button")) player.toggle();
        else return;
        e.preventDefault();
        return;
      }
      if (e.key === " " && !t.closest("button")) player.toggle();
      else if (e.key === "Escape" && pickingAspect) setPickingAspect(false);
      else if (e.key === "ArrowLeft" && !t.closest("[role=slider]")) player.seek(player.time - 5);
      else if (e.key === "ArrowRight" && !t.closest("[role=slider]")) player.seek(player.time + 5);
      else if (e.key === "f" || e.key === "F") toggleFullscreen();
      else if ((e.key === "c" || e.key === "C") && canCrop) startCrop();
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

  const hidden = fullscreen && idle && player.playing;
  // Controls fade in on hover; always shown in fullscreen until the pointer rests.
  const hud = hidden
    ? "opacity-0"
    : fullscreen
      ? "px-6 pt-10 pb-5 opacity-100"
      : "px-3 pt-6 pb-2.5 opacity-0 group-hover/stage:opacity-100 focus-within:opacity-100";
  const canvasClass = `absolute inset-0 size-full object-contain ${hidden ? "cursor-none" : ""}`;

  return (
    <div
      ref={stage}
      // Video looks right on dark, whatever the theme; so does everything over it.
      data-theme="dark"
      className={`group/stage relative grid min-h-0 min-w-0 flex-1 place-items-center overflow-hidden bg-black group-data-dragging/shell:outline-2 group-data-dragging/shell:-outline-offset-8 group-data-dragging/shell:outline-cini group-data-dragging/shell:outline-dashed ${
        fullscreen ? "rounded-none" : "rounded-ui"
      } ${hidden ? "cursor-none" : ""}`}
    >
      {active && photoPic && photoVideo && (
        <video ref={setBgVideo} src={photoVideo} className={MEDIA} muted loop playsInline preload="auto" />
      )}
      {live ? (
        <>
          <canvas ref={canvas} className={canvasClass} aria-label="Canlı altyazı" />
          {!words.length && (
            <p className="absolute m-0 inline-flex items-center gap-2 text-fg-2">
              <RecDot /> Dinleniyor, konuşmaya başlayabilirsin
            </p>
          )}
          {canCrop && (
            <div className={`absolute inset-x-0 bottom-0 flex items-center justify-end gap-2.5 bg-linear-to-b from-transparent to-black/60 transition-opacity duration-200 ease-[ease] ${hud}`}>
              <button
                className={`${HUD_BTN} relative disabled:opacity-40`}
                onClick={startCrop}
                disabled={cropLocked}
                aria-label="Sahne oranı"
                title="Sahne oranı: 9:16, 4:5, 1:1, 16:9 (C)"
              >
                <IconCrop />
                {crop && <span className="absolute top-1 right-1 size-1.5 rounded-full bg-cini" aria-hidden />}
              </button>
            </div>
          )}
        </>
      ) : url ? (
        <>
          {isVideo ? (
            <video ref={player.ref} src={url} className={MEDIA} playsInline preload="auto" />
          ) : (
            <audio ref={player.ref} src={url} className={MEDIA} preload="auto" />
          )}
          <canvas
            ref={canvas}
            className={canvasClass}
            onClick={player.toggle}
            onDoubleClick={toggleFullscreen}
            aria-label={player.playing ? "Duraklat" : "Oynat"}
          />
          {draft && (
            <CropOverlay
              draft={draft}
              onDraft={setDraft}
              picture={picture}
              rect={shownRect}
              onDone={finishCrop}
              onCancel={() => setDraft(null)}
            />
          )}
          {!draft && (
            <div
              className={`absolute inset-x-0 bottom-0 flex items-center gap-2.5 bg-linear-to-b from-transparent to-black/60 transition-opacity duration-200 ease-[ease] motion-reduce:transition-none ${hud}`}
            >
              <button className={HUD_BTN} onClick={player.toggle} aria-label={player.playing ? "Duraklat" : "Oynat"}>
                {player.playing ? <IconPause /> : <IconPlay />}
              </button>
              <span className="text-[12px] text-white tabular-nums">
                {clock(player.time)} / {clock(player.duration)}
              </span>
              {fullscreen && (
                <input
                  className="flex-1 accent-cini"
                  type="range"
                  min={0}
                  max={player.duration || 1}
                  step={0.01}
                  value={player.time}
                  onChange={(e) => player.seek(Number(e.target.value))}
                  aria-label="Konum"
                />
              )}
              {canCrop && (
                <button
                  className={`${HUD_BTN} relative ml-auto disabled:opacity-40`}
                  onClick={startCrop}
                  disabled={cropLocked}
                  aria-label={hasPicture ? "Kırp" : "Sahne oranı"}
                  title={
                    cropLocked
                      ? "Dışa aktarma sürerken değiştirilemez"
                      : hasPicture
                        ? "Kırp ve kadrajla (C)"
                        : "Sahne oranı: 9:16, 4:5, 1:1, 16:9 (C)"
                  }
                >
                  <IconCrop />
                  {/* The video or audio stage is framed. */}
                  {crop && <span className="absolute top-1 right-1 size-1.5 rounded-full bg-cini" aria-hidden />}
                </button>
              )}
              <button
                className={`${HUD_BTN} ${canCrop ? "" : "ml-auto"}`}
                onClick={toggleFullscreen}
                aria-label={fullscreen ? "Tam ekrandan çık" : "Tam ekran"}
                title="Tam ekran (F)"
              >
                {fullscreen ? <IconCollapse /> : <IconExpand />}
              </button>
            </div>
          )}
        </>
      ) : (
        children
      )}
      {!hasPicture && pickingAspect && (url || live) && (
        <div
          className="pointer-events-none absolute inset-x-0 top-0 z-10 flex justify-center p-2.5"
          onClick={(e) => e.stopPropagation()}
        >
          <div
            className="pointer-events-auto inline-flex items-center gap-0.5 rounded-full bg-black/75 p-0.5 shadow-[0_2px_10px_rgba(0,0,0,0.4)] backdrop-blur-md"
            role="radiogroup"
            aria-label="Sahne oranı"
          >
            {ASPECTS.filter((a) => a.value !== "free").map((a) => {
              const activeAspect = crop?.aspect ?? "16:9";
              const pressed = activeAspect === a.value;
              return (
                <button
                  key={a.value}
                  type="button"
                  role="radio"
                  aria-checked={pressed}
                  aria-pressed={pressed}
                  title={`${a.title} (${a.value === "16:9" ? "1920×1080" : a.value === "9:16" ? "1080×1920" : a.value === "4:5" ? "1080×1350" : "1080×1080"})`}
                  className="h-7 rounded-full border-0 bg-transparent px-3 text-[12px] font-medium text-white/75 transition-colors duration-150 not-aria-pressed:hover:text-white aria-pressed:bg-white aria-pressed:text-black"
                  onClick={() => pickAudioAspect(a.value)}
                >
                  {a.label}
                </button>
              );
            })}
          </div>
        </div>
      )}
      {url && preparing && !notice && (
        <p
          className="pointer-events-none absolute top-2.5 right-2.5 m-0 inline-flex items-center gap-1.5 rounded-full bg-black/60 px-2.5 py-1 text-[11px] text-white/85"
          role="status"
        >
          <span className="size-1.5 animate-pulse rounded-full bg-cini motion-reduce:animate-none" aria-hidden />
          Hazırlanıyor…
        </p>
      )}
      {url && following && !notice && !pickingAspect && (
        <p
          className="pointer-events-none absolute top-2.5 left-2.5 m-0 inline-flex items-center gap-1.5 rounded-full bg-black/60 px-2.5 py-1 text-[11px] text-white/85"
          role="status"
        >
          <span className="size-1.5 animate-pulse rounded-full bg-cini motion-reduce:animate-none" aria-hidden />
          Yazılanı takip ediyor · oynatınca durur
        </p>
      )}
      {url && notice && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center p-6">
          <p className="m-0 max-w-[400px] rounded-ui border border-line bg-pane/95 px-4 py-3 text-center text-[13px] leading-[1.55] text-fg-2 shadow-[0_8px_24px_rgba(0,0,0,0.4)]">
            {notice}
          </p>
        </div>
      )}
    </div>
  );
}
