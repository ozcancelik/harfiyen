import type { Cue } from "../lib/cues";
import type { Word } from "../engine";

// "2D Kamera": each phrase is set as a justified block of lines in a world
// the camera travels through. The line being said is justified to the words
// said so far, so every new word pushes the ones before it aside and smaller;
// small words (ve, bir, the) stand sideways at the head of a line. When a
// phrase ends the camera pulls back over its block, then turns 90° (every
// second phrase) and travels to the next one, the old blocks staying behind.
// Everything is a function of time, so the export matches the preview.

/** Font size the layout is measured at; the drawing scales from it. */
export const REF = 100;
/** Width of every block, in world units. */
export const BLOCK_W = 1000;
/** A line is never taller than this share of the block's width (a single short word would be huge). */
const MAX_LINE_H = 0.42;
const WORD_GAP = REF * 0.2;
/** How far ahead of its start a word comes in, so it lands on the syllable. */
export const WORD_LEAD = 0.05;
/** How long the push of a new word takes. */
export const PUSH_DUR = 0.32;
const BLOCK_GAP = BLOCK_W * 0.12;

const STOP: Record<string, Set<string>> = {
  tr: new Set("ve ile bir bu şu o da de ki mi mı mu mü için gibi ama en ne ya hem veya ise".split(" ")),
  en: new Set("the a an and of to in on is it for with at or but as by".split(" ")),
};

const bare = (text: string, lang: string) => text.toLocaleLowerCase(lang).replace(/[^\p{L}\p{N}]/gu, "");

export interface CamItem {
  text: string;
  word: Word;
  /** Width at REF·f. */
  w: number;
  /** Size against the line's other words: small words are smaller. */
  f: number;
  /** Stood sideways at the head of the line; its footprint is its cap height. */
  tag: boolean;
  stop: boolean;
  loud: boolean;
}

/** A line set with its first n items: scale, left edge of each item, cap height. */
export interface LineLayout {
  s: number;
  xs: number[];
  h: number;
}

export interface CamLine {
  items: CamItem[];
  /** layouts[n - 1]: the line with its first n items. */
  layouts: LineLayout[];
  top: number;
}

export interface CamBlock {
  lines: CamLine[];
  height: number;
  ox: number;
  oy: number;
  angle: number;
  start: number;
  end: number;
  /** When the camera sets off for it: from here on it is the block being said. */
  enter: number;
}

export interface CamState {
  x: number;
  y: number;
  angle: number;
  zoom: number;
}

interface CamMove {
  start: number;
  dur: number;
  from: CamState;
  to: CamState;
  ease: (p: number) => number;
  /** How far the camera pulls back mid-move (0 for none). */
  breath: number;
}

export interface CamWorld {
  blocks: CamBlock[];
  moves: CamMove[];
  capRef: number;
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
export const backOut = (x: number, k = 1.4) => {
  const t = clamp01(x) - 1;
  return 1 + (k + 1) * t * t * t + k * t * t;
};
const inOut = (x: number) => {
  const t = clamp01(x);
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
};
const smoothBack = (x: number, k = 1.1) => {
  const t = clamp01(x);
  return Math.sin((t * Math.PI) / 2) * backOut(t, k);
};

/** Text measurer: width of the text at REF px, and the cap height at REF px. */
export interface Measure {
  width(text: string): number;
  cap: number;
}

/** Lines of a phrase: a loud word stands alone, a small word does not end a line. */
function breakLines(items: CamItem[], maxChars: number): CamItem[][] {
  const lines: CamItem[][] = [];
  let line: CamItem[] = [];
  let chars = 0;
  for (const it of items) {
    const len = [...it.text].length;
    const lineLoud = line.some((x) => x.loud && !x.stop);
    const onlyStops = line.every((x) => x.stop);
    if (line.length && !onlyStops && (chars + len > maxChars || line.length >= 3 || (it.loud && !it.stop) || lineLoud)) {
      lines.push(line);
      line = [];
      chars = 0;
    }
    line.push(it);
    chars += len;
  }
  if (line.length) lines.push(line);
  // A small word at the end of a line goes to the head of the next.
  for (let i = 0; i < lines.length - 1; i++) {
    const l = lines[i];
    if (l.length > 1 && l[l.length - 1].stop) lines[i + 1].unshift(l.pop()!);
  }
  return lines;
}

/** Sets the first n items of a line across the block, centred, no taller than MAX_LINE_H. */
function setLine(items: CamItem[], n: number, cap: number): LineLayout {
  const shown = items.slice(0, n);
  const natural = shown.reduce((a, it) => a + it.w, 0) + WORD_GAP * (n - 1);
  const fmax = Math.max(...shown.map((it) => (it.tag ? 0 : it.f)), 0.6);
  const s = Math.min(BLOCK_W / natural, (BLOCK_W * MAX_LINE_H) / (cap * fmax));
  let x = (BLOCK_W - natural * s) / 2;
  const xs = shown.map((it) => {
    const at = x;
    x += (it.w + WORD_GAP) * s;
    return at;
  });
  return { s, xs, h: cap * fmax * s };
}

const lineGap = (h: number) => BLOCK_W * 0.03 + h * 0.14;

/** A rect of the block (local) in world coordinates: its bounding box. */
function worldBox(b: { ox: number; oy: number; angle: number }, w: number, h: number) {
  const c = Math.cos(b.angle);
  const s = Math.sin(b.angle);
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [lx, ly] of [
    [0, 0],
    [w, 0],
    [0, h],
    [w, h],
  ]) {
    xs.push(b.ox + c * lx - s * ly);
    ys.push(b.oy + s * lx + c * ly);
  }
  return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
}

