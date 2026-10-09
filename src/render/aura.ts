// "Aura": an audio-reactive background for audio-only projects (files and
// microphone recordings). Three soft colour fields drift slowly and swell
// with the energy of the low, mid and high bands of the voice.
//
// The bands come from the recognizer's own log-mel features, computed once
// in the ASR worker, so the player and the exported video use the same data
// and look identical.

/** Band frames per second. */
export const BAND_RATE = 50;

const RANGES: [number, number][] = [
  [0, 16], // ~20–600 Hz
  [16, 46], // ~600–2500 Hz
  [46, 80], // ~2.5–7.6 kHz
];

/**
 * Turns 10 ms log-mel frames into smoothed 0..1 band levels at BAND_RATE.
 * Fast attack, slow release, so the aura breathes with the voice.
 */
export class BandTracker {
  private acc = [0, 0, 0];
  private count = 0;
  private level = [0, 0, 0];
  private out: number[] = [];

  push(f: Float32Array) {
    for (let b = 0; b < 3; b++) {
      const [lo, hi] = RANGES[b];
      let m = 0;
      for (let i = lo; i < hi; i++) m += f[i];
      this.acc[b] += m / (hi - lo);
    }
    if (++this.count < 100 / BAND_RATE) return;
    for (let b = 0; b < 3; b++) {
      // Log-mel means run from ~-16 (digital silence) to ~0 (loud speech).
      const v = Math.min(1, Math.max(0, (this.acc[b] / this.count + 11) / 10));
      const k = v > this.level[b] ? 0.45 : 0.07;
      this.level[b] += (v - this.level[b]) * k;
      this.out.push(this.level[b]);
      this.acc[b] = 0;
    }
    this.count = 0;
  }

  /** Band frames produced since the last call. */
  take(): Float32Array {
    const r = Float32Array.from(this.out);
    this.out = [];
    return r;
  }
}

/**
 * Live meter for the microphone: splits each chunk into low / mid / high with
 * one-pole filters and maps the RMS of each to 0..1. Runs on the main thread
 * on raw chunks, so the aura reacts without waiting for the recognizer.
 */
export class LiveMeter {
  readonly levels: AuraLevels = { low: 0, mid: 0, high: 0 };
  /** Peak amplitude of each chunk (~100 ms), for the live waveform. */
  readonly peaks: number[] = [];
  /** Seconds of audio per peak. */
  chunkSeconds = 0.1;
  readonly startedAt = performance.now();
  private lp1 = 0;
  private lp2 = 0;
  private a1: number;
  private a2: number;

  constructor(sampleRate: number, chunkSamples = sampleRate / 10) {
    this.chunkSeconds = chunkSamples / sampleRate;
    this.a1 = 1 - Math.exp((-2 * Math.PI * 500) / sampleRate);
    this.a2 = 1 - Math.exp((-2 * Math.PI * 2500) / sampleRate);
  }

  push(pcm: Float32Array) {
    let peak = 0;
    for (let i = 0; i < pcm.length; i++) peak = Math.max(peak, Math.abs(pcm[i]));
    this.peaks.push(peak);
    let e0 = 0;
    let e1 = 0;
    let e2 = 0;
    for (let i = 0; i < pcm.length; i++) {
      const x = pcm[i];
      this.lp1 += (x - this.lp1) * this.a1;
      this.lp2 += (x - this.lp2) * this.a2;
      const low = this.lp1;
      const mid = this.lp2 - this.lp1;
      const high = x - this.lp2;
      e0 += low * low;
      e1 += mid * mid;
      e2 += high * high;
    }
    const n = Math.max(1, pcm.length);
    const map = (e: number, boost: number) =>
      Math.min(1, Math.max(0, (10 * Math.log10(e / n + 1e-10) + boost + 60) / 45));
    this.levels.low = map(e0, 0);
    this.levels.mid = map(e1, 4);
    this.levels.high = map(e2, 10);
  }
}

export interface AuraLevels {
  low: number;
  mid: number;
  high: number;
}

/** Interpolated band levels at time t (seconds). */
export function levelsAt(bands: Float32Array, t: number): AuraLevels {
  const n = bands.length / 3;
  if (!n) return { low: 0, mid: 0, high: 0 };
  const x = Math.max(0, Math.min(n - 1, t * BAND_RATE));
  const i = Math.floor(x);
  const j = Math.min(n - 1, i + 1);
  const f = x - i;
  const at = (b: number) => bands[i * 3 + b] * (1 - f) + bands[j * 3 + b] * f;
  return { low: at(0), mid: at(1), high: at(2) };
}

export type AuraPaletteId = "cini" | "gunbatimi" | "orman" | "lavanta" | "gece";

export const AURA_PALETTES: { id: AuraPaletteId; label: string; colors: [string, string, string] }[] = [
  { id: "cini", label: "Çini", colors: ["#2347c5", "#18a99c", "#8fa6f2"] },
  { id: "gunbatimi", label: "Gün batımı", colors: ["#ff5e3a", "#ffb03b", "#c2417a"] },
  { id: "orman", label: "Orman", colors: ["#1f7a52", "#9bd770", "#1f6f78"] },
  { id: "lavanta", label: "Lavanta", colors: ["#6c4dff", "#e86fd1", "#4cc4ff"] },
  { id: "gece", label: "Gece", colors: ["#3653c9", "#1b2a55", "#9fb2ff"] },
];

export const paletteById = (id: AuraPaletteId) => AURA_PALETTES.find((p) => p.id === id) ?? AURA_PALETTES[0];

