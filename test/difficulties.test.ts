import { describe, it, expect } from "vitest";
import {
  syncSharedMetadata,
  nextVersionName,
  blankDifficultyFrom,
  duplicateDifficulty,
} from "../src/state/difficulties.ts";
import { buildOsz, readOsz } from "../src/osu/osz.ts";
import { createEmptyBeatmap, type Beatmap } from "../src/types.ts";

function diff(version: string, keys: number, notes: number): Beatmap {
  const b = createEmptyBeatmap(keys);
  b.metadata.title = "Song";
  b.metadata.artist = "Artist";
  b.metadata.creator = "mosu";
  b.metadata.version = version;
  for (let i = 0; i < notes; i++) {
    b.hitObjects.push({ column: i % keys, time: i * 250, hitSound: 0 });
  }
  return b;
}

describe("nextVersionName", () => {
  it("returns the base when free", () => {
    expect(nextVersionName(["Hard"], "Normal")).toBe("Normal");
  });
  it("appends a counter when taken", () => {
    expect(nextVersionName(["Normal"], "Normal")).toBe("Normal 2");
    expect(nextVersionName(["Normal", "Normal 2"], "Normal")).toBe("Normal 3");
  });
});

describe("syncSharedMetadata", () => {
  it("copies shared song metadata but never the Version", () => {
    const a = diff("Easy", 4, 0);
    const b = diff("Hard", 7, 0);
    a.metadata.artist = "New Artist";
    a.metadata.tags = "x y z";
    a.general.previewTime = 12345;
    syncSharedMetadata(a, [a, b]);
    expect(b.metadata.artist).toBe("New Artist");
    expect(b.metadata.tags).toBe("x y z");
    expect(b.general.previewTime).toBe(12345);
    expect(b.metadata.version).toBe("Hard"); // unchanged
    expect(b.difficulty.keyCount).toBe(7); // not shared
  });
});

describe("blank / duplicate difficulty", () => {
  it("blank keeps song + timing but clears notes and renames", () => {
    const a = diff("Insane", 4, 8);
    a.timingPoints.push({ time: 0, uninherited: true, bpm: 180, sv: 1, meter: 4, volume: 100, sampleSet: 0, sampleIndex: 0, effects: 0 });
    const b = blankDifficultyFrom(a, [a.metadata.version]);
    expect(b.hitObjects).toHaveLength(0);
    expect(b.timingPoints).toHaveLength(1);
    expect(b.metadata.artist).toBe("Artist");
    expect(b.metadata.version).not.toBe("Insane");
  });

  it("duplicate keeps the notes and mints a new version", () => {
    const a = diff("Hard", 4, 8);
    const b = duplicateDifficulty(a, [a.metadata.version]);
    expect(b.hitObjects).toHaveLength(8);
    expect(b.metadata.version).toBe("Hard 2");
  });
});

describe("osz multi-difficulty round-trip", () => {
  it("packs and reads back every difficulty plus shared audio", async () => {
    const set = [diff("Easy", 4, 4), diff("Hard", 7, 12)];
    const audio = new Uint8Array([1, 2, 3, 4, 5]); // stand-in audio bytes
    const blob = buildOsz(set, audio);
    const bytes = new Uint8Array(await blob.arrayBuffer());

    const read = readOsz(bytes);
    expect(read.beatmaps).toHaveLength(2);
    const versions = read.beatmaps.map((b) => b.metadata.version).sort();
    expect(versions).toEqual(["Easy", "Hard"]);
    const byVer = Object.fromEntries(read.beatmaps.map((b) => [b.metadata.version, b]));
    expect(byVer["Easy"].difficulty.keyCount).toBe(4);
    expect(byVer["Hard"].difficulty.keyCount).toBe(7);
    expect(byVer["Hard"].hitObjects).toHaveLength(12);
    expect(read.audioBytes).not.toBeNull();
    expect(Array.from(read.audioBytes!)).toEqual([1, 2, 3, 4, 5]);
  });

  it("de-duplicates filenames when two difficulties share a Version name", async () => {
    const set = [diff("Normal", 4, 2), diff("Normal", 4, 3)];
    const blob = buildOsz(set, null);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const read = readOsz(bytes);
    expect(read.beatmaps).toHaveLength(2); // neither dropped
  });
});
