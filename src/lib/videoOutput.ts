// How the captioned video is encoded: codec, picture size and bitrate, chosen in the export menu.
//
// The bitrate is worked out here, not left to mediabunny, so the size shown
// before the render is the size the render aims for. The levels follow
// mediabunny's own Quality formula (about 3 Mbps for 1080p30 H.264 at
// "medium", HEVC 40% less), raised for frame rates above 30; "source"
// matches the input file's average bitrate.

export type OutputCodec = "avc" | "hevc";
/** Where the browser can encode a codec: the graphics hardware (fast) or the processor; null when it cannot. */
export type Encoder = "hardware" | "software" | null;
export type OutputQuality = "source" | "low" | "medium" | "high" | "very-high";
/** The short side of the picture ("720" is 1280×720, or 720×1280 upright); "source" keeps the file's size. */
export type OutputResolution = "source" | "720" | "1080" | "2160";
export interface VideoOutput {
  codec: OutputCodec;
  quality: OutputQuality;
  /** "auto" until a size is picked: the file's own, or 1080p for a smaller picture (see `autoResolution`). */
  resolution: OutputResolution | "auto";
}

/** Aura videos for audio files and recordings, at 1080p unless another size is chosen. */
export const AUDIO_VIDEO = { width: 1920, height: 1080, fps: 60 };

const LEVELS: Record<Exclude<OutputQuality, "source">, number> = { low: 0.25, medium: 0.5, high: 0.75, "very-high": 1 };
/** Bits needed for the same picture, relative to H.264. */
const EFFICIENCY: Record<string, number> = { avc: 1, hevc: 0.6, vp9: 0.6, av1: 0.4, vp8: 1.2 };
const SHORT_SIDES = { "720": 720, "1080": 1080, "2160": 2160 } as const;
/**
 * A smaller video can be written up to this short side. The picture stays as
 * soft as the file's, but the captions are drawn at the larger size and come
 * out sharp instead of as blocky as the picture.
 */
const UPSCALE_TO = 1080;

export const DEFAULT_OUTPUT: VideoOutput = { codec: "avc", quality: "source", resolution: "auto" };

export function loadOutput(): VideoOutput {
  try {
    const saved = JSON.parse(localStorage.getItem("harfiyen.videoOutput") ?? "null");
    if (
      saved &&
      (saved.codec === "avc" || saved.codec === "hevc") &&
      (saved.quality === "source" || saved.quality in LEVELS)
    ) {
      // Before v2 "source" was the default, not a choice: those settings get "auto" now.
      const picked = saved.v === 2 && saved.resolution === "source";
      const resolution = saved.resolution in SHORT_SIDES || picked ? saved.resolution : "auto";
      return { codec: saved.codec, quality: saved.quality, resolution };
    }
  } catch {
    // Unreadable: the default.
  }
  return DEFAULT_OUTPUT;
}

export function saveOutput(output: VideoOutput) {
  try {
    localStorage.setItem("harfiyen.videoOutput", JSON.stringify({ ...output, v: 2 }));
  } catch {
    // Not remembered; still used for this session.
  }
}

/** A picture size on offer, with the encoders the browser has at that size. */
export interface Resolution {
  value: OutputResolution;
  width: number;
  height: number;
  encoders: Record<OutputCodec, Encoder>;
}

