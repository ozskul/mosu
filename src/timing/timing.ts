/**
 * Timing math: converting between time (ms) and musical beats, beat snapping,
 * and BPM tapping. All of this is pure and unit-tested (see test/timing.test.ts).
 */
import type { TimingPoint } from "../types.ts";

/** Snap divisors offered in the UI. A divisor of N means 1/N of a beat. */
export const SNAP_DIVISORS = [1, 2, 3, 4, 6, 8, 12, 16] as const;
export type SnapDivisor = (typeof SNAP_DIVISORS)[number];

/** Milliseconds per beat for a given BPM. */
export function beatLengthFromBpm(bpm: number): number {
  return 60000 / bpm;
}

export function bpmFromBeatLength(beatLength: number): number {
  return 60000 / beatLength;
}

/** All uninherited (BPM) points, sorted by time. */
export function uninheritedPoints(points: TimingPoint[]): TimingPoint[] {
  return points
    .filter((p) => p.uninherited)
    .sort((a, b) => a.time - b.time);
}

/**
 * Return the active uninherited (BPM) timing point at the given time.
 * Falls back to the first point if `time` precedes every point, and to a
 * synthetic 120 BPM point if there are none at all.
 */
export function activeBpmPoint(points: TimingPoint[], time: number): TimingPoint {
  const reds = uninheritedPoints(points);
  if (reds.length === 0) {
    return {
      time: 0,
      uninherited: true,
      bpm: 120,
      sv: 1,
      meter: 4,
      volume: 100,
      sampleSet: 0,
      sampleIndex: 0,
      effects: 0,
    };
  }
  let active = reds[0];
  for (const p of reds) {
    if (p.time <= time) active = p;
    else break;
  }
  return active;
}

/**
 * Snap a time to the nearest sub-beat boundary, measured relative to the
 * controlling BPM point's offset. Returns the snapped time in ms.
 */
export function snapTime(
  points: TimingPoint[],
  time: number,
  divisor: number,
): number {
  const bpm = activeBpmPoint(points, time);
  const beat = beatLengthFromBpm(bpm.bpm);
  const step = beat / divisor;
  const rel = time - bpm.time;
  const snappedRel = Math.round(rel / step) * step;
  return bpm.time + snappedRel;
}

/** Step one snap unit forward (`dir = 1`) or backward (`dir = -1`) from time. */
export function stepTime(
  points: TimingPoint[],
  time: number,
  divisor: number,
  dir: 1 | -1,
): number {
  const bpm = activeBpmPoint(points, time);
  const beat = beatLengthFromBpm(bpm.bpm);
  const step = beat / divisor;
  const rel = time - bpm.time;
  // Snap to grid first, then move one step, so repeated steps stay aligned.
  const snappedRel = Math.round(rel / step) * step;
  // If we were already essentially on a boundary, move a full step; otherwise
  // moving toward `dir` should land on the next boundary in that direction.
  const onBoundary = Math.abs(rel - snappedRel) < 1e-6;
  let targetRel: number;
  if (onBoundary) {
    targetRel = snappedRel + dir * step;
  } else {
    targetRel = dir > 0 ? Math.ceil(rel / step) * step : Math.floor(rel / step) * step;
  }
  return bpm.time + targetRel;
}

/**
 * Determine which snap divisor a given time aligns to, relative to the active
 * BPM point. Returns the coarsest matching divisor (1 = downbeat line) or
 * null if it does not align to any supported divisor. Used to colour-code the
 * beat grid lines.
 */
export function snapColorIndex(
  points: TimingPoint[],
  time: number,
  divisors: readonly number[] = SNAP_DIVISORS,
): number | null {
  const bpm = activeBpmPoint(points, time);
  const beat = beatLengthFromBpm(bpm.bpm);
  const rel = time - bpm.time;
  const eps = 1e-3;
  for (const d of divisors) {
    const step = beat / d;
    const k = rel / step;
    if (Math.abs(k - Math.round(k)) < eps / step) {
      return d;
    }
  }
  return null;
}

/**
 * Generate the times of grid lines between `startMs` and `endMs` for a given
 * divisor, along with the finest divisor each line aligns to (for colouring).
 */