export function toWorld(b: CamBlock, lx: number, ly: number) {
  const c = Math.cos(b.angle);
  const s = Math.sin(b.angle);
  return { x: b.ox + c * lx - s * ly, y: b.oy + s * lx + c * ly };
}

/**
 * The world for these phrases: blocks laid out, and the camera's moves. `screenW` and
 * `screenH` set the zoom; `loud` marks words said louder than those around them.
 */
export function buildCameraWorld(
  groups: Cue[],
  measure: Measure,
  upper: (text: string) => string,
  loud: Set<Word>,
  lang: string,
  screenW: number,
  screenH: number,
): CamWorld {
  const cap = measure.cap;
  const stops = STOP[lang.split("-")[0]] ?? new Set<string>();
  const maxChars = screenW < screenH ? 10 : 13;
  const blocks: CamBlock[] = [];

  groups.forEach((g, gi) => {
    const items: CamItem[] = g.words.map((word) => {
      const text = upper(word.text);
      const stop = stops.has(bare(word.text, lang));
      const f = stop ? 0.62 : 1;
      return { text, word, w: measure.width(text) * f, f, tag: false, stop, loud: loud.has(word) };
    });
    const lines = breakLines(items, maxChars).map((its) => {
      // A small word heading a line stands sideways, as tall as the line's capitals.
      if (its.length > 1 && its[0].stop) {
        const t = its[0];
        const len = measure.width(t.text);
        t.tag = true;
        t.f = Math.min(0.85, (0.95 * cap) / len);
        t.w = cap * t.f * 1.15;
      }
      return its;
    });
    let top = 0;
    const camLines: CamLine[] = lines.map((its) => {
      const layouts = its.map((_, i) => setLine(its, i + 1, cap));
      // A sideways word alone would be set as large as a line can be: it waits at the size the next word gives it.
      if (its[0].tag) layouts[0] = { s: layouts[1].s, xs: [layouts[1].xs[0]], h: layouts[1].h };
      const line = { items: its, layouts, top };
      top += layouts[layouts.length - 1].h + lineGap(layouts[layouts.length - 1].h);
      return line;
    });
    const last = camLines[camLines.length - 1];
    const height = last.top + last.layouts[last.layouts.length - 1].h;

    // Two phrases one way, the next two turned 90°: the camera turns with them.
    const angle = Math.floor(gi / 2) % 2 === 0 ? 0 : -Math.PI / 2;
    let ox = 0;
    let oy = 0;
    const prev = blocks[blocks.length - 1];
    if (prev && prev.angle === angle) {
      // The same way: below the last one, as the next paragraph.
      const c = Math.cos(angle);
      const s = Math.sin(angle);
      const ly = prev.height + BLOCK_GAP;
      ox = prev.ox - s * ly;
      oy = prev.oy + c * ly;
    } else if (prev) {
      // Turned: beside the last one, top-aligned.
      const pb = worldBox(prev, BLOCK_W, prev.height);
      const nb = worldBox({ ox: 0, oy: 0, angle }, BLOCK_W, height);
      ox = pb.x1 + BLOCK_GAP - nb.x0;
      oy = pb.y0 - nb.y0;
    }
    blocks.push({ lines: camLines, height, ox, oy, angle, start: g.start, end: g.end, enter: g.start });
  });

  // The camera: over the line being said, back over the block when the phrase ends, on to the next.
  const fitW = (screenW * 0.8) / BLOCK_W;
  const lineState = (b: CamBlock, k: number): CamState => {
    const l = b.lines[k];
    const h = l.layouts[l.layouts.length - 1].h;
    // A little above the line's middle, so the line before it shows too.
    const c = toWorld(b, BLOCK_W / 2, l.top + h * 0.4);
    return { x: c.x, y: c.y, angle: b.angle, zoom: Math.min(fitW, (screenH * 0.5) / h) };
  };
  const revealState = (b: CamBlock): CamState => {
    const c = toWorld(b, BLOCK_W / 2, b.height / 2);
    return { x: c.x, y: c.y, angle: b.angle, zoom: Math.min((screenW * 0.84) / BLOCK_W, (screenH * 0.78) / b.height) };
  };

  const raw: Omit<CamMove, "from">[] = [];
  blocks.forEach((b, i) => {
    const prevEnd = i > 0 ? blocks[i - 1].end : b.start - 1;
    // Not before the last phrase's last word is over: with no pause between them the move is quick.
    const arrive = b.start - 0.04;
    const leave = Math.max(arrive - 0.65, Math.min(arrive - 0.3, prevEnd + 0.15), prevEnd - 0.02);
    const travel = Math.max(0.18, arrive - leave);
    b.enter = arrive - travel;
    const turned = i > 0 && blocks[i - 1].angle !== b.angle;
    raw.push({
      start: b.enter,
      dur: travel,
      to: lineState(b, 0),
      ease: inOut,
      breath: i === 0 ? 0 : turned ? 0.32 : 0.16,
    });
    b.lines.forEach((l, k) => {
      if (k === 0) return;
      raw.push({ start: l.items[0].word.start - 0.14, dur: 0.42, to: lineState(b, k), ease: (p) => smoothBack(p, 1.1), breath: 0 });
    });
    // Back over the whole block, when there is time before the next phrase.
    const next = blocks[i + 1];
    const room = (next ? next.start - 0.7 : b.end + 2) - (b.end + 0.12);
    if (room > 0.35 && b.lines.length > 1) {
      raw.push({ start: b.end + 0.12, dur: Math.min(0.7, room), to: revealState(b), ease: inOut, breath: 0 });
    }
  });

  // Moves in time order, each from wherever the camera was when it began.
  const moves: CamMove[] = [];
  for (const m of raw) {
    const prev = moves[moves.length - 1];
    const start = prev ? Math.max(m.start, prev.start) : m.start;
    const from = prev ? stateOf(prev, start) : m.to;
    moves.push({ ...m, start, from });
  }
  return { blocks, moves, capRef: cap };
}

