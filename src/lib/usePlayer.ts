import { useCallback, useEffect, useState } from "react";

export interface Player {
  /** Attach to the (invisible) <video>/<audio> that does decoding and sound. */
  ref: (el: HTMLMediaElement | null) => void;
  el: HTMLMediaElement | null;
  url: string | null;
  isVideo: boolean;
  time: number;
  duration: number;
  playing: boolean;
  muted: boolean;
  toggle: () => void;
  seek: (t: number) => void;
  setMuted: (m: boolean) => void;
}

/** Might have a picture. Containers like WebM/MP4 can also be audio-only;
 *  usePlayer settles that once the metadata has loaded. */
export const isVideoFile = (f: File) =>
  f.type ? f.type.startsWith("video/") : /\.(mp4|mov|mkv|webm|m4v)$/i.test(f.name);

/** Media element state for the custom WebGPU player. */
export function usePlayer(file: File | null): Player {
  const [el, setEl] = useState<HTMLMediaElement | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [muted, setMutedState] = useState(false);
  /** null until metadata says whether the file has a picture. */
  const [hasPicture, setHasPicture] = useState<boolean | null>(null);

  // Object URL tied to the effect, so StrictMode's re-run cannot revoke one in use.
  useEffect(() => {
    setTime(0);
    setDuration(0);
    setPlaying(false);
    setHasPicture(null);
    if (!file) {
      setUrl(null);
      return;
    }
    const u = URL.createObjectURL(file);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);

  useEffect(() => {
    if (!el) return;
    const on = (type: string, fn: () => void) => {
      el.addEventListener(type, fn);
      return () => el.removeEventListener(type, fn);
    };
    const offs = [
      on("timeupdate", () => setTime(el.currentTime)),
      on("seeked", () => setTime(el.currentTime)),
      on("durationchange", () => setDuration(Number.isFinite(el.duration) ? el.duration : 0)),
      on("play", () => setPlaying(true)),
      on("pause", () => setPlaying(false)),
      on("ended", () => setPlaying(false)),
      on("volumechange", () => setMutedState(el.muted)),
      on("loadedmetadata", () => setHasPicture(el instanceof HTMLVideoElement && el.videoWidth > 0)),
    ];
    // timeupdate fires ~4×/s; follow playback more closely for word
    // highlights, but not faster than ~25 updates/s (React re-renders).
    let raf = 0;
    let last = -1;
    const tick = () => {
      if (!el.paused && Math.abs(el.currentTime - last) >= 0.04) {
        last = el.currentTime;
        setTime(last);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      offs.forEach((f) => f());
      cancelAnimationFrame(raf);
    };
  }, [el]);

  const toggle = useCallback(() => {
    if (!el) return;
    if (el.paused) void el.play();
    else el.pause();
  }, [el]);

  const seek = useCallback(
    (t: number) => {
      if (!el) return;
      el.currentTime = Math.max(0, t);
      setTime(el.currentTime);
    },
    [el],
  );

  const setMuted = useCallback((m: boolean) => el && (el.muted = m), [el]);

  return {
    ref: setEl,
    el,
    url,
    // A video container without a video track is treated as audio (aura).
    isVideo: !!file && isVideoFile(file) && hasPicture !== false,
    time,
    duration,
    playing,
    muted,
    toggle,
    seek,
    setMuted,
  };
}
