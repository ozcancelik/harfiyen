// LODR (low-order density ratio) bigram, port of sherpa-onnx lodr-fst.cc.
// The FST is pre-converted to a flat CSR layout by scripts/prepare_models.py.

/** state -> accumulated cost (tropical semiring, lower is better). */
export type LodrState = Map<number, number>;

export class LodrFst {
  private offsets: Int32Array;
  private ilabel: Int32Array;
  private next: Int32Array;
  private weight: Float32Array;
  private backoffId: number;

  constructor(buffer: ArrayBuffer) {
    const magic = new TextDecoder().decode(new Uint8Array(buffer, 0, 4));
    if (magic !== "LODR") throw new Error("lodr.bin: bad magic");
    const h = new DataView(buffer, 4, 20);
    const version = h.getUint32(0, true);
    if (version !== 1) throw new Error(`lodr.bin: unsupported version ${version}`);
    const numStates = h.getInt32(8, true);
    const numArcs = h.getInt32(12, true);
    this.backoffId = h.getInt32(16, true);
    let off = 24;
    const take = <T>(Ctor: new (b: ArrayBuffer, o: number, n: number) => T, n: number) => {
      const v = new Ctor(buffer, off, n);
      off += n * 4;
      return v;
    };
    // Final weights are only used by LM rescoring, not by shallow fusion.
    off += numStates * 4;
    this.offsets = take(Int32Array, numStates + 1);
    this.ilabel = take(Int32Array, numArcs);
    this.next = take(Int32Array, numArcs);
    this.weight = take(Float32Array, numArcs);
  }

  initialState(): LodrState {
    return new Map([[0, 0]]);
  }

  /** Binary search an arc with the given input label (no backoff). */
  private arc(state: number, label: number): number {
    let lo = this.offsets[state];
    let hi = this.offsets[state + 1] - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const l = this.ilabel[mid];
      if (l < label) lo = mid + 1;
      else if (l > label) hi = mid - 1;
      else return mid;
    }
    return -1;
  }

  private nextStateCosts(state: number, label: number, out: LodrState, base: number) {
    // The state itself, then every state reachable through backoff arcs.
    let s = state;
    let cost = 0;
    for (;;) {
      const a = this.arc(s, label);
      if (a >= 0) {
        const ns = this.next[a];
        const nc = base + cost + this.weight[a];
        const prev = out.get(ns);
        if (prev === undefined || nc < prev) out.set(ns, nc);
      }
      const b = this.arc(s, this.backoffId);
      if (b < 0) break;
      cost += this.weight[b];
      s = this.next[b];
    }
  }

  forward(state: LodrState, label: number): LodrState {
    const out: LodrState = new Map();
    for (const [s, c] of state) this.nextStateCosts(s, label, out, c);
    return out;
  }

  score(state: LodrState): number {
    let min = Infinity;
    for (const c of state.values()) if (c < min) min = c;
    return state.size === 0 ? -Infinity : -min;
  }
}
