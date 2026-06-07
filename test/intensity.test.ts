import { describe, it, expect } from "vitest";
import { computeIntensity, intensityAt, findDrops } from "../src/audio/intensity.ts";
import { generateChart } from "../src/generate/autochart.ts";
import type { AudioLike } from "../src/audio/onsets.ts";
import type { TimingPoint } from "../src/types.ts";

/** Mono buffer: `seconds` long, amplitude given by amp(timeSec). */
function shaped(sr: number, seconds: number, amp: (tSec: number) => number): AudioLike {
  const length = sr * seconds;
  const data = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const t = i / sr;
    // alternating sign so RMS reflects amplitude
    data[i] = amp(t) * (i % 2 ? 1 : -1);
  }
  return { sampleRate: sr, length, numberOfChannels: 1, getChannelData: () => data };
}

describe("computeIntensity", () => {
  it("is low in quiet sections and high in loud ones", () => {
    const sr = 8000;
    const buf = shaped(sr, 4, (t) => (t < 2 ? 0.05 : 0.8)); // quiet then loud
    const env = computeIntensity(buf, 250);
    expect(intensityAt(env, 500)).toBeLessThan(0.3);
    expect(intensityAt(env, 3500)).toBeGreaterThan(0.7);
  });

  it("returns neutral 0.5 for an empty envelope", () => {
    const env = { frameMs: 250, values: new Float32Array(0) };
    expect(intensityAt(env, 1000)).toBe(0.5);
  });

  it("detects a drop where energy jumps up", () => {
    const sr = 8000;
    const buf = shaped(sr, 8, (t) => (t < 4 ? 0.05 : 0.85));
    const drops = findDrops(computeIntensity(buf, 250));
    expect(drops.length).toBeGreaterThanOrEqual(1);
    // The jump is around 4000 ms.
    expect(drops.some((d) => Math.abs(d - 4000) < 800)).toBe(true);
  });
});

describe("intensity-aware generation", () => {
  const tp: TimingPoint[] = [{ time: 0, uninherited: true, bpm: 120, sv: 1, meter: 4, volume: 100, sampleSet: 0, sampleIndex: 0, effects: 0 }];

  it("places more notes in loud sections than quiet ones", () => {
    // Onsets across 16s of 1/4 notes (125ms apart at 120 BPM).
    const onsets: number[] = [];
    for (let t = 0; t < 16000; t += 125) onsets.push(t);
    const half = 8000;
    const intensityFn = (ms: number) => (ms < half ? 0.1 : 0.9);

    const notes = generateChart(onsets, tp, {
      keyCount: 4, level: "hard", seed: 1,
      intensityAt: intensityFn, intensityStrength: 1, longNotes: false,
    });
    const quiet = notes.filter((o) => o.time < half).length;
    const loud = notes.filter((o) => o.time >= half).length;
    expect(loud).toBeGreaterThan(quiet);
  });
});
