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
  private loud: number[] = [];

  push(f: Float32Array) {
    for (let b = 0; b < 3; b++) {
      const [lo, hi] = RANGES[b];
      let m = 0;
      for (let i = lo; i < hi; i++) m += f[i];
      this.acc[b] += m / (hi - lo);
    }
    if (++this.count < 100 / BAND_RATE) return;
    // The speech band as it is: the levels below stop at loud speech.
    this.loud.push(this.acc[1] / this.count);
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

  /** Loudness frames (the speech band's log-mel mean, unsmoothed and unclipped) since the last call. */
  takeLoudness(): Float32Array {
    const r = Float32Array.from(this.loud);
    this.loud = [];
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
  /** 0..1 kick when the voice suddenly gets louder (a stressed syllable, a plosive); decays in ~0.1 s. */
  punch?: number;
}

/** Onset at band frame i: the sharpest recent rise in energy, fading with its age. */
function punchFrame(bands: Float32Array, i: number): number {
  const e = (k: number) => (bands[k * 3] + bands[k * 3 + 1] + bands[k * 3 + 2]) / 3;
  let p = 0;
  for (let d = 0; d < 15 && i - d >= 3; d++) {
    const rise = e(i - d) - e(i - d - 3) - 0.04;
    if (rise > 0) p = Math.max(p, rise * Math.exp(-d / 5));
  }
  return Math.min(1, p * 4);
}

/** Band frames the relative levels measure the voice against (~3 s). */
const REL_WINDOW = 3 * BAND_RATE;
/** A range narrower than this is treated as steady sound, not stretched to 0..1. */
const REL_MIN_SPAN = 0.18;

/**
 * A level against the voice's own recent range (lo..hi): the dips between
 * syllables go to 0 and the loudest recent moment to 1, so a steady talker or
 * a loud, compressed file still moves the visuals. A little of the absolute
 * level stays, so silence is calm and shouting is still bigger.
 */
function relative(x: number, lo: number, hi: number): number {
  return Math.min(1, 0.7 * ((x - lo) / Math.max(REL_MIN_SPAN, hi - lo)) + 0.3 * x);
}

function relativeFrame(bands: Float32Array, i: number, b: number): number {
  const x = bands[i * 3 + b];
  let lo = x;
  let hi = x;
  for (let k = Math.max(0, i - REL_WINDOW); k < i; k++) {
    const v = bands[k * 3 + b];
    if (v < lo) lo = v;
    else if (v > hi) hi = v;
  }
  return relative(x, lo, hi);
}

/** The same for live levels (the microphone): envelopes that forget the range over ~3 s. */
export class RelativeLevels {
  private lo = [0, 0, 0];
  private hi = [0, 0, 0];

  apply(l: AuraLevels, dt: number): AuraLevels {
    const out = [l.low, l.mid, l.high].map((x, b) => {
      this.hi[b] = Math.max(x, this.hi[b] - dt * 0.25);
      this.lo[b] = Math.min(x, this.lo[b] + dt * 0.25);
      return relative(x, this.lo[b], this.hi[b]);
    });
    return { low: out[0], mid: out[1], high: out[2], punch: l.punch };
  }
}

/** Band levels at time t (seconds), relative to the voice's recent range; interpolated. */
export function levelsAt(bands: Float32Array, t: number): AuraLevels {
  const n = bands.length / 3;
  if (!n) return { low: 0, mid: 0, high: 0, punch: 0 };
  const x = Math.max(0, Math.min(n - 1, t * BAND_RATE));
  const i = Math.floor(x);
  const j = Math.min(n - 1, i + 1);
  const f = x - i;
  const at = (b: number) => relativeFrame(bands, i, b) * (1 - f) + relativeFrame(bands, j, b) * f;
  const punch = punchFrame(bands, i) * (1 - f) + punchFrame(bands, j) * f;
  return { low: at(0), mid: at(1), high: at(2), punch };
}

export type AuraPaletteId = "cini" | "gunbatimi" | "orman" | "lavanta" | "gece";
export type AuraStyleId = "aura" | "halo" | "spektrum" | "kure" | "akis";

export const AURA_STYLES: { id: AuraStyleId; label: string; note: string }[] = [
  { id: "aura", label: "Aura", note: "Sesle hareket eden yumuşak gradyan ve dalga çizgileri." },
  { id: "halo", label: "Halo", note: "Merkezde sesin frekanslarıyla bükülen ipeksi sonik enerji halkaları." },
  { id: "spektrum", label: "Ufuk", note: "Sesin son saniyeleri üzerinde uçulan retro bir dalga arazisi olur: her hece önde bir tepe olarak doğar, çizgili güneşe doğru uzaklaşır." },
  { id: "kure", label: "Küre", note: "Sesle şekil değiştiren yanardöner 3 boyutlu bir damla; bas onu şişirir, tiz yüzeyini ürpertir, vurgular onu zıplatır." },
  { id: "akis", label: "Sırtlar", note: "Sesin son saniyeleri üst üste dizilmiş ışık çizgileri olur: öndeki çizgi şimdiki ses, her an bir geriye kayar. Bas ortada büyük tepeler, tizler ince pürüzler çıkarır." },
];

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
  style?: AuraStyleId;
  /** "Ufuk" only: historyAt(time); without it every row shows the current levels. */
  history?: Float32Array;
}

