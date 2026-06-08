/**
 * Automatic osu!mania chart generator.
 *
 * Given the song's detected onsets (where it actually "hits") and a timing
 * grid, it builds a playable, musical chart:
 *
 *   1. Quantise each onset to the beat grid (so rhythms are clean) and dedupe.
 *   2. Thin to a target density via a minimum gap derived from the difficulty
 *      preset and a user density multiplier.
 *   3. Assign columns with a pattern engine that avoids awkward jacks, balances
 *      the hands, favours rolls/stairs, and places chords (jumps/hands) on a
 *      fraction of notes scaled by difficulty.
 *   4. Optionally turn notes in longer gaps into hold (long) notes.
 *
 * The output is deterministic for a given `seed`, so "regenerate" can re-roll.
 * Everything here is pure and unit-tested.
 */
import type { HitObject, TimingPoint } from "../types.ts";
import { activeBpmPoint, beatLengthFromBpm, snapTime } from "../timing/timing.ts";

export type DifficultyLevel = "easy" | "normal" | "hard" | "insane" | "expert";

export const DIFFICULTY_LEVELS: DifficultyLevel[] = [
  "easy",
  "normal",
  "hard",
  "insane",
  "expert",
];

interface Preset {
  /**
   * Finest grid resolution onsets may snap to (4 = 1/4, 8 = 1/8, 16 = 1/16).
   * Each onset snaps to whichever subdivision up to this it lines up with, so
   * the chart matches the song's actual rhythm (8ths, 16ths, triplets).
   */
  maxDivisor: number;
  /** Minimum spacing between consecutive notes, in beats. */
  minGapBeats: number;
  /** Maximum chord size. */
  maxChord: number;
}

const PRESETS: Record<DifficultyLevel, Preset> = {
  easy: { maxDivisor: 4, minGapBeats: 1.0, maxChord: 1 },
  normal: { maxDivisor: 8, minGapBeats: 0.5, maxChord: 2 },
  hard: { maxDivisor: 16, minGapBeats: 0.33, maxChord: 2 },
  insane: { maxDivisor: 16, minGapBeats: 0.25, maxChord: 3 },
  expert: { maxDivisor: 16, minGapBeats: 0.18, maxChord: 4 },
};

/** Recommended difficulty settings per generated level. */
export const OD_BY_LEVEL: Record<DifficultyLevel, number> = {
  easy: 4, normal: 5, hard: 7, insane: 8, expert: 8.5,
};
export const HP_BY_LEVEL: Record<DifficultyLevel, number> = {
  easy: 6, normal: 6.5, hard: 7.5, insane: 8, expert: 8,
};

export interface GenerateOptions {
  keyCount: number;
  level: DifficultyLevel;
  /** Note-count multiplier, ~0.5 (sparse) .. 1.4 (dense). Default 1. */
  density?: number;
  /** Allow hold (long) notes. Default true. */
  longNotes?: boolean;
  /** Hold-note frequency multiplier (0 = none, 2 = lots). Default 1. */
  lnAmount?: number;
  /** Chord/jump frequency multiplier (0 = none, 2 = lots). Default 1. */
  chordAmount?: number;
  /**
   * Song-intensity lookup (0..1) used to vary difficulty with the music —
   * denser/harder on loud parts (drops), calmer on quiet parts. Omit to disable.
   */
  intensityAt?: (timeMs: number) => number;
  /** How strongly intensity affects the chart, 0..1. Default 0.6. */
  intensityStrength?: number;
  /**
   * Pattern style. "auto" lets the intensity detector choose per section
   * (calm → long notes, mid → streams/staircases, loud → chords, expert drops →
   * chained short LNs). Or force one style for the whole chart.
   */
  style?: ChartStyle;
  /** PRNG seed for reproducibility. */
  seed?: number;
}

/** Pattern styles the generator can produce. */
export type ChartStyle =
  | "auto"
  | "stream"
  | "jumpstream"
  | "chordjack"
  | "staircase"
  | "longnote"
  | "lnchain";

export const CHART_STYLES: ChartStyle[] = [
  "auto", "stream", "jumpstream", "chordjack", "staircase", "longnote", "lnchain",
];

/**
 * Recommend an Overall Difficulty from a chart's note density (notes/second),
 * in the usual osu!mania range. Rounded to the nearest 0.5.
 */
