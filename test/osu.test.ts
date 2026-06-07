import { describe, it, expect } from "vitest";
import {
  serializeBeatmap,
  serializeHitObject,
  serializeTimingPoint,
  columnToX,
  xToColumn,
} from "../src/osu/serializer.ts";
import { parseBeatmap, parseHitObject } from "../src/osu/parser.ts";
import { createEmptyBeatmap, type HitObject } from "../src/types.ts";

describe("column <-> x mapping", () => {
  it("matches osu!'s 4K canonical x coordinates", () => {
    expect([0, 1, 2, 3].map((c) => columnToX(c, 4))).toEqual([64, 192, 320, 448]);
  });

  it("decodes x back to the right column", () => {
    for (const keys of [4, 5, 7, 10]) {
      for (let c = 0; c < keys; c++) {
        expect(xToColumn(columnToX(c, keys), keys)).toBe(c);
      }
    }
  });
});

describe("serializeHitObject", () => {
  it("encodes a tap note as type 1", () => {
    const note: HitObject = { column: 0, time: 1000, hitSound: 0 };
    expect(serializeHitObject(note, 4)).toBe("64,192,1000,1,0,0:0:0:0:");
  });

  it("encodes a hold note as type 128 with endTime before the hitSample", () => {
    const hold: HitObject = { column: 3, time: 1000, endTime: 2000, hitSound: 0 };
    expect(serializeHitObject(hold, 4)).toBe("448,192,1000,128,0,2000:0:0:0:0:");
  });

  it("carries the hitsound bitfield", () => {
    const note: HitObject = { column: 1, time: 500, hitSound: 8 };
    expect(serializeHitObject(note, 4)).toBe("192,192,500,1,8,0:0:0:0:");
  });
});

describe("serializeTimingPoint", () => {
  it("writes a red (uninherited) line with beatLength = 60000/bpm", () => {
    const tp = { time: 0, uninherited: true, bpm: 120, sv: 1, meter: 4, volume: 100, sampleSet: 0, sampleIndex: 0, effects: 0 };
    expect(serializeTimingPoint(tp)).toBe("0,500,4,0,0,100,1,0");
  });

  it("writes a green (inherited) line with beatLength = -100/sv", () => {
    const tp = { time: 1000, uninherited: false, bpm: 120, sv: 1.5, meter: 4, volume: 80, sampleSet: 0, sampleIndex: 0, effects: 0 };
    // -100 / 1.5 = -66.6667
    expect(serializeTimingPoint(tp)).toBe("1000,-66.666667,4,0,0,80,0,0");
  });
});

describe("parseHitObject", () => {
  it("parses a tap", () => {
    const o = parseHitObject("64,192,1000,1,0,0:0:0:0:", 4)!;
    expect(o.column).toBe(0);
    expect(o.time).toBe(1000);
    expect(o.endTime).toBeUndefined();
  });

  it("parses a hold and recovers endTime", () => {
    const o = parseHitObject("448,192,1000,128,0,2000:0:0:0:0:", 4)!;
    expect(o.column).toBe(3);
    expect(o.time).toBe(1000);
    expect(o.endTime).toBe(2000);
  });
});

describe("round-trip", () => {
  it("serializes then parses back to an equivalent beatmap", () => {
    const map = createEmptyBeatmap(7);
    map.metadata.title = "Test Song";
    map.metadata.artist = "Tester";
    map.metadata.creator = "mosu";
    map.metadata.version = "Insane";
    map.difficulty.od = 8.5;
    map.timingPoints.push(
      { time: 0, uninherited: true, bpm: 175, sv: 1, meter: 4, volume: 100, sampleSet: 0, sampleIndex: 0, effects: 0 },
      { time: 4000, uninherited: false, bpm: 175, sv: 1.4, meter: 4, volume: 90, sampleSet: 0, sampleIndex: 0, effects: 0 },
    );
    map.hitObjects.push(
      { column: 0, time: 500, hitSound: 0 },
      { column: 6, time: 1000, endTime: 1500, hitSound: 0 },
      { column: 3, time: 2000, hitSound: 4 },
    );

    const text = serializeBeatmap(map);
    const back = parseBeatmap(text);

    expect(back.metadata.title).toBe("Test Song");
    expect(back.metadata.version).toBe("Insane");
    expect(back.difficulty.keyCount).toBe(7);
    expect(back.difficulty.od).toBe(8.5);
    expect(back.timingPoints).toHaveLength(2);
    expect(back.timingPoints[0].bpm).toBeCloseTo(175, 4);
    expect(back.timingPoints[1].uninherited).toBe(false);
    expect(back.timingPoints[1].sv).toBeCloseTo(1.4, 4);
    expect(back.hitObjects).toHaveLength(3);

    const hold = back.hitObjects.find((o) => o.endTime !== undefined)!;
    expect(hold.column).toBe(6);
    expect(hold.endTime).toBe(1500);
    expect(back.hitObjects.find((o) => o.time === 2000)!.hitSound).toBe(4);
  });

  it("produces a valid format header and mania mode", () => {
    const text = serializeBeatmap(createEmptyBeatmap(4));
    expect(text.startsWith("osu file format v14")).toBe(true);
    expect(text).toContain("Mode: 3");
    expect(text).toContain("CircleSize:4");
  });

  it("round-trips a background image event", () => {
    const map = createEmptyBeatmap(4);
    map.general.backgroundFilename = "bg.jpg";
    const text = serializeBeatmap(map);
    expect(text).toContain('0,0,"bg.jpg",0,0');
    const back = parseBeatmap(text);
    expect(back.general.backgroundFilename).toBe("bg.jpg");
  });
});
