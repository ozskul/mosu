import { describe, it, expect } from "vitest";
import { collectExportIssues } from "../src/osu/validate.ts";
import { createEmptyBeatmap, type Beatmap } from "../src/types.ts";

function playable(): Beatmap {
  const b = createEmptyBeatmap(4);
  b.metadata.title = "Song";
  b.metadata.artist = "Artist";
  b.timingPoints.push({ time: 0, uninherited: true, bpm: 150, sv: 1, meter: 4, volume: 100, sampleSet: 0, sampleIndex: 0, effects: 0 });
  b.hitObjects.push({ column: 0, time: 100, hitSound: 0 });
  return b;
}

describe("collectExportIssues", () => {
  it("passes a complete, timed, audio-backed map", () => {
    expect(collectExportIssues([playable()], true)).toEqual([]);
  });

  it("flags a missing BPM timing point as blocking (the common unplayable case)", () => {
    const b = playable();
    b.timingPoints = [];
    const issues = collectExportIssues([b], true);
    expect(issues.some((i) => i.blocking && /timing point/i.test(i.message))).toBe(true);
  });

  it("flags no notes and no audio as blocking", () => {
    const b = playable();
    b.hitObjects = [];
    const issues = collectExportIssues([b], false);
    expect(issues.some((i) => i.blocking && /no notes/i.test(i.message))).toBe(true);
    expect(issues.some((i) => i.blocking && /audio/i.test(i.message))).toBe(true);
  });

  it("treats missing title/artist as non-blocking warnings", () => {
    const b = playable();
    b.metadata.title = "";
    b.metadata.artist = "";
    const issues = collectExportIssues([b], true);
    expect(issues.length).toBe(2);
    expect(issues.every((i) => !i.blocking)).toBe(true);
  });

  it("reports the difficulty by name", () => {
    const b = playable();
    b.metadata.version = "Insane";
    b.timingPoints = [];
    const issues = collectExportIssues([b], true);
    expect(issues[0].message).toContain("Insane");
  });
});