export function gridLines(
  points: TimingPoint[],
  startMs: number,
  endMs: number,
  divisor: number,
): Array<{ time: number; divisor: number }> {
  const reds = uninheritedPoints(points);
  if (reds.length === 0) {
    return gridLinesForBpm(
      { time: 0, beat: beatLengthFromBpm(120) },
      startMs,
      endMs,
      divisor,
    );
  }

  const lines: Array<{ time: number; divisor: number }> = [];
  for (let i = 0; i < reds.length; i++) {
    const p = reds[i];
    const next = reds[i + 1];
    const segStart = Math.max(startMs, p.time);
    const segEnd = next ? Math.min(endMs, next.time) : endMs;
    if (segEnd < segStart) continue;
    const beat = beatLengthFromBpm(p.bpm);
    for (const line of gridLinesForBpm({ time: p.time, beat }, segStart, segEnd, divisor)) {
      lines.push(line);
    }
  }
  return lines;
}

function gridLinesForBpm(
  point: { time: number; beat: number },
  startMs: number,
  endMs: number,
  divisor: number,
): Array<{ time: number; divisor: number }> {
  const step = point.beat / divisor;
  const lines: Array<{ time: number; divisor: number }> = [];
  const firstK = Math.ceil((startMs - point.time) / step - 1e-6);
  const lastK = Math.floor((endMs - point.time) / step + 1e-6);
  for (let k = firstK; k <= lastK; k++) {
    const t = point.time + k * step;
    // Determine the finest divisor this line aligns to for colouring.
    const fine = fineDivisor(k, divisor);
    lines.push({ time: t, divisor: fine });
  }
  return lines;
}

/** Given a line at index k within `divisor` subdivisions, find its musical divisor. */
function fineDivisor(k: number, divisor: number): number {
  if (k % divisor === 0) return 1; // whole beat / downbeat
  for (const d of SNAP_DIVISORS) {
    if (d > divisor) break;
    if ((k * d) % divisor === 0) return d;
  }
  return divisor;
}

/**
 * Find the timing-point offset (ms) that best aligns a beat grid of the given
 * BPM to a set of detected onset times — i.e. the phase that lands the most
 * onsets on (or near) beat lines. Returns an offset in [0, beatLength).
 *
 * Each onset's phase within a beat is a candidate; the best-scoring candidate
 * (closest onsets, distance-weighted) is then refined with a circular mean of
 * the onsets near it.
 */
export function alignOffsetToOnsets(onsets: readonly number[], bpm: number): number {
  if (onsets.length === 0) return 0;
  const period = beatLengthFromBpm(bpm);
  const tol = Math.min(40, period * 0.18);

  const phaseOf = (t: number) => ((t % period) + period) % period;
  const circDist = (a: number) => {
    const d = Math.abs(a);
    return Math.min(d, period - d);
  };

  let bestPhase = 0;
  let bestScore = -1;
  for (const o of onsets) {
    const phase = phaseOf(o);
    let score = 0;
    for (const x of onsets) {
      const d = circDist(((x - phase) % period + period) % period);
      if (d <= tol) score += 1 - d / tol;
    }
    if (score > bestScore) {
      bestScore = score;
      bestPhase = phase;
    }
  }

  // Refine: average the signed offsets of nearby onsets from the candidate.
  let sum = 0;
  let count = 0;
  for (const x of onsets) {
    let signed = ((x - bestPhase) % period + period) % period;
    if (signed > period / 2) signed -= period; // nearest beat, signed
    if (Math.abs(signed) <= tol) {
      sum += signed;
      count++;
    }
  }
  const refined = count > 0 ? bestPhase + sum / count : bestPhase;
  return Math.round(((refined % period) + period) % period);
}

/**
 * Estimate BPM from a series of tap timestamps (ms). Uses the average interval
 * across the taps. Returns null if there are fewer than two taps.
 */
export function bpmFromTaps(taps: number[]): number | null {
  if (taps.length < 2) return null;
  const first = taps[0];
  const last = taps[taps.length - 1];
  const intervals = taps.length - 1;
  const avg = (last - first) / intervals;
  if (avg <= 0) return null;
  return 60000 / avg;
}
