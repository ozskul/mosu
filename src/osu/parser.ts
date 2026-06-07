/**
 * Parse the osu! `.osu` text format into our Beatmap model.
 *
 * This is the inverse of serializer.ts and is designed to round-trip maps the
 * editor produces, while also tolerating real-world maps (extra sections,
 * unknown keys, storyboard events, etc.). Only osu!mania (Mode: 3) is fully
 * supported; other modes are parsed best-effort but will not load meaningfully.
 */
import {
  createEmptyBeatmap,
  type Beatmap,
  type HitObject,
  type TimingPoint,
} from "../types.ts";
import { xToColumn } from "./serializer.ts";

export class OsuParseError extends Error {}

export function parseBeatmap(text: string): Beatmap {
  const map = createEmptyBeatmap(4);
  const lines = text.split(/\r?\n/);

  const header = lines.find((l) => l.trim().length > 0) ?? "";
  const vMatch = header.match(/osu file format v(\d+)/i);
  if (!vMatch) {
    throw new OsuParseError("Not a valid .osu file (missing format header).");
  }
  map.formatVersion = parseInt(vMatch[1], 10);

  let section = "";
  // Defer hit-object parsing until we know the key count.
  const rawHitObjects: string[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("//")) continue;

    const sec = line.match(/^\[(.+)\]$/);
    if (sec) {
      section = sec[1];
      continue;
    }

    switch (section) {
      case "General":
        applyKeyValue(line, (k, v) => {
          if (k === "AudioFilename") map.general.audioFilename = v;
          else if (k === "AudioLeadIn") map.general.audioLeadIn = num(v);
          else if (k === "PreviewTime") map.general.previewTime = num(v);
        });
        break;
      case "Metadata":
        applyKeyValue(line, (k, v) => {
          const m = map.metadata;
          if (k === "Title") m.title = v;
          else if (k === "TitleUnicode") m.titleUnicode = v;
          else if (k === "Artist") m.artist = v;
          else if (k === "ArtistUnicode") m.artistUnicode = v;
          else if (k === "Creator") m.creator = v;
          else if (k === "Version") m.version = v;
          else if (k === "Source") m.source = v;
          else if (k === "Tags") m.tags = v;
        });
        break;
      case "Difficulty":
        applyKeyValue(line, (k, v) => {
          if (k === "HPDrainRate") map.difficulty.hp = num(v);
          else if (k === "CircleSize") map.difficulty.keyCount = Math.round(num(v));
          else if (k === "OverallDifficulty") map.difficulty.od = num(v);
        });
        break;
      case "TimingPoints": {
        const tp = parseTimingPoint(line);
        if (tp) map.timingPoints.push(tp);
        break;
      }
      case "HitObjects":
        rawHitObjects.push(line);
        break;
      default:
        // Ignore [Editor], [Events], [Colours], storyboard, etc.
        break;
    }
  }

  const keyCount = Math.max(1, Math.min(18, map.difficulty.keyCount || 4));
  map.difficulty.keyCount = keyCount;
  for (const raw of rawHitObjects) {
    const o = parseHitObject(raw, keyCount);
    if (o) map.hitObjects.push(o);
  }

  map.hitObjects.sort((a, b) => a.time - b.time || a.column - b.column);
  return map;
}

function applyKeyValue(line: string, fn: (key: string, value: string) => void): void {
  const idx = line.indexOf(":");
  if (idx === -1) return;
  const key = line.slice(0, idx).trim();
  const value = line.slice(idx + 1).trim();
  fn(key, value);
}

export function parseTimingPoint(line: string): TimingPoint | null {
  const parts = line.split(",").map((s) => s.trim());
  if (parts.length < 2) return null;
  const time = num(parts[0]);
  const beatLength = num(parts[1]);
  const meter = parts.length > 2 ? Math.round(num(parts[2])) : 4;
  const sampleSet = parts.length > 3 ? Math.round(num(parts[3])) : 0;
  const sampleIndex = parts.length > 4 ? Math.round(num(parts[4])) : 0;
  const volume = parts.length > 5 ? Math.round(num(parts[5])) : 100;
  // The uninherited flag is optional in old maps; positive beatLength implies red.
  const uninherited =
    parts.length > 6 ? parts[6] === "1" : beatLength > 0;
  const effects = parts.length > 7 ? Math.round(num(parts[7])) : 0;

  return {
    time,
    uninherited,
    bpm: uninherited ? 60000 / beatLength : 120,
    sv: uninherited ? 1 : -100 / beatLength,
    meter: meter || 4,
    volume,
    sampleSet,
    sampleIndex,
    effects,
  };
}

export function parseHitObject(line: string, keyCount: number): HitObject | null {
  const parts = line.split(",");
  if (parts.length < 5) return null;
  const x = Math.round(num(parts[0]));
  const time = Math.round(num(parts[3 - 1])); // parts[2]
  const type = Math.round(num(parts[3]));
  const hitSound = Math.round(num(parts[4]));
  const column = xToColumn(x, keyCount);

  const isHoldNote = (type & 128) !== 0;
  let endTime: number | undefined;
  if (isHoldNote && parts.length >= 6) {
    // objectParams for a hold is "endTime:hitSample...".
    const endField = parts[5].split(":")[0];
    endTime = Math.round(num(endField));
  }

  return { column, time, endTime, hitSound };
}

function num(s: string): number {
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}