export function recommendedOD(notes: { time: number }[]): number {
  if (notes.length < 2) return 7;
  const first = notes[0].time;
  const last = notes[notes.length - 1].time;
  const span = Math.max(1, (last - first) / 1000);
  const nps = notes.length / span;
  const od = 4 + nps * 0.55;
  return Math.round(clamp(od, 3, 9.5) * 2) / 2;
}

export function generateChart(
  onsets: readonly number[],
  timingPoints: TimingPoint[],
  opts: GenerateOptions,
): HitObject[] {
  const keys = Math.max(1, Math.floor(opts.keyCount));
  const level = opts.level;
  const preset = PRESETS[level];
  const density = clamp(opts.density ?? 1, 0.3, 1.6);
  const longNotes = opts.longNotes ?? true;
  const intensityAt = opts.intensityAt;
  const iStrength = clamp(opts.intensityStrength ?? 0.6, 0, 1);
  // Intensity factor centred on 1: loud (i=1) up to ~1+strength, quiet down to
  // ~1-strength. Used to scale density and chord chance with the music.
  const factorAt = (t: number) =>
    intensityAt ? 1 + iStrength * (intensityAt(t) - 0.5) * 1.6 : 1;
  const rng = mulberry32((opts.seed ?? 1) >>> 0);
  if (onsets.length === 0) return [];

  // 1. Quantise each onset to its natural subdivision (8th/16th/triplet) and
  //    dedupe, so the chart follows the song's real rhythm.
  const divisors = [1, 2, 3, 4, 6, 8, 12, 16].filter((d) => d <= preset.maxDivisor);
  const snapped: number[] = [];
  let lastSnap = NaN;
  for (const t of [...onsets].sort((a, b) => a - b)) {
    const s = Math.round(snapAdaptive(timingPoints, t, divisors));
    if (s !== lastSnap) {
      snapped.push(s);
      lastSnap = s;
    }
  }

  // 2. Thin by minimum gap (difficulty + density + song intensity).
  const times: number[] = [];
  let lastKept = -Infinity;
  for (const s of snapped) {
    const beat = beatLengthFromBpm(activeBpmPoint(timingPoints, s).bpm);
    // Louder sections shrink the gap (more notes); quiet sections widen it.
    const minGap = (preset.minGapBeats * beat) / (density * Math.max(0.35, factorAt(s)));
    if (s - lastKept >= minGap - 1) {
      times.push(s);
      lastKept = s;
    }
  }

  // 3. Build notes section-by-section, choosing a pattern style per ~2s window
  //    from the song's intensity (or a single forced style).
  const forced = opts.style && opts.style !== "auto" ? opts.style : null;
  const lnAmount = clamp(opts.lnAmount ?? 1, 0, 2);
  const chordAmount = clamp(opts.chordAmount ?? 1, 0, 2);
  const engine = new StyleEngine(keys, rng, lnAmount, chordAmount, preset.maxChord, longNotes);
  const styleCache = new Map<number, ChartStyle>();
  const out: HitObject[] = [];

  for (let i = 0; i < times.length; i++) {
    const t = times[i];
    const next = times[i + 1];
    const beat = beatLengthFromBpm(activeBpmPoint(timingPoints, t).bpm);
    const inten = intensityAt ? intensityAt(t) : 0.5;
    let style: ChartStyle;
    if (forced) {
      style = clampStyleToLevel(forced, level);
    } else {
      const win = Math.floor(t / 2000);
      style = styleCache.get(win) ??
        (styleCache.set(win, clampStyleToLevel(pickAutoStyle(inten, level, lnAmount, win), level)),
          styleCache.get(win)!);
    }
    engine.emit(out, style, t, next, beat);
  }

  out.sort((a, b) => a.time - b.time || a.column - b.column);
  return out;
}

/** Deterministic 0..1 value from an integer (for stable per-window choices). */
function hash01(n: number): number {
  const x = Math.sin(n * 12.9898 + 7.13) * 43758.5453;
  return x - Math.floor(x);
}

