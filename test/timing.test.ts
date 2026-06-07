import { describe, it, expect } from "vitest";
import {
  beatLengthFromBpm,
  bpmFromBeatLength,
  snapTime,
  stepTime,
  bpmFromTaps,
  activeBpmPoint,
  gridLines,
  alignOffsetToOnsets,
} from "../src/timing/timing.ts";
import type { TimingPoint } from "../src/types.ts";

function red(time: number, bpm: number, meter = 4): TimingPoint {
  return { time, uninherited: true, bpm, sv: 1, meter, volume: 100, sampleSet: 0, sampleIndex: 0, effects: 0 };
}

describe("bpm <-> beat length", () => {
  it("converts 120 BPM to 500 ms/beat", () => {
    expect(beatLengthFromBpm(120)).toBe(500);
    expect(bpmFromBeatLength(500)).toBe(120);
  });

  it("round-trips", () => {
    for (const bpm of [60, 174, 200, 333.33]) {
      expect(bpmFromBeatLength(beatLengthFromBpm(bpm))).toBeCloseTo(bpm, 6);
    }
  });
});

describe("snapTime", () => {
  const points = [red(0, 120)]; // 500 ms/beat

  it("snaps to nearest 1/4 (125 ms)", () => {
    expect(snapTime(points, 130, 4)).toBe(125);
    expect(snapTime(points, 60, 4)).toBe(0);
    expect(snapTime(points, 200, 4)).toBe(250);
  });

  it("snaps relative to the timing point offset", () => {
    const offset = [red(80, 120)];
    // beats land at 80, 580, 1080...; 1/2 steps at 80, 330, 580...
    expect(snapTime(offset, 100, 2)).toBe(80);
    expect(snapTime(offset, 350, 2)).toBe(330);
  });

  it("uses the active BPM point for the given time", () => {
    const multi = [red(0, 120), red(1000, 240)]; // 250 ms/beat after 1000
    expect(snapTime(multi, 1130, 4)).toBe(1125); // step 62.5 -> 1062.5,1125...
  });
});

describe("stepTime", () => {
  const points = [red(0, 120)];

  it("moves one snap unit forward and backward", () => {
    expect(stepTime(points, 0, 4, 1)).toBe(125);
    expect(stepTime(points, 125, 4, -1)).toBe(0);
  });

  it("snaps onto the grid when between boundaries", () => {
    expect(stepTime(points, 130, 4, 1)).toBe(250);
    expect(stepTime(points, 130, 4, -1)).toBe(125);
  });
});

describe("activeBpmPoint", () => {
  it("falls back to 120 BPM with no points", () => {
    expect(activeBpmPoint([], 0).bpm).toBe(120);
  });

  it("picks the latest point at or before the time", () => {
    const multi = [red(0, 120), red(1000, 200)];
    expect(activeBpmPoint(multi, 500).bpm).toBe(120);
    expect(activeBpmPoint(multi, 1000).bpm).toBe(200);
    expect(activeBpmPoint(multi, 5000).bpm).toBe(200);
  });
});

describe("bpmFromTaps", () => {
  it("returns null with fewer than two taps", () => {
    expect(bpmFromTaps([])).toBeNull();
    expect(bpmFromTaps([100])).toBeNull();
  });

  it("estimates BPM from even taps", () => {
    // 500 ms apart -> 120 BPM
    expect(bpmFromTaps([0, 500, 1000, 1500])).toBeCloseTo(120, 6);
  });
});

describe("alignOffsetToOnsets", () => {
  it("recovers the phase of beats at a known offset", () => {
    const bpm = 120; // period 500ms
    const phase = 137;
    const onsets: number[] = [];
    for (let k = 0; k < 20; k++) onsets.push(phase + k * 500);
    expect(alignOffsetToOnsets(onsets, bpm)).toBeCloseTo(137, 0);
  });

  it("is robust to a little timing jitter and stray onsets", () => {
    const bpm = 150; // period 400ms
    const phase = 80;
    const onsets: number[] = [];
    for (let k = 0; k < 24; k++) onsets.push(phase + k * 400 + (k % 2 ? 4 : -3));
    onsets.push(1234, 222, 999); // noise
    const got = alignOffsetToOnsets(onsets, bpm);
    expect(Math.abs(got - phase)).toBeLessThanOrEqual(8);
  });

  it("returns an offset within one beat period", () => {
    const got = alignOffsetToOnsets([5000, 5500, 6000], 120);
    expect(got).toBeGreaterThanOrEqual(0);
    expect(got).toBeLessThan(500);
  });

  it("returns 0 for no onsets", () => {
    expect(alignOffsetToOnsets([], 120)).toBe(0);
  });
});

describe("gridLines", () => {
  it("places whole-beat lines at divisor 1", () => {
    const lines = gridLines([red(0, 120)], 0, 2000, 1);
    expect(lines.map((l) => l.time)).toEqual([0, 500, 1000, 1500, 2000]);
    expect(lines.every((l) => l.divisor === 1)).toBe(true);
  });

  it("tags finer subdivisions with their divisor", () => {
    const lines = gridLines([red(0, 120)], 0, 500, 4);
    // 0(1), 125(4), 250(2), 375(4), 500(1)
    const byTime = Object.fromEntries(lines.map((l) => [l.time, l.divisor]));
    expect(byTime[0]).toBe(1);
    expect(byTime[125]).toBe(4);
    expect(byTime[250]).toBe(2);
    expect(byTime[500]).toBe(1);
  });
});
