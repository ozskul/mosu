/**
 * Song intensity analysis — a loudness/energy envelope over time, used to make
 * the auto-generator follow the music: denser, harder patterns during loud
 * sections (drops, choruses) and calmer patterns during quiet parts.
 *
 * Pure and testable: operates on anything shaped like an AudioBuffer.
 */
import type { AudioLike } from "./onsets.ts";

export interface IntensityEnvelope {
  /** Frame spacing in ms. */
  frameMs: number;
  /** Normalised loudness per frame, 0 (quiet) .. 1 (loud). */
  values: Float32Array;
}

export function computeIntensity(buffer: AudioLike, frameMs = 250): IntensityEnvelope {
  const sr = buffer.sampleRate;
  if (!sr || buffer.length === 0) return { frameMs, values: new Float32Array(0) };
  const mono = toMono(buffer);
  const frameLen = Math.max(1, Math.round((frameMs / 1000) * sr));
  const nFrames = Math.max(1, Math.floor(mono.length / frameLen));

  // RMS energy per frame.
  const rms = new Float32Array(nFrames);
  for (let f = 0; f < nFrames; f++) {
    const start = f * frameLen;
    let sum = 0;
    for (let i = start; i < start + frameLen; i++) sum += mono[i] * mono[i];
    rms[f] = Math.sqrt(sum / frameLen);
  }

  // Smooth (±1 frame moving average) to ride over individual hits.
  const smooth = new Float32Array(nFrames);
  for (let f = 0; f < nFrames; f++) {
    let s = 0;
    let n = 0;
    for (let j = f - 1; j <= f + 1; j++) {
      if (j < 0 || j >= nFrames) continue;
      s += rms[j];
      n++;
    }
    smooth[f] = s / n;
  }

  // Normalise between the 10th and 95th percentiles so quiet≈0, loud≈1 without
  // a single peak flattening everything.
  const sorted = [...smooth].sort((a, b) => a - b);
  const lo = percentile(sorted, 0.1);
  const hi = percentile(sorted, 0.95);
  const range = Math.max(1e-6, hi - lo);
  const values = new Float32Array(nFrames);
  for (let f = 0; f < nFrames; f++) {
    values[f] = clamp01((smooth[f] - lo) / range);
  }
  return { frameMs, values };
}

/** Intensity (0..1) at a given time; 0.5 (neutral) if there's no envelope. */
export function intensityAt(env: IntensityEnvelope, timeMs: number): number {
  if (env.values.length === 0) return 0.5;
  const idx = clampInt(Math.round(timeMs / env.frameMs), 0, env.values.length - 1);
  return env.values[idx];
}

/**
 * Detect "drops" — moments where the energy jumps up and stays high. Returns
 * their times (ms), at least ~4s apart.
 */
export function findDrops(env: IntensityEnvelope): number[] {
  const v = env.values;
  if (v.length < 8) return [];
  const minGapFrames = Math.max(1, Math.round(4000 / env.frameMs));
  const drops: number[] = [];
  let lastFrame = -minGapFrames - 1;
  for (let f = 3; f < v.length - 2; f++) {
    const before = (v[f - 3] + v[f - 2] + v[f - 1]) / 3;
    const after = (v[f] + v[f + 1] + v[f + 2]) / 3;
    if (after - before > 0.33 && after > 0.6 && f - lastFrame >= minGapFrames) {
      drops.push(Math.round(f * env.frameMs));
      lastFrame = f;
    }
  }
  return drops;
}

function toMono(buffer: AudioLike): Float32Array {
  const ch = buffer.numberOfChannels;
  const left = buffer.getChannelData(0);
  if (ch <= 1) return left;
  const right = buffer.getChannelData(1);
  const out = new Float32Array(left.length);
  for (let i = 0; i < left.length; i++) out[i] = (left[i] + right[i]) * 0.5;
  return out;
}

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const i = clampInt(Math.floor(p * (sortedAsc.length - 1)), 0, sortedAsc.length - 1);
  return sortedAsc[i];
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
function clampInt(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