/** What the export needs to know about the file: picture, length, bitrates and the sizes it can be written at. */
export interface SourceInfo {
  /** The picture as rendered: the displayed size of the video (or of its crop), or the aura's 1080p. */
  width: number;
  height: number;
  fps: number;
  duration: number;
  /**
   * Average video bitrate, codec and displayed size of the file, when it has a picture, and
   * whether this browser can decode it (Safari has AV1 only on chips that decode it in hardware).
   */
  video: { bitrate: number; codec: string | null; decodes: boolean; width: number; height: number } | null;
  /** Average audio bitrate (copied over for videos). */
  audioBitrate: number;
  /**
   * Largest first. Videos keep their size ("source"), shrink to the standard sizes below it, or grow
   * to those up to 1080p; auras come in 720p, 1080p and 4K.
   */
  resolutions: Resolution[];
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/** The size with the given short side and shape (width over height). */
const scaled = (ratio: number, short: number) =>
  ratio >= 1 ? { width: even(short * ratio), height: short } : { width: short, height: even(short / ratio) };

/**
 * The sizes a file can be written at (without encoders): videos shrink, or grow up to 1080p, auras pick a size.
 * `ratio` is the exact shape when the picture is a crop, so 9:16 comes out at 1080×1920, not
 * the 1080×1918 its even-sized pixels would give.
 */
export function resolutionSizes(width: number, height: number, isVideo: boolean, ratio = width / height) {
  const standard = (["2160", "1080", "720"] as const).map((value) => ({
    value,
    ...scaled(ratio, SHORT_SIDES[value]),
  }));
  if (!isVideo) return standard;
  const short = Math.min(width, height);
  const offered = standard.filter((r) => SHORT_SIDES[r.value] !== short && (SHORT_SIDES[r.value] < short || SHORT_SIDES[r.value] <= UPSCALE_TO));
  return [{ value: "source" as const, width, height }, ...offered].sort((a, b) => Math.min(b.width, b.height) - Math.min(a.width, a.height));
}

/** What "auto" comes to: 1080p for a video smaller than that (sharp captions), else the file's own size. */
function autoResolution(source: SourceInfo): OutputResolution {
  return source.video && Math.min(source.width, source.height) < UPSCALE_TO ? "1080" : "source";
}

/** The size the output is written at: the chosen one when on offer, else the file's own (1080p for auras). */
export function resolutionOf(output: VideoOutput, source: SourceInfo): Resolution {
  const list = source.resolutions;
  const want = output.resolution === "auto" ? autoResolution(source) : output.resolution;
  return list.find((r) => r.value === want) ?? list.find((r) => r.value === "source" || r.value === "1080") ?? list[0];
}

/** Video bitrate in bits per second for the chosen output. */
export function videoBitrate(output: VideoOutput, source: SourceInfo): number {
  const { width, height } = resolutionOf(output, source);
  const efficiency = EFFICIENCY[output.codec];
  const pixels = width * height;
  // More frames need more bits, though not in proportion: 60 fps takes about 1.5 times 30 fps.
  const motion = Math.pow(Math.min(120, Math.max(10, source.fps)) / 30, 0.6);
  const atLevel = (level: number) =>
    Math.ceil((3e6 * Math.pow(pixels / (1920 * 1080), 0.95) * efficiency * motion * 0.3 * Math.exp(2.5538 * level)) / 1000) *
    1000;
  if (output.quality === "source" && source.video) {
    // An HEVC file written as H.264 needs more bits for the same picture, and the other way round;
    // a smaller (or cropped) picture fewer. The file's bitrate already carries its frame rate.
    // A picture written larger has no more detail than the file's, only the captions' edges: it gets fewer extra bits.
    const from = EFFICIENCY[source.video.codec ?? "avc"] ?? 1;
    const grown = pixels / (source.video.width * source.video.height);
    const shrink = Math.pow(grown, grown > 1 ? 0.5 : 0.95);
    const matched = Math.ceil((source.video.bitrate * shrink * efficiency) / from / 1000) * 1000;
    // Not below "low": a screen recording at a few hundred kbps would blur the burnt-in captions.
    return Math.max(atLevel(LEVELS.low), matched);
  }
  return atLevel(output.quality === "source" ? LEVELS.high : LEVELS[output.quality]);
}

/** Expected file size in bytes. */
export const estimateSize = (output: VideoOutput, source: SourceInfo) =>
  ((videoBitrate(output, source) + source.audioBitrate) * source.duration) / 8;

/**
 * The choice as it can be made for this file: a size on offer, the other
 * codec where one cannot be encoded at that size, a level where there is no
 * source video.
 */
export function effectiveOutput(output: VideoOutput, source: SourceInfo | null): VideoOutput {
  if (!source) return output;
  const resolution = resolutionOf(output, source);
  const other = output.codec === "avc" ? "hevc" : "avc";
  return {
    resolution: resolution.value,
    codec: !resolution.encoders[output.codec] && resolution.encoders[other] ? other : output.codec,
    quality: output.quality === "source" && !source.video ? "high" : output.quality,
  };
}

const CODEC_NAMES: Record<string, string> = {
  avc: "H.264",
  hevc: "HEVC",
  av1: "AV1",
  vp9: "VP9",
  vp8: "VP8",
  prores: "ProRes",
};

/** The picture's codec, by name, when this browser cannot decode it; null when it can (or there is no picture). */
export function undecodable(source: SourceInfo | null): string | null {
  const v = source?.video;
  if (!v || v.decodes) return null;
  return (v.codec && CODEC_NAMES[v.codec]) ?? v.codec?.toUpperCase() ?? "bilinmeyen bir kodlama";
}
