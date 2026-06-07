import { describe, it, expect } from "vitest";
import { detectOnsets, type AudioLike } from "../src/audio/onsets.ts";

/** Build a mono AudioLike with short bursts ("hits") at the given times (sec). */
function withImpulses(sr: number, durationSec: number, hitsSec: number[]): AudioLike {
  const length = Math.floor(sr * durationSec);
  const data = new Float32Array(length);
  const burst = Math.floor(sr * 0.02); // 20 ms transient
  for (const t of hitsSec) {
    const start = Math.floor(t * sr);
    for (let i = 0; i < burst && start + i < length; i++) {
      // Decaying noisy burst.
      data[start + i] = (Math.random() * 2 - 1) * (1 - i / burst);
    }
  }
  return {
    sampleRate: sr,
    length,
    numberOfChannels: 1,
    getChannelData: () => data,
  };
}

describe("detectOnsets", () => {
  it("returns nothing for silence", () => {
    const sr = 8000;
    const silent: AudioLike = {
      sampleRate: sr,
      length: sr * 2,
      numberOfChannels: 1,
      getChannelData: () => new Float32Array(sr * 2),
    };
    expect(detectOnsets(silent)).toEqual([]);
  });

  it("finds onsets near evenly spaced hits", () => {
    const sr = 8000;
    // Start after a little lead-in silence (as real tracks do); a transient at
    // sample 0 has no preceding frame to measure a rise against.
    const hits = [0.25, 0.75, 1.25, 1.75];
    const buf = withImpulses(sr, 2.2, hits);
    const onsets = detectOnsets(buf);

    // Should find roughly one onset per hit (allow a little slop).
    expect(onsets.length).toBeGreaterThanOrEqual(hits.length);
    expect(onsets.length).toBeLessThanOrEqual(hits.length + 2);

    // Each hit should have a detected onset within ~30 ms.
    for (const t of hits) {
      const targetMs = t * 1000;
      const near = onsets.some((o) => Math.abs(o - targetMs) <= 30);
      expect(near, `expected an onset near ${targetMs}ms in ${onsets}`).toBe(true);
    }
  });

  it("returns sorted, non-duplicate times", () => {
    const buf = withImpulses(8000, 3, [0.2, 0.7, 1.1, 1.9, 2.4]);
    const onsets = detectOnsets(buf);
    for (let i = 1; i < onsets.length; i++) {
      expect(onsets[i]).toBeGreaterThan(onsets[i - 1]);
    }
  });

  it("respects a larger minimum gap", () => {
    // Two hits 60 ms apart should collapse to one with a 100 ms min gap.
    const buf = withImpulses(8000, 1, [0.3, 0.36]);
    const onsets = detectOnsets(buf, { minGapMs: 100 });
    const near = onsets.filter((o) => o >= 280 && o <= 400);
    expect(near.length).toBe(1);
  });
});