/** "Ufuk" shows this many rows of the voice's past, front ("now") to back. */
export const HISTORY_ROWS = 24;
/** Seconds between two rows. */
export const HISTORY_STEP = 0.2;

/**
 * Step index and 0..1 phase within HISTORY_STEP for time t. Computed once in
 * JS and passed in the uniform block so CPU (f64) and WGSL (f32) never disagree
 * on a boundary frame (e.g. t = 0.6s where f64 gives 2.9999999999999996 and f32 gives 3.0).
 */
function historyStep(t: number): { n: number; phase: number } {
  const u = Math.round((t / HISTORY_STEP) * 1e6) / 1e6;
  const n = Math.floor(u);
  return { n, phase: u - n };
}

/**
 * The levels of Ufuk's rows at time t, 4 floats a row (low, mid, high,
 * punch). Row 0 is t itself; row k ≥ 1 is the k-th step boundary back. The
 * rows scroll back between boundaries, so each keeps its moment as it moves
 * and the front row is always "now".
 */
export function historyAt(levelsAtTime: (time: number) => AuraLevels, t: number): Float32Array {
  const out = new Float32Array(HISTORY_ROWS * 4);
  const { n } = historyStep(t);
  for (let k = 0; k < HISTORY_ROWS; k++) {
    const l = levelsAtTime(k === 0 ? t : (n - k + 1) * HISTORY_STEP);
    out.set([l.low, l.mid, l.high, l.punch ?? 0], k * 4);
  }
  return out;
}

/** The last few seconds of live levels (the microphone), for historyAt. */
/** Styles drawn from the sound's last seconds (`historyAt`), not only from the sound now. */
export const usesHistory = (style: AuraStyleId | undefined) => style === "spektrum" || style === "akis";

export class LiveHistory {
  private times: number[] = [];
  private levels: AuraLevels[] = [];

  push(time: number, l: AuraLevels) {
    this.times.push(time);
    this.levels.push(l);
    while (this.times.length > 2 && this.times[1] < time - (HISTORY_ROWS + 2) * HISTORY_STEP) {
      this.times.shift();
      this.levels.shift();
    }
  }

  /** The levels last pushed at or before `time` (the oldest kept, before that). */
  at = (time: number): AuraLevels => {
    for (let i = this.times.length - 1; i >= 0; i--) if (this.times[i] <= time) return this.levels[i];
    return this.levels[0] ?? { low: 0, mid: 0, high: 0, punch: 0 };
  };
}

export function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