/** Choose a base pattern style for a section from its intensity + difficulty. */
export function pickAutoStyle(
  inten: number,
  level: DifficultyLevel,
  lnAmount: number,
  windowIdx: number,
): ChartStyle {
  let s: ChartStyle;
  if (inten < 0.22) s = "longnote";
  else if (inten < 0.42) s = "stream";
  else if (inten < 0.6) s = windowIdx % 2 === 0 ? "staircase" : "jumpstream";
  else if (inten < 0.8) s = "jumpstream";
  else s = "chordjack";

  // Expert drops favour chained short LNs for that combo-heavy pressure.
  if (level === "expert" && inten >= 0.78 && windowIdx % 3 === 0) s = "lnchain";

  // The hold-note amount biases sections toward long-note / LN-chain styles.
  const h = hash01(windowIdx);
  const lnBias = lnAmount - 1; // >0 means "more holds"
  if (lnBias > 0) {
    if ((s === "stream" || s === "staircase") && h < lnBias * 0.45) s = "longnote";
    else if (s === "jumpstream" && h < lnBias * 0.35) s = "longnote";
    else if (s === "chordjack" && (level === "expert" || level === "insane") && h < lnBias * 0.4) s = "lnchain";
  }
  return s;
}

const ALLOWED_STYLES: Record<DifficultyLevel, ChartStyle[]> = {
  easy: ["stream", "longnote"],
  normal: ["stream", "jumpstream", "staircase", "longnote"],
  hard: ["stream", "jumpstream", "staircase", "chordjack", "longnote"],
  insane: ["stream", "jumpstream", "staircase", "chordjack", "longnote", "lnchain"],
  expert: ["stream", "jumpstream", "staircase", "chordjack", "longnote", "lnchain"],
};

/** Map a style down to one this difficulty allows. */
export function clampStyleToLevel(style: ChartStyle, level: DifficultyLevel): ChartStyle {
  if (style === "auto") return "stream";
  if (ALLOWED_STYLES[level].includes(style)) return style;
  const fallback: Record<ChartStyle, ChartStyle> = {
    auto: "stream",
    stream: "stream",
    jumpstream: "stream",
    chordjack: "jumpstream",
    staircase: "stream",
    longnote: "stream",
    lnchain: "chordjack",
  };
  return clampStyleToLevel(fallback[style], level);
}

type HoldKind = "ambient" | "med" | "long" | "short";

/**
 * Builds notes one step at a time in a chosen style, keeping column state
 * (anti-jack, hand balance, rolls) and staircase position across steps. Long
 * notes are produced generously: long-note and LN-chain styles hold most notes,
 * and other styles sprinkle holds based on the hold-note amount.
 */
class StyleEngine {
  private load: number[];
  private prev: number[] = [];
  private stairPos = 0;
  private stairDir: 1 | -1 = 1;

  constructor(
    private keys: number,
    private rng: () => number,
    private lnAmount: number,
    private chordAmount: number,
    private maxChord: number,
    private longNotes: boolean,
  ) {
    this.load = new Array(keys).fill(0);
  }

  emit(out: HitObject[], style: ChartStyle, t: number, next: number | undefined, beat: number): void {
    switch (style) {
      case "stream":
        this.single(out, t, next, beat, "ambient");
        break;
      case "jumpstream":
        if (this.keys > 1 && this.rng() < 0.4 * this.chordAmount) this.chord(out, t, 2);
        else this.single(out, t, next, beat, "ambient");
        break;
      case "chordjack":
        this.chordjack(out, t);
        break;
      case "staircase":
        this.staircase(out, t, next, beat);
        break;
      case "longnote":
        this.single(out, t, next, beat, "long");
        break;
      case "lnchain":
        this.single(out, t, next, beat, "short");
        break;
      default:
        this.single(out, t, next, beat, "ambient");
    }
  }

  private single(out: HitObject[], t: number, next: number | undefined, beat: number, kind: HoldKind): void {
    const c = this.pick([]);
    this.register([c]);
    const end = this.maybeHold(t, next, beat, kind);
    out.push(end !== undefined ? { column: c, time: t, endTime: end, hitSound: 0 } : { column: c, time: t, hitSound: 0 });
  }

  private chord(out: HitObject[], t: number, size: number): void {
    const n = Math.min(size, this.maxChord, this.keys);
    const cols = this.pickMany(n);
    this.register(cols);
    for (const c of cols) out.push({ column: c, time: t, hitSound: 0 });
  }