/** Everything needed to draw one aura frame. */
export interface AuraFrame {
  kind: "aura";
  /** Seconds; drives the slow drift. */
  time: number;
  levels: AuraLevels;
  palette: [string, string, string];
}

export function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** Uniform block for AURA_SHADER: 20 floats (80 bytes). */
export function auraUniforms(a: AuraFrame, width: number, height: number): Float32Array {
  const [c1, c2, c3] = a.palette.map(hexToRgb);
  return new Float32Array([
    width, height, a.time, 0,
    a.levels.low, a.levels.mid, a.levels.high, 0,
    ...c1, 0,
    ...c2, 0,
    ...c3, 0,
  ]);
}

export const AURA_SHADER = /* wgsl */ `
struct Aura {
  res: vec2f,
  time: f32,
  _p0: f32,
  levels: vec4f,
  c1: vec4f,
  c2: vec4f,
  c3: vec4f,
};
@group(0) @binding(0) var<uniform> a: Aura;

struct VsOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };

@vertex fn vs_aura(@builtin(vertex_index) i: u32) -> VsOut {
  var p = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
  var o: VsOut;
  o.pos = vec4f(p[i], 0, 1);
  o.uv = vec2f((p[i].x + 1) * 0.5, (1 - p[i].y) * 0.5);
  return o;
}

fn hash(p: vec2f) -> f32 {
  return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453);
}

const PI = 3.14159265;

// Mesh gradient: four colour points drifting on slow Lissajous paths,
// blended by inverse-distance weights. Sound only nudges it.
fn mesh(uv: vec2f, aspect: f32, t: f32, energy: f32) -> vec3f {
  let deep = mix(a.c1.rgb, a.c3.rgb, 0.5) * 0.28;
  var pts = array<vec2f, 4>(
    vec2f(0.5 + 0.38 * sin(t * 0.050 + 0.0), 0.5 + 0.34 * cos(t * 0.043 + 1.0)),
    vec2f(0.5 + 0.40 * sin(t * 0.037 + 2.1), 0.5 + 0.36 * cos(t * 0.058 + 3.0)),
    vec2f(0.5 + 0.36 * sin(t * 0.061 + 4.2), 0.5 + 0.32 * cos(t * 0.031 + 5.1)),
    vec2f(0.5 + 0.30 * sin(t * 0.029 + 1.3), 0.5 + 0.30 * cos(t * 0.047 + 0.4))
  );
  var cols = array<vec3f, 4>(a.c1.rgb, a.c2.rgb, a.c3.rgb, deep);
  var acc = vec3f(0.0);
  var wsum = 0.0;
  for (var k = 0; k < 4; k++) {
    let d = (uv - pts[k]) * vec2f(aspect, 1.0);
    // The deep point spreads less when the voice is loud: more colour.
    let reach = select(1.0, 1.0 - 0.35 * energy, k == 3);
    let w = 1.0 / (pow(dot(d, d), 1.15) * reach + 0.015);
    acc += cols[k] * w;
    wsum += w;
  }
  return acc / wsum;
}

// One soft ribbon: a slow wave across the frame, tapered at the ends.
fn ribbon(uv: vec2f, t: f32, level: f32, k: f32, px: f32) -> f32 {
  let x = uv.x;
  let env = pow(sin(PI * x), 1.6);
  let wave = sin(x * (4.0 + 1.7 * k) + t * (0.45 + 0.18 * k) + k * 2.1)
           * (0.65 + 0.35 * sin(x * 2.2 - t * 0.21 + k));
  let y = 0.5 + (0.006 + 0.11 * level) * env * wave + (k - 1.0) * 0.012;
  let d = abs(uv.y - y) / px; // distance in output pixels
  let w = 1.1 * (a.res.y / 1080.0) + 0.6;
  let core = exp(-d * d / (2.0 * w * w));
  let glow = exp(-d / (22.0 * a.res.y / 1080.0));
  return (core * 0.55 + glow * 0.12) * (0.25 + 0.75 * level) * env;
}

@fragment fn fs_aura(in: VsOut) -> @location(0) vec4f {
  let aspect = a.res.x / a.res.y;
  let t = a.time;
  let low = a.levels.x;
  let mid = a.levels.y;
  let high = a.levels.z;
  let energy = (low + mid + high) / 3.0;

  // A gentle warp keeps the gradient alive without turning it into fog.
  let uvw = in.uv + 0.025 * vec2f(sin(in.uv.y * 3.0 + t * 0.17), cos(in.uv.x * 2.6 - t * 0.13));
  var col = mesh(uvw, aspect, t, energy);
  col *= 0.62 + 0.22 * energy;

  // Ribbons, tinted towards white so they read on any palette.
  let px = 1.0 / a.res.y;
  col += mix(a.c1.rgb, vec3f(1.0), 0.55) * ribbon(in.uv, t, low, 0.0, px);
  col += mix(a.c2.rgb, vec3f(1.0), 0.55) * ribbon(in.uv, t, mid, 1.0, px);
  col += mix(a.c3.rgb, vec3f(1.0), 0.55) * ribbon(in.uv, t, high, 2.0, px);

  // Soft vignette keeps captions readable; dither prevents banding.
  let v = in.uv - 0.5;
  col *= 1.0 - 0.55 * dot(v, v);
  col = col / (1.0 + col * 0.35);
  col += (hash(in.uv * a.res + fract(t)) - 0.5) / 255.0;
  return vec4f(col, 1.0);
}
`;
