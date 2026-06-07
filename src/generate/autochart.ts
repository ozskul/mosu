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
  /** Grid resolution onsets are quantised to (2 = 1/2 beat, 4 = 1/4 beat). */
  snapDivisor: number;
  /** Minimum spacing between consecutive notes, in beats. */
  minGapBeats: number;
  /** Probability a note becomes a chord (multiple columns). */
  chordChance: number;
  /** Maximum chord size. */
  maxChord: number;
  /** Probability a note in a long-enough gap becomes a hold. */
  lnChance: number;
  /** Minimum gap (beats) before a hold may be placed. */
  lnMinGapBeats: number;
}

const PRESETS: Record<DifficultyLevel, Preset> = {
  easy: { snapDivisor: 2, minGapBeats: 1.0, chordChance: 0.0, maxChord: 1, lnChance: 0.28, lnMinGapBeats: 1.0 },
  normal: { snapDivisor: 2, minGapBeats: 0.5, chordChance: 0.06, maxChord: 2, lnChance: 0.24, lnMinGapBeats: 0.5 },
  hard: { snapDivisor: 4, minGapBeats: 0.5, chordChance: 0.16, maxChord: 2, lnChance: 0.18, lnMinGapBeats: 0.5 },
  insane: { snapDivisor: 4, minGapBeats: 0.25, chordChance: 0.28, maxChord: 3, lnChance: 0.13, lnMinGapBeats: 0.5 },
  expert: { snapDivisor: 4, minGapBeats: 0.25, chordChance: 0.42, maxChord: 4, lnChance: 0.09, lnMinGapBeats: 0.5 },
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
  /** PRNG seed for reproducibility. */
  seed?: number;
}

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
  const preset = PRESETS[opts.level];
  const density = clamp(opts.density ?? 1, 0.3, 1.6);
  const longNotes = opts.longNotes ?? true;
  const lnChance = clamp(preset.lnChance * (opts.lnAmount ?? 1), 0, 0.95);
  const baseChord = clamp(preset.chordChance * (opts.chordAmount ?? 1), 0, 0.95);
  const intensityAt = opts.intensityAt;
  const iStrength = clamp(opts.intensityStrength ?? 0.6, 0, 1);
  // Intensity factor centred on 1: loud (i=1) up to ~1+strength, quiet down to
  // ~1-strength. Used to scale density and chord chance with the music.
  const factorAt = (t: number) =>
    intensityAt ? 1 + iStrength * (intensityAt(t) - 0.5) * 1.6 : 1;
  const rng = mulberry32((opts.seed ?? 1) >>> 0);
  if (onsets.length === 0) return [];

  // 1. Quantise to the grid + dedupe.
  const snapped: number[] = [];
  let lastSnap = NaN;
  for (const t of [...onsets].sort((a, b) => a - b)) {
    const s = Math.round(snapTime(timingPoints, t, preset.snapDivisor));
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

  // 3. Columns + objects.
  const pattern = new Pattern(keys, rng);
  const out: HitObject[] = [];
  for (let i = 0; i < times.length; i++) {
    const t = times[i];
    const next = times[i + 1];

    // More chords/jumps during intense parts.
    const chordChance = clamp(baseChord * factorAt(t), 0, 0.97);
    let size = 1;
    if (keys > 1 && rng() < chordChance) {
      size = 2;
      while (size < preset.maxChord && size < keys && rng() < 0.35) size++;
    }
    const cols = pattern.next(size);

    let endTime: number | undefined;
    if (longNotes && cols.length === 1 && next !== undefined) {
      const beat = beatLengthFromBpm(activeBpmPoint(timingPoints, t).bpm);
      const gap = next - t;
      if (gap >= preset.lnMinGapBeats * beat && rng() < lnChance) {
        // End a touch before the next note so the release is comfortable.
        endTime = Math.round(next - Math.min(gap * 0.25, beat * 0.25));
      }
    }

    for (const c of cols) {
      out.push(endTime !== undefined ? { column: c, time: t, endTime, hitSound: 0 } : { column: c, time: t, hitSound: 0 });
    }
  }

  out.sort((a, b) => a.time - b.time || a.column - b.column);
  return out;
}

/** Column-assignment engine: anti-jack, hand balance, rolls, spread chords. */
class Pattern {
  private prev: number[] = [];
  private load: number[];

  constructor(private keys: number, private rng: () => number) {
    this.load = new Array(keys).fill(0);
  }

  next(size: number): number[] {
    const n = Math.min(size, this.keys);
    const picked: number[] = [];
    for (let i = 0; i < n; i++) {
      const c = weightedPick(this.weights(picked), this.rng);
      picked.push(c);
      this.load[c]++;
    }
    this.prev = picked;
    return picked.sort((a, b) => a - b);
  }

  private weights(already: number[]): number[] {
    const maxLoad = Math.max(1, ...this.load);
    const w = new Array(this.keys).fill(1);
    for (let c = 0; c < this.keys; c++) {
      if (already.includes(c)) {
        w[c] = 0;
        continue;
      }
      // Discourage repeating the previous step's columns (anti-jack).
      if (already.length === 0 && this.prev.includes(c)) w[c] *= 0.18;
      // Balance the hands: prefer under-used columns.
      w[c] *= 1.1 - 0.6 * (this.load[c] / maxLoad);
      // Spread a chord out: discourage stacking adjacent columns.
      for (const p of already) if (Math.abs(p - c) === 1) w[c] *= 0.5;
      // Encourage rolls/stairs: lean toward columns next to the last note.
      if (already.length === 0) {
        for (const p of this.prev) if (Math.abs(p - c) === 1) w[c] *= 1.5;
      }
    }
    return w;
  }
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
