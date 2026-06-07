import { describe, it, expect } from "vitest";
import { encodeWav } from "../src/audio/wav.ts";
import { shiftBeatmap } from "../src/osu/shift.ts";
import { createEmptyBeatmap, type Beatmap } from "../src/types.ts";
import type { AudioLike } from "../src/audio/onsets.ts";

function buf(sr: number, seconds: number, channels = 2): AudioLike {
  const length = sr * seconds;
  const data = channels === 2
    ? [new Float32Array(length).fill(0.5), new Float32Array(length).fill(-0.5)]
    : [new Float32Array(length).fill(0.5)];
  return { sampleRate: sr, length, numberOfChannels: channels, getChannelData: (c) => data[c] };
}

function readStr(u8: Uint8Array, off: number, len: number): string {
  return String.fromCharCode(...u8.slice(off, off + len));
}
function readU32(u8: Uint8Array, off: number): number {
  return new DataView(u8.buffer).getUint32(off, true);
}

describe("encodeWav", () => {
  it("writes a valid RIFF/WAVE header with correct format fields", () => {
    const sr = 8000;
    const wav = encodeWav(buf(sr, 1, 2), 0, 1);
    expect(readStr(wav, 0, 4)).toBe("RIFF");
    expect(readStr(wav, 8, 4)).toBe("WAVE");
    expect(readStr(wav, 36, 4)).toBe("data");
    const view = new DataView(wav.buffer);
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(2); // channels
    expect(view.getUint32(24, true)).toBe(sr); // sample rate
    expect(view.getUint16(34, true)).toBe(16); // bits
  });

  it("encodes only the requested time window", () => {
    const sr = 8000;
    // Trim [0.25s, 0.75s) of a 1s stereo clip -> 0.5s * 8000 * 2ch * 2bytes.
    const wav = encodeWav(buf(sr, 1, 2), 0.25, 0.75);
    const frames = 0.5 * sr;
    const dataSize = frames * 2 * 2;
    expect(readU32(wav, 40)).toBe(dataSize);
    expect(wav.length).toBe(44 + dataSize);
  });

  it("clamps the window to the buffer length", () => {
    const sr = 8000;
    const wav = encodeWav(buf(sr, 1, 1), 0.5, 5); // endSec beyond the clip
    const frames = 0.5 * sr;
    expect(wav.length).toBe(44 + frames * 1 * 2);
  });
});

function mapWith(times: { time: number; endTime?: number }[]): Beatmap {
  const b = createEmptyBeatmap(4);
  b.general.previewTime = 5000;
  b.timingPoints.push({ time: 1000, uninherited: true, bpm: 120, sv: 1, meter: 4, volume: 100, sampleSet: 0, sampleIndex: 0, effects: 0 });
  for (const t of times) b.hitObjects.push({ column: 0, time: t.time, endTime: t.endTime, hitSound: 0 });
  return b;
}

describe("shiftBeatmap", () => {
  it("shifts notes, timing and preview earlier and drops pre-zero objects", () => {
    const m = mapWith([{ time: 500 }, { time: 2000 }, { time: 4000 }]);
    const s = shiftBeatmap(m, -1500);
    // 500 -> -1000 (dropped); 2000 -> 500; 4000 -> 2500.
    expect(s.hitObjects.map((o) => o.time)).toEqual([500, 2500]);
    expect(s.timingPoints[0].time).toBe(0); // 1000 - 1500 clamped to 0
    expect(s.general.previewTime).toBe(3500); // 5000 - 1500
  });

  it("clamps a hold that straddles zero", () => {
    const m = mapWith([{ time: 500, endTime: 3000 }]);
    const s = shiftBeatmap(m, -1500);
    // head 500-> -1000 clamped to 0; tail 3000 -> 1500.
    expect(s.hitObjects).toHaveLength(1);
    expect(s.hitObjects[0].time).toBe(0);
    expect(s.hitObjects[0].endTime).toBe(1500);
  });

  it("does not mutate the original", () => {
    const m = mapWith([{ time: 2000 }]);
    shiftBeatmap(m, -1000);
    expect(m.hitObjects[0].time).toBe(2000);
  });
});
