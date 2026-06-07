import { describe, it, expect } from "vitest";
import {
  generateChart,
  recommendedOD,
  type DifficultyLevel,
} from "../src/generate/autochart.ts";
import { arrowAngle } from "../src/render/shapes.ts";
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

  it("hold-note amount increases the number of holds", () => {
    const few = gen("hard", { lnAmount: 0 }).filter(isHold).length;
    const many = gen("hard", { lnAmount: 2 }).filter(isHold).length;
    expect(few).toBe(0);
    expect(many).toBeGreaterThan(0);
  });

  it("chord amount of 0 yields no simultaneous notes", () => {
    const notes = gen("insane", { chordAmount: 0 });
    const counts = new Map<number, number>();
    for (const o of notes) counts.set(o.time, (counts.get(o.time) ?? 0) + 1);
    expect([...counts.values()].every((c) => c === 1)).toBe(true);
  });

  it("works for every key count 1–10 with in-range columns", () => {
    for (let k = 1; k <= 10; k++) {
      const notes = generateChart(onsets, tp, { keyCount: k, level: "insane", seed: k });
      expect(notes.length).toBeGreaterThan(0);
      expect(notes.every((o) => o.column >= 0 && o.column < k)).toBe(true);
    }
  });
});

describe("recommendedOD", () => {
  it("returns a sane default for tiny charts", () => {
    expect(recommendedOD([])).toBe(7);
  });

  it("rises with note density and stays in range", () => {
    const sparse = [0, 1000, 2000, 3000].map((t) => ({ time: t }));
    const dense = Array.from({ length: 200 }, (_, i) => ({ time: i * 100 }));
    const odSparse = recommendedOD(sparse);
    const odDense = recommendedOD(dense);
    expect(odDense).toBeGreaterThan(odSparse);
    for (const od of [odSparse, odDense]) {
      expect(od).toBeGreaterThanOrEqual(1);
      expect(od).toBeLessThanOrEqual(10);
      expect(od * 2).toBe(Math.round(od * 2)); // half-step rounded
    }
  });
});

describe("arrowAngle", () => {
  it("maps 4K to left, down, up, right", () => {
    expect([0, 1, 2, 3].map(arrowAngle)).toEqual([
      -Math.PI / 2, Math.PI, 0, Math.PI / 2,
    ]);
  });
  it("cycles every 4 columns", () => {
    expect(arrowAngle(4)).toBe(arrowAngle(0));
    expect(arrowAngle(7)).toBe(arrowAngle(3));
  });
});
