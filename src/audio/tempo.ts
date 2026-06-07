/**
 * Automatic tempo (BPM) and offset detection from a decoded AudioBuffer.
 *
 * Approach (a pragmatic, well-known one):
 *  1. Re-render the audio through a low band (high-pass + low-pass) so the
 *     kick/bass beat dominates, at a reduced sample rate for speed.
 *  2. Pick rhythmic peaks with a descending amplitude threshold.
 *  3. Histogram the inter-peak intervals into BPM candidates, folding each into
 *     a musical range, and take the most common one.
 *  4. Estimate the offset (first beat) from the earliest strong peak, wrapped to
 *     the detected beat period.
 *
 * This is a heuristic — it gets most 4/4 electronic/pop tracks right and gives
 * a solid starting point the user can nudge. It is intentionally dependency-free.
 */
export interface TempoResult {
  bpm: number;
  /** Estimated time (ms) of the first beat. */
  offsetMs: number;
  /** Rough 0–1 confidence from how dominant the winning candidate was. */
  confidence: number;
}

const TARGET_RATE = 11025; // downsample target for speed
const MIN_BPM = 90;
const MAX_BPM = 180;

export async function detectTempo(buffer: AudioBuffer): Promise<TempoResult> {
  const filtered = await renderLowBand(buffer);
  const sr = filtered.sampleRate;
  const data = filtered.getChannelData(0);

  const peaks = findPeaks(data, sr);
  if (peaks.length < 4) {
    return { bpm: 120, offsetMs: 0, confidence: 0 };
  }

  const { bpm, confidence } = histogramTempo(peaks, sr);
  const offsetMs = estimateOffset(peaks, sr, bpm);
  return { bpm, offsetMs, confidence };
}

/** Render through a band-pass-ish chain at a reduced sample rate. */
async function renderLowBand(buffer: AudioBuffer): Promise<AudioBuffer> {
  const length = Math.max(1, Math.ceil(buffer.duration * TARGET_RATE));
  const Offline =
    (window as any).OfflineAudioContext || (window as any).webkitOfflineAudioContext;
  if (!Offline) {
    // No offline context: fall back to the raw buffer's first channel.
    return buffer;
  }
  const ctx: OfflineAudioContext = new Offline(1, length, TARGET_RATE);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  const lp = ctx.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = 150;
  const hp = ctx.createBiquadFilter();
  hp.type = "highpass";
  hp.frequency.value = 90;
  src.connect(hp);
  hp.connect(lp);
  lp.connect(ctx.destination);
  src.start(0);
  return ctx.startRendering();
}

/**
 * Find rhythmic peaks. Starts with a high amplitude threshold and lowers it
 * until enough peaks are found, enforcing a refractory gap so a single kick
 * isn't counted many times.
 */
function findPeaks(data: Float32Array, sr: number): number[] {
  let max = 0;
  for (let i = 0; i < data.length; i++) {
    const a = Math.abs(data[i]);
    if (a > max) max = a;
  }
  if (max === 0) return [];

  const gap = Math.floor(sr * 0.18); // ~333 BPM ceiling between distinct kicks
  for (let thr = 0.9; thr >= 0.2; thr -= 0.05) {
    const threshold = max * thr;
    const peaks: number[] = [];
    let i = 0;
    while (i < data.length) {
      if (Math.abs(data[i]) >= threshold) {
        peaks.push(i);
        i += gap;
      } else {
        i++;
      }
    }
    if (peaks.length >= 12) return peaks;
  }
  return [];
}

/** Fold a BPM into the musical [MIN_BPM, MAX_BPM] range. */
function foldBpm(bpm: number): number {
  while (bpm < MIN_BPM) bpm *= 2;
  while (bpm > MAX_BPM) bpm /= 2;
  return bpm;
}

/** Histogram inter-peak intervals into BPM buckets and pick the strongest. */
function histogramTempo(
  peaks: number[],
  sr: number,
): { bpm: number; confidence: number } {
  const counts = new Map<number, number>();
  for (let i = 0; i < peaks.length; i++) {
    for (let j = i + 1; j < Math.min(peaks.length, i + 10); j++) {
      const intervalSec = (peaks[j] - peaks[i]) / sr;
      if (intervalSec <= 0) continue;
      const bpm = foldBpm(60 / intervalSec);
      const bucket = Math.round(bpm);
      counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
    }
  }
  if (counts.size === 0) return { bpm: 120, confidence: 0 };

  // Smooth by accumulating neighbouring buckets (±1 BPM), then take the max.
  let best = 120;
  let bestScore = 0;
  let total = 0;
  for (const v of counts.values()) total += v;
  for (const [bucket] of counts) {
    const score =
      (counts.get(bucket - 1) ?? 0) +
      (counts.get(bucket) ?? 0) +
      (counts.get(bucket + 1) ?? 0);
    if (score > bestScore) {
      bestScore = score;
      best = bucket;
    }
  }
  return { bpm: best, confidence: total > 0 ? bestScore / total : 0 };
}

/** Estimate the first-beat offset by phase-aligning peaks to the beat period. */
function estimateOffset(peaks: number[], sr: number, bpm: number): number {
  const periodSec = 60 / bpm;
  // Use the earliest reasonably strong peak and wrap it into one period.
  const firstSec = peaks[0] / sr;
  const wrapped = firstSec % periodSec;
  return Math.round(wrapped * 1000);
}
