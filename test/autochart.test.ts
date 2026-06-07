import { describe, it, expect } from "vitest";
import { generateChart, type DifficultyLevel } from "../src/generate/autochart.ts";
import { isHold, type TimingPoint } from "../src/types.ts";

function red(bpm = 120): TimingPoint[] {
  return [{ time: 0, uninherited: true, bpm, sv: 1, meter: 4, volume: 100, sampleSet: 0, sampleIndex: 0, effects: 0 }];
}

/** Onsets on every 1/8 note (250ms at 120 BPM) across `seconds`. */
function eighths(seconds: number): number[] {
  const out: number[] = [];
  for (let t = 0; t < seconds * 1000; t += 250) out.push(t);
  return out;
}

const tp = red();
const onsets = eighths(20);

function gen(level: DifficultyLevel, extra = {}) {
  return generateChart(onsets, tp, { keyCount: 4, level, seed: 42, ...extra });
}

describe("generateChart", () => {
  it("returns nothing for no onsets", () => {
    expect(generateChart([], tp, { keyCount: 4, level: "hard" })).toEqual([]);
  });

  it("produces notes for a normal song", () => {
    expect(gen("hard").length).toBeGreaterThan(20);
  });

  it("keeps every note within the column range", () => {
    for (const lvl of ["easy", "normal", "hard", "insane", "expert"] as DifficultyLevel[]) {
      for (const o of generateChart(onsets, tp, { keyCount: 7, level: lvl, seed: 7 })) {
        expect(o.column).toBeGreaterThanOrEqual(0);
        expect(o.column).toBeLessThan(7);
      }
    }
  });

  it("returns objects sorted by time", () => {
    const notes = gen("insane");
    for (let i = 1; i < notes.length; i++) {
      expect(notes[i].time).toBeGreaterThanOrEqual(notes[i - 1].time);
    }
  });

  it("scales density with difficulty (expert denser than easy)", () => {
    expect(gen("expert").length).toBeGreaterThan(gen("easy").length);
  });

  it("density multiplier increases note count", () => {
    const sparse = gen("hard", { density: 0.6 }).length;
    const dense = gen("hard", { density: 1.4 }).length;
    expect(dense).toBeGreaterThanOrEqual(sparse);
  });

  it("is deterministic for a given seed", () => {
    const a = gen("hard");
    const b = gen("hard");
    expect(a).toEqual(b);
  });

  it("never stacks two notes in the same column at the same time", () => {
    for (const lvl of ["hard", "insane", "expert"] as DifficultyLevel[]) {
      const notes = generateChart(onsets, tp, { keyCount: 4, level: lvl, seed: 3 });
      const seen = new Set<string>();
      for (const o of notes) {
        const key = `${o.time}:${o.column}`;
        expect(seen.has(key)).toBe(false);
        seen.add(key);
      }
    }
  });

  it("produces no holds when long notes are disabled", () => {
    const notes = gen("normal", { longNotes: false });
    expect(notes.some(isHold)).toBe(false);
  });

  it("respects 1K (single column, no chords)", () => {
    const notes = generateChart(onsets, tp, { keyCount: 1, level: "expert", seed: 1 });
    expect(notes.every((o) => o.column === 0)).toBe(true);
    // No two notes at the same time (no chords possible in 1K).
    const times = notes.map((o) => o.time);
    expect(new Set(times).size).toBe(times.length);
  });
});