  private chordjack(out: HitObject[], t: number): void {
    let size = 2;
    while (size < this.maxChord && size < this.keys && this.rng() < 0.35 * this.chordAmount) size++;
    // Occasionally repeat the previous columns (a jack) for chordjack pressure.
    let cols: number[];
    if (this.prev.length > 0 && this.rng() < 0.4) cols = this.prev.slice(0, Math.min(size, this.prev.length));
    else cols = this.pickMany(size);
    this.register(cols);
    for (const c of cols) out.push({ column: c, time: t, hitSound: 0 });
  }

  private staircase(out: HitObject[], t: number, next: number | undefined, beat: number): void {
    const c = Math.max(0, Math.min(this.keys - 1, this.stairPos));
    this.register([c]);
    this.stairPos += this.stairDir;
    if (this.stairPos > this.keys - 1) { this.stairPos = this.keys - 2; this.stairDir = -1; }
    else if (this.stairPos < 0) { this.stairPos = 1; this.stairDir = 1; }
    const end = this.maybeHold(t, next, beat, "ambient");
    out.push(end !== undefined ? { column: c, time: t, endTime: end, hitSound: 0 } : { column: c, time: t, hitSound: 0 });
  }

  /** Decide whether/how long this note holds, based on the style + LN amount. */
  private maybeHold(t: number, next: number | undefined, beat: number, kind: HoldKind): number | undefined {
    if (!this.longNotes || kind === undefined) return undefined;
    const prob =
      kind === "long" ? 0.9 * this.lnAmount :
      kind === "short" ? 0.85 * this.lnAmount :
      0.14 * this.lnAmount; // ambient holds in non-LN styles
    if (this.rng() >= prob) return undefined;

    const gap = (next ?? t + beat) - t;
    const release = clamp(gap * 0.15, 15, 60);
    let len: number;
    if (kind === "long") len = gap - release;
    else if (kind === "short") len = Math.min(gap - release, 0.6 * beat);
    else len = Math.min(gap - release, 1.0 * beat);
    const minLen = kind === "short" ? 0.12 * beat : 0.2 * beat;
    if (len < minLen) return undefined;
    return Math.round(t + Math.min(len, 6 * beat));
  }

  // ---- column selection (anti-jack, balance, rolls) ----------------------
  private pick(already: number[]): number {
    return weightedPick(this.weights(already), this.rng);
  }
  private pickMany(n: number): number[] {
    const picked: number[] = [];
    for (let i = 0; i < Math.min(n, this.keys); i++) picked.push(this.pick(picked));
    return picked.sort((a, b) => a - b);
  }
  private register(cols: number[]): void {
    for (const c of cols) this.load[c]++;
    this.prev = cols;
  }
  private weights(already: number[]): number[] {
    const maxLoad = Math.max(1, ...this.load);
    const w = new Array(this.keys).fill(1);
    for (let c = 0; c < this.keys; c++) {
      if (already.includes(c)) { w[c] = 0; continue; }
      if (already.length === 0 && this.prev.includes(c)) w[c] *= 0.18; // anti-jack
      w[c] *= 1.1 - 0.6 * (this.load[c] / maxLoad); // hand balance
      for (const p of already) if (Math.abs(p - c) === 1) w[c] *= 0.5; // spread chord
      if (already.length === 0) for (const p of this.prev) if (Math.abs(p - c) === 1) w[c] *= 1.5; // rolls
    }
    return w;
  }
}

/**
 * Snap a time to whichever candidate subdivision it aligns with best, with a
 * tiny penalty that favours coarser grids — so a note only snaps to 1/16 (or a
 * triplet) when it's genuinely closer there than at 1/8.
 */
function snapAdaptive(points: TimingPoint[], t: number, divisors: number[]): number {
  let best = t;
  let bestErr = Infinity;
  for (const d of divisors) {
    const st = snapTime(points, t, d);
    const err = Math.abs(st - t) + d * 0.15;
    if (err < bestErr) {
      bestErr = err;
      best = st;
    }
  }
  return best;
}

function weightedPick(weights: number[], rng: () => number): number {
  let total = 0;
  for (const x of weights) total += Math.max(0, x);
  if (total <= 0) return Math.floor(rng() * weights.length);
  let r = rng() * total;
  for (let i = 0; i < weights.length; i++) {
    r -= Math.max(0, weights[i]);
    if (r <= 0) return i;
  }
  return weights.length - 1;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** mulberry32 — a tiny, fast, seedable PRNG. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
