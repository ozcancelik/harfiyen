const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** 75.3 -> "01:15", or "1:02:05" past an hour. */
export function clock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`;
}

/** Subtitle timestamp: "00:01:15,300" (SRT) or "00:01:15.300" (VTT). */
export function stamp(sec: number, sep: "," | "."): string {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${pad(h)}:${pad(m)}:${pad(s)}${sep}${pad(ms % 1000, 3)}`;
}

export function megabytes(bytes: number): string {
  return (bytes / 1_000_000).toLocaleString("tr-TR", { maximumFractionDigits: bytes < 10_000_000 ? 1 : 0 });
}

export function duration(sec: number): string {
  if (sec < 60) return `${Math.round(sec)} sn`;
  const m = Math.round(sec / 60);
  if (m < 60) return `${m} dk`;
  return `${Math.floor(m / 60)} sa ${m % 60} dk`;
}
