// Audio and video through ffmpeg: the web app decodes with WebCodecs, which Node does not have.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import ffmpegStatic from "ffmpeg-static";
import { path as ffprobeStatic } from "@ffprobe-installer/ffprobe";
import { CANCELLED, signal, throwIfCancelled } from "./jobs";

/** $FFMPEG / $FFPROBE if set, else the binary that comes with the package, else the one on PATH. */
const binary = (env: string | undefined, bundled: string | null | undefined, name: string) =>
  env || (bundled && existsSync(bundled) ? bundled : name);
const FFMPEG = binary(process.env.FFMPEG, ffmpegStatic, "ffmpeg");
const FFPROBE = binary(process.env.FFPROBE, ffprobeStatic, "ffprobe");

export interface MediaInfo {
  duration: number;
  hasAudio: boolean;
  /** Channels of the first audio stream. */
  channels: number;
  hasVideo: boolean;
  /** The picture as it is shown: a phone video turned a quarter is already upright here. */
  width: number;
  height: number;
}

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", (e) => reject(new Error(`ffprobe çalıştırılamadı (${cmd}): ${e.message}`)));
    p.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`ffprobe hata verdi: ${err.trim().split("\n").slice(-3).join(" ")}`))));
  });
}

export async function probe(file: string): Promise<MediaInfo> {
  const json = JSON.parse(
    await run(FFPROBE, [
      "-v", "error",
      // Whole sections, not -show_entries: the ffprobe that ships with the package is older and has no stream_side_data section.
      "-show_format", "-show_streams",
      "-of", "json", file,
    ]),
  );
  type Stream = { codec_type: string; width?: number; height?: number; channels?: number; tags?: { rotate?: string }; side_data_list?: { rotation?: number }[] };
  const streams: Stream[] = json.streams ?? [];
  const video = streams.find((s) => s.codec_type === "video");
  // ffmpeg and the app turn the picture upright; the sizes are of the upright picture.
  const turn = Math.abs(Number(video?.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? video?.tags?.rotate ?? 0)) % 180 === 90;
  const [width, height] = turn ? [video?.height ?? 0, video?.width ?? 0] : [video?.width ?? 0, video?.height ?? 0];
  return {
    duration: Number(json.format?.duration) || 0,
    hasAudio: streams.some((s) => s.codec_type === "audio"),
    channels: streams.find((s) => s.codec_type === "audio")?.channels ?? 1,
    hasVideo: !!video,
    width,
    height,
  };
}

/** Mono 16 kHz float audio of start..end seconds, a piece at a time. */
export async function* pcmChunks(file: string, start = 0, end?: number): AsyncGenerator<Float32Array> {
  throwIfCancelled();
  const args = ["-v", "error", "-nostdin"];
  if (start > 0) args.push("-ss", String(start));
  args.push("-i", file);
  if (end !== undefined) args.push("-t", String(Math.max(0, end - start)));
  // The app averages the channels (engine/downmix); ffmpeg's own mono mix adds them at 0.707 each, which is 1.41 times louder.
  const channels = (await probe(file)).channels;
  throwIfCancelled();
  const mix = channels > 1 ? ["-af", `pan=mono|c0=${Array.from({ length: channels }, (_, i) => `${(1 / channels).toFixed(6)}*c${i}`).join("+")}`] : [];
  args.push("-vn", ...mix, "-ac", "1", "-ar", "16000", "-f", "f32le", "pipe:1");
  const p = spawn(FFMPEG, args, { stdio: ["ignore", "pipe", "pipe"] });
  const sig = signal();
  const onAbort = () => p.kill();
  sig?.addEventListener("abort", onAbort, { once: true });
  let err = "";
  p.stderr.on("data", (d) => (err += d));
  const exited = new Promise<number>((resolve, reject) => {
    p.on("error", (e) => reject(new Error(`ffmpeg çalıştırılamadı (${FFMPEG}): ${e.message}`)));
    p.on("close", (code) => resolve(code ?? 1));
  });
  // Pipe reads end anywhere: keep the bytes of a half sample for the next read.
  let rest = Buffer.alloc(0);
  try {
    for await (const chunk of p.stdout as AsyncIterable<Buffer>) {
      throwIfCancelled();
      const buf = rest.length ? Buffer.concat([rest, chunk]) : chunk;
      const whole = buf.length - (buf.length % 4);
      rest = Buffer.from(buf.subarray(whole));
      if (whole) {
        const out = new Float32Array(whole / 4);
        for (let i = 0; i < out.length; i++) out[i] = buf.readFloatLE(i * 4);
        yield out;
      }
    }
  } finally {
    sig?.removeEventListener("abort", onAbort);
    if (p.exitCode === null) p.kill();
  }
  throwIfCancelled();
  const code = await exited;
  if (code !== 0 && code !== null) throw new Error(`Ses çözülemedi: ${err.trim().split("\n").slice(-2).join(" ")}`);
}

/** ffmpeg with `-progress`: calls onProgress with the seconds of output written so far. */
export function ffmpeg(args: string[], onProgress?: (seconds: number) => void): Promise<void> {
  throwIfCancelled();
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, ["-v", "error", "-nostdin", "-y", "-progress", "pipe:1", "-nostats", ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const sig = signal();
    const onAbort = () => p.kill();
    sig?.addEventListener("abort", onAbort, { once: true });
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    createInterface({ input: p.stdout }).on("line", (line) => {
      const m = /^out_time_us=(\d+)/.exec(line);
      if (m) {
        try {
          onProgress?.(Number(m[1]) / 1e6);
        } catch {
          p.kill();
        }
      }
    });
    p.on("error", (e) => {
      sig?.removeEventListener("abort", onAbort);
      reject(new Error(`ffmpeg çalıştırılamadı (${FFMPEG}): ${e.message}`));
    });
    p.on("close", (code) => {
      sig?.removeEventListener("abort", onAbort);
      if (sig?.aborted) reject(new Error(CANCELLED));
      else if (code === 0) resolve();
      else reject(new Error(`ffmpeg hata verdi: ${err.trim().split("\n").slice(-4).join(" ")}`));
    });
  });
}