function lerpState(a: CamState, b: CamState, e: number): CamState {
  return {
    x: a.x + (b.x - a.x) * e,
    y: a.y + (b.y - a.y) * e,
    angle: a.angle + (b.angle - a.angle) * e,
    zoom: a.zoom + (b.zoom - a.zoom) * e,
  };
}

function stateOf(m: CamMove, t: number): CamState {
  const p = clamp01((t - m.start) / m.dur);
  const s = lerpState(m.from, m.to, m.ease(p));
  return m.breath ? { ...s, zoom: s.zoom * (1 - m.breath * Math.sin(Math.PI * p)) } : s;
}

/** The camera at time t. */
export function cameraAt(world: CamWorld, t: number): CamState {
  const { moves } = world;
  let lo = 0;
  let hi = moves.length - 1;
  let i = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (moves[mid].start <= t) {
      i = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return i < 0 ? moves[0].to : stateOf(moves[i], t);
}

/** The block the camera is on at time t: the last whose travel has begun; -1 before the first. */
export function blockAt(world: CamWorld, t: number): number {
  let i = -1;
  for (let k = 0; k < world.blocks.length; k++) {
    if (world.blocks[k].enter <= t) i = k;
    else break;
  }
  return i;
}

/** An item as drawn at time t: left edge, scale, and how far in it is (0 not yet, 1 settled). */
export interface PlacedItem {
  item: CamItem;
  x: number;
  s: number;
  /** Entry progress of a new word: it slides in and grows. */
  enter: number;
}

/** A line at time t: its items in place (pushed by the newest), and its cap height; null before its first word. */
export function lineAt(line: CamLine, t: number): { items: PlacedItem[]; h: number } | null {
  let n = 0;
  while (n < line.items.length && line.items[n].word.start - WORD_LEAD <= t) n++;
  if (!n) return null;
  if (n === 1) {
    const cur = line.layouts[0];
    const q = (t - (line.items[0].word.start - WORD_LEAD)) / PUSH_DUR;
    const e = q >= 1 ? 1 : clamp01(backOut(q, 1.2));
    return { items: [{ item: line.items[0], x: cur.xs[0], s: cur.s, enter: e }], h: cur.h };
  }
  // Accumulate each word's push in order so rapid words (< PUSH_DUR apart) never snap when the next word enters.
  let s = line.layouts[0].s;
  let h = line.layouts[0].h;
  const xs = new Array<number>(n);
  const enters = new Array<number>(n);
  xs[0] = line.layouts[0].xs[0];
  const q0 = (t - (line.items[0].word.start - WORD_LEAD)) / PUSH_DUR;
  enters[0] = q0 >= 1 ? 1 : clamp01(backOut(q0, 1.2));
  for (let k = 1; k < n; k++) {
    const target = line.layouts[k];
    const item = line.items[k];
    const q = (t - (item.word.start - WORD_LEAD)) / PUSH_DUR;
    if (q >= 1) {
      s = target.s;
      h = target.h;
      for (let i = 0; i <= k; i++) xs[i] = target.xs[i];
      enters[k] = 1;
    } else {
      // A loud word shoves harder.
      const e = backOut(q, item.loud ? 2.4 : 1.5);
      s += (target.s - s) * e;
      h += (target.h - h) * e;
      for (let i = 0; i < k; i++) xs[i] += (target.xs[i] - xs[i]) * e;
      xs[k] = target.xs[k];
      enters[k] = clamp01(q * 1.4);
    }
  }
  return {
    items: line.items.slice(0, n).map((item, i) => ({ item, x: xs[i], s, enter: enters[i] })),
    h,
  };
}
