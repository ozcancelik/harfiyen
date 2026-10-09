// Streaming 80-dim log-mel filterbank, numerically matching kaldi-native-fbank
// with the options sherpa-onnx uses for zipformer models:
//   16 kHz, 25 ms window, 10 ms shift, povey window, preemph 0.97,
//   remove DC offset, dither 0, snip_edges=false, 512-point FFT,
//   power spectrum, mel low 20 Hz, high -400 (=> 7600 Hz), log floor FLT_EPSILON.

const SAMPLE_RATE = 16000;
const FRAME_LEN = 400;
const FRAME_SHIFT = 160;
const FFT_SIZE = 512;
const PREEMPH = 0.97;
const LOW_FREQ = 20;
const HIGH_FREQ = SAMPLE_RATE / 2 - 400;
const FLT_EPSILON = 1.1920928955078125e-7;

const melScale = (f: number) => 1127.0 * Math.log(1.0 + f / 700.0);

interface MelBin {
  offset: number;
  weights: Float32Array;
}

function makeMelBanks(numBins: number): MelBin[] {
  const numFftBins = FFT_SIZE / 2;
  const fftBinWidth = SAMPLE_RATE / FFT_SIZE;
  const melLow = melScale(LOW_FREQ);
  const melHigh = melScale(HIGH_FREQ);
  const delta = (melHigh - melLow) / (numBins + 1);
  const bins: MelBin[] = [];
  for (let b = 0; b < numBins; b++) {
    const left = melLow + b * delta;
    const center = melLow + (b + 1) * delta;
    const right = melLow + (b + 2) * delta;
    const w = new Float32Array(numFftBins);
    let first = -1;
    let last = -1;
    for (let i = 0; i < numFftBins; i++) {
      const mel = melScale(fftBinWidth * i);
      if (mel > left && mel < right) {
        w[i] = mel <= center ? (mel - left) / (center - left) : (right - mel) / (right - center);
        if (first < 0) first = i;
        last = i;
      }
    }
    bins.push({ offset: first, weights: w.slice(first, last + 1) });
  }
  return bins;
}

function makePoveyWindow(): Float64Array {
  const w = new Float64Array(FRAME_LEN);
  const a = (2 * Math.PI) / (FRAME_LEN - 1);
  for (let i = 0; i < FRAME_LEN; i++) w[i] = Math.pow(0.5 - 0.5 * Math.cos(a * i), 0.85);
  return w;
}

/** In-place radix-2 complex FFT of size FFT_SIZE. */
class Fft {
  private rev = new Uint16Array(FFT_SIZE);
  private cos = new Float64Array(FFT_SIZE / 2);
  private sin = new Float64Array(FFT_SIZE / 2);

  constructor() {
    const bits = Math.log2(FFT_SIZE);
    for (let i = 0; i < FFT_SIZE; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.rev[i] = r;
    }
    for (let i = 0; i < FFT_SIZE / 2; i++) {
      this.cos[i] = Math.cos((-2 * Math.PI * i) / FFT_SIZE);
      this.sin[i] = Math.sin((-2 * Math.PI * i) / FFT_SIZE);
    }
  }

  transform(re: Float64Array, im: Float64Array) {
    const n = FFT_SIZE;
    for (let i = 0; i < n; i++) {
      const j = this.rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let start = 0; start < n; start += size) {
        for (let k = 0; k < half; k++) {
          const wr = this.cos[k * step];
          const wi = this.sin[k * step];
          const a = start + k;
          const b = a + half;
          const xr = re[b] * wr - im[b] * wi;
          const xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr; im[b] = im[a] - xi;
          re[a] += xr; im[a] += xi;
        }
      }
    }
  }
}

export class OnlineFbank {
  readonly dim: number;
  private melBanks: MelBin[];
  private window = makePoveyWindow();
  private fft = new Fft();
  private re = new Float64Array(FFT_SIZE);
  private im = new Float64Array(FFT_SIZE);
  private power = new Float64Array(FFT_SIZE / 2 + 1);

  // Waveform buffer; buf[0] is absolute sample index bufStart.
  private buf = new Float32Array(16000 * 4);
  private bufLen = 0;
  private bufStart = 0;
  private numSamples = 0;
  private nextFrame = 0;
  private finished = false;

  constructor(dim = 80) {
    this.dim = dim;
    this.melBanks = makeMelBanks(dim);
  }

  get framesComputed() {
    return this.nextFrame;
  }

  acceptWaveform(samples: Float32Array) {
    if (this.finished) throw new Error("fbank: input already finished");
    if (this.bufLen + samples.length > this.buf.length) {
      const next = new Float32Array(Math.max(this.buf.length * 2, this.bufLen + samples.length));
      next.set(this.buf.subarray(0, this.bufLen));
      this.buf = next;
    }
    this.buf.set(samples, this.bufLen);
    this.bufLen += samples.length;
    this.numSamples += samples.length;
  }

  inputFinished() {
    this.finished = true;
  }

  /** Compute every frame that is ready; calls onFrame with a reused buffer. */
  compute(onFrame: (feat: Float32Array) => void) {
    const out = new Float32Array(this.dim);
    const total = this.finished
      ? Math.floor((this.numSamples + FRAME_SHIFT / 2) / FRAME_SHIFT)
      : Infinity;
    while (this.nextFrame < total) {
      const start = this.nextFrame * FRAME_SHIFT + FRAME_SHIFT / 2 - FRAME_LEN / 2;
      if (!this.finished && start + FRAME_LEN > this.numSamples) break;
      this.computeFrame(start, out);
      onFrame(out);
      this.nextFrame++;
    }
    this.discard();
  }

  private sample(s: number): number {
    const n = this.numSamples;
    while (s < 0 || s >= n) s = s < 0 ? -s - 1 : 2 * n - 1 - s;
    return this.buf[s - this.bufStart];
  }

  private computeFrame(start: number, out: Float32Array) {
    const re = this.re;
    const im = this.im;
    let mean = 0;
    for (let i = 0; i < FRAME_LEN; i++) {
      const v = this.sample(start + i);
      re[i] = v;
      mean += v;
    }
    mean /= FRAME_LEN;
    for (let i = 0; i < FRAME_LEN; i++) re[i] -= mean;
    for (let i = FRAME_LEN - 1; i > 0; i--) re[i] -= PREEMPH * re[i - 1];
    re[0] -= PREEMPH * re[0];
    for (let i = 0; i < FRAME_LEN; i++) re[i] *= this.window[i];
    re.fill(0, FRAME_LEN);
    im.fill(0);
    this.fft.transform(re, im);
    for (let i = 0; i <= FFT_SIZE / 2; i++) this.power[i] = re[i] * re[i] + im[i] * im[i];
    for (let b = 0; b < this.dim; b++) {
      const { offset, weights } = this.melBanks[b];
      let e = 0;
      for (let k = 0; k < weights.length; k++) e += weights[k] * this.power[offset + k];
      out[b] = Math.log(Math.max(e, FLT_EPSILON));
    }
  }

  private discard() {
    // Keep everything from the first sample the next frame needs (frame 0
    // reflects into [0, 120), so nothing is dropped before it is computed).
    if (this.nextFrame === 0) return;
    const keepFrom = this.nextFrame * FRAME_SHIFT + FRAME_SHIFT / 2 - FRAME_LEN / 2;
    const drop = Math.min(keepFrom - this.bufStart, this.bufLen);
    if (drop < 16000) return;
    this.buf.copyWithin(0, drop, this.bufLen);
    this.bufLen -= drop;
    this.bufStart += drop;
  }
}
