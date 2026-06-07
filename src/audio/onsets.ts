/**
 * Onset (beat/transient) detection from decoded audio.
 *
 * This finds the moments where the song "hits" — drum beats, note attacks, etc.
 * — so the editor can draw them on the chart as alignment guides. It is separate
 * from tempo detection (which estimates a single BPM): here we want every
 * individual transient, not an average period.
 *
 * Method: a classic spectral-energy-flux detector.
 *  1. Mix to mono and slice into short overlapping frames (~10 ms hop).
 *  2. Per frame, compute log energy; the onset detection function (ODF) is the
 *     half-wave-rectified frame-to-frame increase in energy (a rise = an attack).
 *  3. Normalise, then peak-pick against an adaptive local-average threshold,
 *     enforcing a minimum gap so one hit isn't reported twice.
 *
 * Dependency-free and operates on anything shaped like an AudioBuffer.
 */

/** Minimal structural shape of a Web Audio AudioBuffer (so this is testable). */
export interface AudioLike {
  sampleRate: number;
  length: number;
  numberOfChannels: number;
  getChannelData(channel: number): Float32Array;
}

export interface OnsetOptions {
  /**
   * Higher = stricter (fewer onsets). This scales the adaptive threshold above
   * the local average. Typical range 0.3–2.0; default 1.0.
   */
  sensitivity?: number;
  /** Minimum spacing between reported onsets, in ms (default 70). */
  minGapMs?: number;
}

export function detectOnsets(buffer: AudioLike, opts: OnsetOptions = {}): number[] {
  const sensitivity = opts.sensitivity ?? 1.0;
  const minGapMs = opts.minGapMs ?? 70;
  const sr = buffer.sampleRate;
  if (!sr || buffer.length === 0) return [];

  const mono = toMono(buffer);
  const hop = Math.max(1, Math.round(sr * 0.01)); // ~10 ms frames
  const win = hop * 2;
  const frameCount = Math.floor((mono.length - win) / hop) + 1;
  if (frameCount < 3) return [];

  // Per-frame log energy.
  const energy = new Float32Array(frameCount);
  for (let f = 0; f < frameCount; f++) {
    const start = f * hop;
    let sum = 0;
    for (let i = start; i < start + win; i++) {
      const s = mono[i];
      sum += s * s;
    }
    energy[f] = Math.log(1 + sum);
  }

  // Onset detection function: half-wave-rectified positive energy change.
  const odf = new Float32Array(frameCount);
  let maxOdf = 0;
  for (let f = 1; f < frameCount; f++) {
    const d = energy[f] - energy[f - 1];
    odf[f] = d > 0 ? d : 0;
    if (odf[f] > maxOdf) maxOdf = odf[f];
  }
  if (maxOdf <= 0) return [];
  for (let f = 0; f < frameCount; f++) odf[f] /= maxOdf;

  // Adaptive threshold: local mean over a window, scaled by sensitivity.
  const half = Math.max(2, Math.round(0.1 / 0.01)); // ~±100 ms window
  const gapFrames = Math.max(1, Math.round((minGapMs / 1000) * sr / hop));

  const onsets: number[] = [];
  let lastFrame = -gapFrames - 1;
  for (let f = 1; f < frameCount - 1; f++) {
    let sum = 0;
    let count = 0;
    for (let j = f - half; j <= f + half; j++) {
      if (j < 0 || j >= frameCount) continue;
      sum += odf[j];
      count++;
    }
    const localMean = count > 0 ? sum / count : 0;
    const threshold = localMean * (1 + sensitivity) + 0.02;

    const isPeak = odf[f] > odf[f - 1] && odf[f] >= odf[f + 1];
    if (isPeak && odf[f] >= threshold && f - lastFrame >= gapFrames) {
      const timeMs = (f * hop) / sr * 1000;
      onsets.push(Math.round(timeMs));
      lastFrame = f;
    }
  }
  return onsets;
}

function toMono(buffer: AudioLike): Float32Array {
  const ch = buffer.numberOfChannels;
  const left = buffer.getChannelData(0);
  if (ch <= 1) return left;
  const out = new Float32Array(left.length);
  const right = buffer.getChannelData(1);
  for (let i = 0; i < left.length; i++) out[i] = (left[i] + right[i]) * 0.5;
  return out;
}
