// Streaming band-limited resampler (port of Kaldi's LinearResample, which is
// what sherpa-onnx uses when the input is not 16 kHz).

function gcd(a: number, b: number): number {
  while (b) [a, b] = [b, a % b];
  return a;
}

export class Resampler {
  private readonly inRate: number;
  private readonly outRate: number;
  private readonly inUnit: number;
  private readonly outUnit: number;
  private readonly firstIndex: Int32Array;
  private readonly weights: Float32Array[];

  // Input history: buffer[0] is absolute input index histStart.
  private hist = new Float32Array(0);
  private histStart = 0;
  private inputCount = 0;
  private outputCount = 0;

  constructor(inRate: number, outRate: number, numZeros = 6) {
    this.inRate = Math.round(inRate);
    this.outRate = Math.round(outRate);
    const base = gcd(this.inRate, this.outRate);
    this.inUnit = this.inRate / base;
    this.outUnit = this.outRate / base;

    const cutoff = 0.99 * 0.5 * Math.min(this.inRate, this.outRate);
    const windowWidth = numZeros / (2 * cutoff);
    const filter = (t: number) => {
      if (Math.abs(t) >= windowWidth) return 0;
      const w = 0.5 * (1 + Math.cos(((2 * Math.PI) / numZeros) * cutoff * t));
      const f = t !== 0 ? Math.sin(2 * Math.PI * cutoff * t) / (Math.PI * t) : 2 * cutoff;
      return f * w;
    };

    this.firstIndex = new Int32Array(this.outUnit);
    this.weights = [];
    for (let i = 0; i < this.outUnit; i++) {
      const outT = i / this.outRate;
      const minIdx = Math.ceil((outT - windowWidth) * this.inRate);
      const maxIdx = Math.floor((outT + windowWidth) * this.inRate);
      const w = new Float32Array(maxIdx - minIdx + 1);
      for (let j = 0; j < w.length; j++) {
        w[j] = filter((minIdx + j) / this.inRate - outT) / this.inRate;
      }
      this.firstIndex[i] = minIdx;
      this.weights.push(w);
    }
  }

  get passthrough() {
    return this.inRate === this.outRate;
  }

  /** Push input samples; returns the output samples that became computable. */
  process(input: Float32Array, flush = false): Float32Array {
    if (this.passthrough) return input;

    const merged = new Float32Array(this.hist.length + input.length);
    merged.set(this.hist);
    merged.set(input, this.hist.length);
    this.inputCount += input.length;

    const numOut = flush
      ? Math.floor((this.inputCount * this.outRate) / this.inRate)
      : this.numReadyOutputs();
    const count = Math.max(0, numOut - this.outputCount);
    const out = new Float32Array(count);
    for (let k = 0; k < count; k++) {
      const n = this.outputCount + k;
      const unit = Math.floor(n / this.outUnit);
      const i = n - unit * this.outUnit;
      const first = unit * this.inUnit + this.firstIndex[i];
      const w = this.weights[i];
      let acc = 0;
      for (let j = 0; j < w.length; j++) {
        const idx = first + j;
        if (idx < 0 || idx >= this.inputCount) continue;
        acc += w[j] * merged[idx - this.histStart];
      }
      out[k] = acc;
    }
    this.outputCount += count;

    // Keep only the input still needed by the next output sample.
    const n = this.outputCount;
    const unit = Math.floor(n / this.outUnit);
    const need = Math.max(0, unit * this.inUnit + this.firstIndex[n - unit * this.outUnit]);
    const dropTo = Math.min(Math.max(need, this.histStart), this.inputCount);
    this.hist = merged.slice(dropTo - this.histStart);
    this.histStart = dropTo;
    return out;
  }

  private numReadyOutputs(): number {
    // Largest n such that output n-1 only needs inputs we already have.
    // The filter spans a few dozen samples, so this loop is short.
    let n = Math.floor((this.inputCount * this.outRate) / this.inRate);
    while (n > this.outputCount) {
      const m = n - 1;
      const unit = Math.floor(m / this.outUnit);
      const i = m - unit * this.outUnit;
      const last = unit * this.inUnit + this.firstIndex[i] + this.weights[i].length - 1;
      if (last < this.inputCount) break;
      n--;
    }
    return Math.max(n, this.outputCount);
  }
}

/** Average all channels into one. */
export function downmix(channels: Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0];
  const n = channels[0].length;
  const out = new Float32Array(n);
  for (const ch of channels) for (let i = 0; i < n; i++) out[i] += ch[i];
  const s = 1 / channels.length;
  for (let i = 0; i < n; i++) out[i] *= s;
  return out;
}