const STYLE_INDEX: Record<AuraStyleId, number> = { aura: 0, halo: 1, spektrum: 2, kure: 3, akis: 4 };

/** Size of AURA_SHADER's uniform block: five vec4s and Ufuk's rows. */
export const AURA_UNIFORM_BYTES = (5 + HISTORY_ROWS) * 16;

/** Uniform block for AURA_SHADER. */
export function auraUniforms(a: AuraFrame, width: number, height: number): Float32Array {
  const [c1, c2, c3] = a.palette.map(hexToRgb);
  const styleIdx = STYLE_INDEX[a.style ?? "aura"] ?? 0;
  const levels = [a.levels.low, a.levels.mid, a.levels.high, a.levels.punch ?? 0];
  const { n: stepN, phase: stepPhase } = historyStep(a.time);
  const out = new Float32Array(AURA_UNIFORM_BYTES / 4);
  out.set([
    width, height, a.time, styleIdx,
    ...levels,
    ...c1, stepN,
    ...c2, stepPhase,
    ...c3, 0,
  ]);
  if (a.history) out.set(a.history, 20);
  else for (let k = 0; k < HISTORY_ROWS; k++) out.set(levels, 20 + k * 4);
  return out;
}

export const AURA_SHADER = /* wgsl */ `
struct Aura {
  res: vec2f,
  time: f32,
  style: f32,
  levels: vec4f,
  c1: vec4f,
  c2: vec4f,
  c3: vec4f,
  hist: array<vec4f, ${HISTORY_ROWS}>,
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

// Sine-free hash: stays stable for large inputs (long recordings).
fn hash2(p: vec2f) -> f32 {
  var p3 = fract(vec3f(p.x, p.y, p.x) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

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

// Style 1 ("halo"): Silky multi-layered harmonic voice orb (Siri / fluid interference rings).
fn draw_halo(uv: vec2f, aspect: f32, t: f32, low: f32, mid: f32, high: f32, punch: f32) -> vec3f {
  let p = (uv - 0.5) * vec2f(aspect, 1.0) * 2.0;
  let r = length(p);
  let ang = atan2(p.y, p.x);
  let energy = (low + mid + high) / 3.0;

  // Deep velvet backdrop with subtle core glow.
  var col = mix(a.c1.rgb, a.c3.rgb, 0.45) * (0.08 + (0.20 + 0.18 * energy) * exp(-r * r * 2.4));

  // Five silky overlapping harmonic ribbons around the orb.
  for (var k = 0; k < 5; k++) {
    let fk = f32(k);
    let phase = fk * 1.25 + t * (0.55 + fk * 0.14);
    let deform = sin(ang * 3.0 + phase) * 0.055 * (0.25 + low)
               + cos(ang * 5.0 - phase * 1.3) * 0.042 * (0.20 + mid)
               + sin(ang * 8.0 + phase * 1.7) * 0.026 * (0.15 + high);
    let targetR = 0.36 + fk * 0.032 + 0.08 * energy + 0.05 * punch * (1.0 + fk * 0.3) + deform;
    let d = abs(r - targetR);

    // Silky Gaussian core + wide atmospheric bloom.
    let core = exp(-d * d * 1800.0);
    let halo = exp(-d * 14.0) * 0.42 + 0.0045 / (d + 0.012);
    let cMix = select(mix(a.c1.rgb, a.c2.rgb, fk * 0.35), mix(a.c2.rgb, a.c3.rgb, (fk - 2.0) * 0.4), fk >= 2.0);
    let tint = mix(cMix, vec3f(1.0), core * 0.65);
    col += tint * (core * (0.65 + 0.5 * punch) + halo * (0.22 + 0.45 * energy + 0.35 * punch));
  }

  return col;
}

// Style 2 ("spektrum" / "Ufuk"): flying over the voice's recent past, retro.
// The front row is now and each row behind it a moment earlier, so a syllable
// rises as a crest at the front and travels off towards the horizon; a pause
// leaves a flat valley. The rows recede in perspective (closer together,
// smaller, thinner) and fade into the haze; a wireframe grid runs through
// them to the vanishing point, under a striped synthwave sun.
const ROWS = ${HISTORY_ROWS};
const STEP = ${HISTORY_STEP};
const HORIZON_Y = 0.42;
// Camera height: a row at distance z sits at HORIZON_Y + CAM_H / z on screen.
const CAM_H = 0.66;
const Z_STEP = 0.36;

// A row's height at world x: bass makes broad swells, mids the main crests,
// highs fine ripples. Its shape follows the row's own moment, so each row differs.
fn row_height(x: f32, ts: f32, h: vec4f) -> f32 {
  let wl = sin(x * 1.3 + ts * 0.9) * 0.5 + 0.5;
  let wm = sin(x * 3.1 - ts * 1.7 + sin(x * 1.1 + ts)) * 0.5 + 0.5;
  let wh = sin(x * 9.0 + ts * 4.0) * 0.5 + 0.5;
  return 0.015 + 0.2 * h.x * wl + 0.3 * h.y * wm + 0.07 * h.z * wh + 0.1 * h.w;
}

fn draw_spektrum(uv: vec2f, aspect: f32, t: f32, low: f32, mid: f32, high: f32, punch: f32) -> vec3f {
  let energy = (low + mid + high) / 3.0;
  let deep = mix(a.c1.rgb, a.c3.rgb, 0.5) * 0.03;
  let haze = mix(a.c1.rgb, a.c3.rgb, 0.5) * 0.3 + mix(a.c2.rgb, a.c1.rgb, 0.5) * 0.1;
  let sx = (uv.x - 0.5) * aspect;
  // Sky: dark above, the haze glowing along the horizon, a few stars.
  var col = deep + haze * exp(-abs(uv.y - HORIZON_Y) * 8.0) * (0.7 + 0.6 * energy);
  let sc = vec2f(sx, uv.y) * 70.0;
  let hs = hash2(floor(sc));
  if (hs > 0.985 && uv.y < HORIZON_Y - 0.05) {
    let f = fract(sc) - 0.5;
    col += vec3f(0.8) * exp(-dot(f, f) * 60.0) * (0.4 + 0.4 * sin(t * (1.0 + hs * 3.0) + hs * 50.0)) * (0.5 + high);
  }

  // The sun, half set: bright on top, cut by bands below that widen and drift down.
  let sunY = HORIZON_Y - 0.07;
  let R = 0.19;
  let sp = vec2f(sx, uv.y - sunY);
  let r = length(sp);
  if (r < R) {
    let v = clamp((uv.y - (sunY - R)) / (2.0 * R), 0.0, 1.0);
    let sun = mix(mix(a.c2.rgb, vec3f(1.0), 0.35), a.c1.rgb, v) * (0.85 + 0.35 * energy);
    let sy = (uv.y - sunY) / R;
    let band = fract(sy * 6.0 - t * 0.25);
    let cut = select(0.0, smoothstep(0.0, 0.04, (sy + 0.45) * 0.4 - band), sy > -0.45);
    col = mix(col, sun, 1.0 - cut);
  }
  col += a.c1.rgb * exp(-max(r - R, 0.0) * 9.0) * (0.18 + 0.35 * energy + 0.4 * punch);

  let n = a.c1.w;
  let phase = a.c2.w;
  let scale = a.res.y / 1080.0;
  // The shape is in world x (finer with distance); the swell stays in the middle of the screen.
  let env = exp(-sx * sx * 0.9);
  // Depth of the flat ground under this pixel, so the grid lines run straight and unbroken.
  let gz = clamp(CAM_H / max(uv.y - HORIZON_Y, 0.001), 1.0, 40.0);
  let gx = sx * gz * 3.2;
  let gd = abs(fract(gx + 0.5) - 0.5) * a.res.y / (gz * 3.2);
  let gw = (0.5 + 1.0 / gz) * scale;
  // Fades with distance, before the lines crowd into a moiré at the horizon.
  let grid = exp(-gd * gd / (2.0 * gw * gw)) * 0.45 * exp(-gz * 0.12);

  // Far to near, each row hiding those behind it.
  for (var i = ROWS - 1; i >= 0; i--) {
    let pos = f32(i) + phase;
    let z = 1.0 + pos * Z_STEP;
    let base = HORIZON_Y + CAM_H / z;
    let reach = env * CAM_H * 1.6 / pow(z, 0.7);
    // Skip rows whose highest possible crest and glow still lie below this pixel in the sky.
    if (uv.y < base - 0.72 * reach - 0.06) { continue; }
    let ts = (n - f32(i) + 1.0) * STEP;
    let h = a.hist[i];
    // Heights shrink a little slower than true perspective, so far crests still read.
    let crest = base - row_height(sx * z * 1.6, ts, h) * reach;
    let dy = uv.y - crest;

    let far = pos / f32(ROWS);
    let fog = 1.0 - exp(-(z - 1.0) * 0.25);
    // The back row fades out before it leaves; the front one fades in smoothly as it is born.
    let vis = (1.0 - smoothstep(f32(ROWS) - 2.0, f32(ROWS), pos)) * smoothstep(0.0, 1.0, pos);
    let tint = mix(mix(a.c2.rgb, a.c1.rgb, 0.3), a.c3.rgb, far);
    let bright = 0.5 + 1.1 * (h.x + h.y + h.z) / 3.0 + 0.6 * h.w;

    if (dy > 0.0) {
      // Below the crest: the row's body, with a rim of light under the crest
      // and the grid's lines running through it to the vanishing point.
      let rim = exp(-dy * a.res.y / ((6.0 + 26.0 / z) * scale));
      var body = mix(deep, tint * 0.22 * bright, rim);
      body += tint * grid * (0.6 + 0.4 * bright);
      col = mix(col, mix(body, haze * 0.6, fog), 0.92 * vis);
    } else {
      // A soft glow rising above the crest.
      col += tint * exp(dy * a.res.y / (14.0 * scale)) * 0.05 * bright * (1.0 - fog) * vis;
    }

    // The crest line: thick and bright in front, a hairline in the haze.
    let lw = (0.6 + 2.4 / z) * scale;
    let d = abs(dy) * a.res.y;
    let ridge = exp(-d * d / (2.0 * lw * lw));
    col += mix(mix(tint, vec3f(1.0), 0.45), haze, fog) * ridge * bright * vis * (1.0 - 0.5 * fog);
  }
  return col;
}

// Style 3 ("kure"): a raymarched liquid orb. Bass swells it, mids ripple it,
// highs add fine shivers; a punch makes it jump. Thin-film iridescence on the
// grazing angles, a soft halo from the closest miss distance.
fn orb_sdf(p: vec3f, t: f32, low: f32, mid: f32, high: f32, punch: f32) -> f32 {
  let r = 0.72 + 0.12 * low + 0.16 * punch;
  let n1 = sin(p.x * 2.1 + t * 0.90) * sin(p.y * 2.3 - t * 0.70) * sin(p.z * 1.9 + t * 0.80);
  let n2 = sin(p.x * 5.3 - t * 1.60) * sin(p.y * 4.7 + t * 1.30) * sin(p.z * 5.1 - t * 1.10);
  let n3 = sin(p.x * 11.0 + t * 2.4) * sin(p.y * 9.0 - t * 2.0) * sin(p.z * 10.0 + t * 2.2);
  // Calm at rest: almost all of the movement comes from the voice.
  return length(p) - r - n1 * (0.035 + 0.2 * low) - n2 * (0.008 + 0.095 * mid) - n3 * (0.002 + 0.032 * high);
}

fn orb_normal(p: vec3f, t: f32, low: f32, mid: f32, high: f32, punch: f32) -> vec3f {
  let e = vec2f(0.0015, -0.0015);
  return normalize(
    e.xyy * orb_sdf(p + e.xyy, t, low, mid, high, punch) +
    e.yyx * orb_sdf(p + e.yyx, t, low, mid, high, punch) +
    e.yxy * orb_sdf(p + e.yxy, t, low, mid, high, punch) +
    e.xxx * orb_sdf(p + e.xxx, t, low, mid, high, punch));
}

fn draw_kure(uv: vec2f, aspect: f32, t: f32, low: f32, mid: f32, high: f32, punch: f32) -> vec3f {
  let energy = (low + mid + high) / 3.0;
  let q = (uv - 0.5) * vec2f(aspect, -1.0) * 2.0;
  let deep = mix(a.c1.rgb, a.c3.rgb, 0.5);
  var col = deep * (0.05 + 0.10 * exp(-dot(q, q) * 0.8));

  // Fit the orb to the short side of the frame, upright or wide.
  let fit = max(1.0, 1.0 / aspect);
  let ro = vec3f(0.0, 0.0, 2.7 * fit);
  let rd = normalize(vec3f(q, -1.75));

  // Bounding sphere: most pixels never march.
  let b = dot(ro, rd);
  let c = dot(ro, ro) - 1.5 * 1.5;
  let h = b * b - c;
  var hit = false;
  var p = ro;
  if (h > 0.0) {
    var dist = max(0.0, -b - sqrt(h));
    for (var i = 0; i < 64; i++) {
      p = ro + rd * dist;
      let d = orb_sdf(p, t, low, mid, high, punch);
      if (d < 0.0015) { hit = true; break; }
      dist += d * 0.7;
      if (dist > -b + sqrt(h)) { break; }
    }
  }

  // Halo around the silhouette breathes with the voice (closest approach of the ray to the centre).
  let miss = sqrt(max(0.0, dot(ro, ro) - b * b)) - (0.74 + 0.1 * low);
  let glow = exp(-max(miss, 0.0) * (5.0 - 2.0 * energy));
  col += mix(a.c1.rgb, a.c2.rgb, 0.5 + 0.5 * sin(t * 0.3)) * glow * (0.12 + 0.5 * energy + 0.8 * punch);

  if (hit) {
    let n = orb_normal(p, t, low, mid, high, punch);
    let v = -rd;
    let ndv = clamp(dot(n, v), 0.0, 1.0);
    let fres = pow(1.0 - ndv, 2.5);
    let L = normalize(vec3f(-0.5, 0.7, 0.6));
    let diff = clamp(dot(n, L), 0.0, 1.0);
    let spec = pow(clamp(dot(reflect(-L, n), v), 0.0, 1.0), 64.0);

    // Glassy body: dark core, a studio softbox reflected on the top.
    let rf = reflect(rd, n);
    let softbox = smoothstep(0.35, 0.75, rf.y) * smoothstep(1.0, 0.2, abs(rf.x));
    var s = mix(a.c1.rgb, a.c3.rgb, 0.5 - 0.5 * n.x) * (0.10 + 0.35 * diff);

    // Thin-film iridescence: the three colours cycle with the viewing angle.
    let ph = ndv * 2.2 + n.y * 0.6 + t * 0.05;
    let wts = 0.5 + 0.5 * cos(2.0 * PI * (ph + vec3f(0.0, 0.33, 0.67)));
    let film = (a.c1.rgb * wts.x + a.c2.rgb * wts.y + a.c3.rgb * wts.z) / (wts.x + wts.y + wts.z + 0.001);
    s += mix(film, vec3f(1.0), 0.15) * (0.25 + 1.35 * fres) * (0.8 + 0.5 * high);
    s += vec3f(1.0) * softbox * (0.22 + 0.25 * mid);
    s += vec3f(1.0) * spec * (0.7 + 0.9 * punch);
    // Rim light from behind in the third colour.
    s += mix(a.c3.rgb, vec3f(1.0), 0.3) * pow(1.0 - ndv, 5.0) * (0.7 + 0.8 * energy);
    col = s;
  }
  return col;
}

// Style 4 ("akis", shown as Sırtlar; the id stays so saved projects keep it): the sound's last
// seconds as lines stacked one above another, as on Unknown Pleasures' cover. The front line is
// the sound now; each step it moves back, keeping its shape, and the one before hides what is
// behind it. The bass raises broad peaks in the middle, the mids smaller ones, the highs a fine
// rasp; a punch lights the front line.
fn n1(x: f32, s: f32) -> f32 {
  let i = floor(x);
  let f = fract(x);
  let u = f * f * (3.0 - 2.0 * f);
  return mix(hash2(vec2f(i, s)), hash2(vec2f(i + 1.0, s)), u);
}

// The tallest a peak gets, in lines: heights ease off towards it, so the loudest sound still fits.
const RIDGE_MAX = 7.0;
fn ridge_squash(raw: f32) -> f32 {
  return RIDGE_MAX * (1.0 - exp(-raw / RIDGE_MAX));
}

fn ridge_height(x: f32, id: f32, h: vec4f, half_w: f32) -> f32 {
  // Flat towards the ends, the peaks in the middle.
  let e = x / (half_w * 0.5);
  let env = exp(-e * e);
  let wl = n1(x * 9.0, id);
  let wm = n1(x * 26.0, id + 101.0);
  let wh = n1(x * 90.0, id + 211.0);
  // Peaks even in a pause (the cover's look); the voice raises them well over the lines behind.
  let rest = n1(x * 40.0, id + 307.0) * 0.15;
  return ridge_squash(rest + env * (1.1 * wl * wl + h.x * 5.0 * wl * wl + h.y * 2.4 * wm + h.z * 0.7 * wh + h.w * 1.6 * wl));
}

fn draw_akis(uv: vec2f, aspect: f32, t: f32, low: f32, mid: f32, high: f32, punch: f32) -> vec3f {
  let energy = (low + mid + high) / 3.0;
  let ground = mix(a.c1.rgb, a.c3.rgb, 0.5) * 0.025;
  let sx = (uv.x - 0.5) * aspect;
  // The lines run across the whole frame, edge to edge; the peaks stay in its middle.
  let half_w = aspect * 0.34;
  // The lines and the room above the back one for its tallest peak fit between 6% and 90% of the height.
  let bottom = 0.9;
  let gap = (bottom - 0.06) / (f32(ROWS) + RIDGE_MAX);
  let top = bottom - f32(ROWS) * gap;
  let scale = a.res.y / 1080.0;
  // A faint glow behind the peaks.
  var col = ground + a.c1.rgb * 0.05 * exp(-dot(vec2f(sx, uv.y - 0.55), vec2f(sx, uv.y - 0.55)) * 6.0) * (0.7 + 0.6 * energy);

  let n = a.c1.w;
  let phase = a.c2.w;
  // Only the lines that can reach this pixel: a line well above it only hides it (the pixel is
  // under its body), one further below than its tallest peak here never gets up to it. Away from
  // the middle the peaks are low, so there only a line or two is looked at.
  var peak = vec4f(0.0);
  for (var k = 0; k < ROWS; k++) { peak = max(peak, a.hist[k]); }
  let e = sx / (half_w * 0.5);
  let env = exp(-e * e);
  let tallest = ridge_squash(0.15 + env * (1.1 + 5.0 * peak.x + 2.4 * peak.y + 0.7 * peak.z + 1.6 * peak.w)) * gap + 2.0 / a.res.y;
  let i_back = min(ROWS - 1, i32(ceil((bottom - uv.y) / gap - phase)) + 1);
  let i_front = max(0, i32(floor((bottom - uv.y - tallest) / gap - phase)));
  if (i_back < ROWS - 2 && uv.y > top) { col = ground; }
  // Back to front, each line's dark body hiding the ones behind it.
  for (var i = i_back; i >= i_front; i--) {
    let pos = f32(i) + phase;
    let base = bottom - pos * gap;
    let h = a.hist[i];
    let id = n - f32(i) + 1.0;
    let ex = aspect / a.res.x;
    let r0 = ridge_height(sx, id, h, half_w) * gap;
    let crest = base - r0;
    let dy = uv.y - crest;
    // Distance to the line in pixels, the same on its steep sides as on the flat. The slope is
    // worked out here: screen derivatives do not hold in a loop whose length differs per pixel.
    let slope = (ridge_height(sx + ex, id, h, half_w) * gap - r0) / ex;
    let px = abs(dy) * a.res.y / sqrt(1.0 + slope * slope);
    let age = pos / f32(ROWS);
    // The back line fades out before it leaves; the front one fades in as it is born.
    let vis = (1.0 - smoothstep(f32(ROWS) - 2.0, f32(ROWS), pos)) * smoothstep(0.0, 1.0, pos);
    if (dy > 0.0) {
      col = mix(col, ground, vis);
    }
    let tint = mix(mix(a.c2.rgb, vec3f(1.0), 0.7), a.c1.rgb, age * 0.5);
    let lit = (0.6 + 0.5 * (1.0 - age)) * (0.85 + 0.45 * (h.x + h.y + h.z) / 3.0) + select(0.0, 0.8 * punch, i == 0);
    let line = 1.0 - smoothstep(0.9 * scale, 2.0 * scale, px);
    col = mix(col, tint * lit, line * vis);
    // A soft light just above the line.
    if (dy < 0.0) {
      col += tint * exp(dy * a.res.y / (10.0 * scale)) * 0.08 * lit * vis;
    }
  }
  let c = uv - 0.5;
  col *= 1.0 - 0.5 * dot(c, c);
  return col + (hash(floor(uv * a.res)) - 0.5) * 0.01;
}

@fragment fn fs_aura(in: VsOut) -> @location(0) vec4f {
  let aspect = a.res.x / a.res.y;
  let t = a.time;
  let low = a.levels.x;
  let mid = a.levels.y;
  let high = a.levels.z;
  let punch = a.levels.w;
  let energy = (low + mid + high) / 3.0;

  var col = vec3f(0.0);
  if (a.style > 3.5) {
    col = draw_akis(in.uv, aspect, t, low, mid, high, punch);
  } else if (a.style > 2.5) {
    col = draw_kure(in.uv, aspect, t, low, mid, high, punch);
  } else if (a.style > 1.5) {
    col = draw_spektrum(in.uv, aspect, t, low, mid, high, punch);
  } else if (a.style > 0.5) {
    col = draw_halo(in.uv, aspect, t, low, mid, high, punch);
  } else {
    // Classic Aura: mesh gradient + 3 soft ribbons.
    let uvw = in.uv + 0.025 * vec2f(sin(in.uv.y * 3.0 + t * 0.17), cos(in.uv.x * 2.6 - t * 0.13));
    col = mesh(uvw, aspect, t, energy);
    col *= 0.62 + 0.22 * energy;

    let px = 1.0 / a.res.y;
    let kick = 0.35 * punch;
    col += mix(a.c1.rgb, vec3f(1.0), 0.55) * ribbon(in.uv, t, min(1.0, low + kick), 0.0, px);
    col += mix(a.c2.rgb, vec3f(1.0), 0.55) * ribbon(in.uv, t, min(1.0, mid + kick), 1.0, px);
    col += mix(a.c3.rgb, vec3f(1.0), 0.55) * ribbon(in.uv, t, min(1.0, high + kick), 2.0, px);
  }

  // Soft vignette keeps captions readable; dither prevents banding.
  let v = in.uv - 0.5;
  col *= 1.0 - 0.55 * dot(v, v);
  col = col / (1.0 + col * 0.35);
  col += (hash(in.uv * a.res + fract(t)) - 0.5) / 255.0;
  return vec4f(col, 1.0);
}
`;
