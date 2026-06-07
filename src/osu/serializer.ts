/**
 * Serialize a Beatmap to the osu! `.osu` text format (v14).
 *
 * Reference: https://osu.ppy.sh/wiki/en/Client/File_formats/osu_%28file_format%29
 *
 * Key mania-specific details implemented here:
 *
 *  - Mode is 3 (osu!mania). The column count is stored as `CircleSize` in the
 *    [Difficulty] section.
 *
 *  - A hit object's column is encoded in its x coordinate. osu! decodes the
 *    column as `floor(x * keyCount / 512)`, so we encode the *centre* of each
 *    column: `x = floor((column + 0.5) * 512 / keyCount)`. y is always 192.
 *
 *  - Object type is a bitfield: bit 0 (value 1) = normal note,
 *    bit 7 (value 128) = mania hold (long) note.
 *
 *  - A hold note stores its end time in the `objectParams` slot, immediately
 *    followed by a colon and the hitSample fields, i.e.
 *        x,y,time,128,hitSound,endTime:normalSet:additionSet:index:volume:filename
 *    A normal note instead ends with the hitSample directly:
 *        x,y,time,1,hitSound,normalSet:additionSet:index:volume:filename
 *
 *  - Timing points: `time,beatLength,meter,sampleSet,sampleIndex,volume,uninherited,effects`.
 *    Uninherited (red) lines carry `beatLength = 60000 / bpm` and uninherited = 1.
 *    Inherited (green) lines carry `beatLength = -100 / sv` and uninherited = 0.
 */
import type { Beatmap, HitObject, TimingPoint } from "../types.ts";
import { isHold } from "../types.ts";

const MANIA_MODE = 3;
const MANIA_Y = 192;
const DEFAULT_HITSAMPLE = "0:0:0:0:";

/** x coordinate for a column centre, matching osu!'s decode formula. */
export function columnToX(column: number, keyCount: number): number {
  return Math.floor(((column + 0.5) * 512) / keyCount);
}

/** Decode a column index from an x coordinate. */
export function xToColumn(x: number, keyCount: number): number {
  return Math.max(0, Math.min(keyCount - 1, Math.floor((x * keyCount) / 512)));
}

export function serializeBeatmap(map: Beatmap): string {
  const L: string[] = [];

  L.push(`osu file format v${map.formatVersion}`);
  L.push("");

  L.push("[General]");
  L.push(`AudioFilename: ${map.general.audioFilename}`);
  L.push(`AudioLeadIn: ${map.general.audioLeadIn}`);
  L.push(`PreviewTime: ${map.general.previewTime}`);
  L.push("Countdown: 0");
  L.push("SampleSet: Normal");
  L.push("StackLeniency: 0.7");
  L.push(`Mode: ${MANIA_MODE}`);
  L.push("LetterboxInBreaks: 0");
  L.push("SpecialStyle: 0");
  L.push("WidescreenStoryboard: 0");
  L.push("");

  L.push("[Editor]");
  L.push("DistanceSpacing: 1");
  L.push("BeatDivisor: 4");
  L.push("GridSize: 4");
  L.push("TimelineZoom: 1");
  L.push("");

  L.push("[Metadata]");
  const m = map.metadata;
  L.push(`Title:${m.title}`);
  L.push(`TitleUnicode:${m.titleUnicode || m.title}`);
  L.push(`Artist:${m.artist}`);
  L.push(`ArtistUnicode:${m.artistUnicode || m.artist}`);
  L.push(`Creator:${m.creator}`);
  L.push(`Version:${m.version}`);
  L.push(`Source:${m.source}`);
  L.push(`Tags:${m.tags}`);
  L.push("BeatmapID:0");
  L.push("BeatmapSetID:-1");
  L.push("");

  L.push("[Difficulty]");
  L.push(`HPDrainRate:${map.difficulty.hp}`);
  // CircleSize doubles as the mania key count.
  L.push(`CircleSize:${map.difficulty.keyCount}`);
  L.push(`OverallDifficulty:${map.difficulty.od}`);
  L.push("ApproachRate:5");
  L.push("SliderMultiplier:1.4");
  L.push("SliderTickRate:1");
  L.push("");

  L.push("[Events]");
  L.push("//Background and Video events");
  L.push("//Break Periods");
  L.push("//Storyboard Layer 0 (Background)");
  L.push("//Storyboard Layer 1 (Fail)");
  L.push("//Storyboard Layer 2 (Pass)");
  L.push("//Storyboard Layer 3 (Foreground)");
  L.push("//Storyboard Layer 4 (Overlay)");
  L.push("//Storyboard Sound Samples");
  L.push("");

  L.push("[TimingPoints]");
  for (const tp of sortedTimingPoints(map.timingPoints)) {
    L.push(serializeTimingPoint(tp));
  }
  L.push("");
  L.push("");

  L.push("[HitObjects]");
  const objects = [...map.hitObjects].sort(
    (a, b) => a.time - b.time || a.column - b.column,
  );
  for (const o of objects) {
    L.push(serializeHitObject(o, map.difficulty.keyCount));
  }
  L.push("");

  return L.join("\n");
}

export function sortedTimingPoints(points: TimingPoint[]): TimingPoint[] {
  // Stable sort by time; when equal, red (uninherited) lines come first so the
  // BPM applies before any SV override at the same instant.
  return [...points].sort(
    (a, b) => a.time - b.time || Number(b.uninherited) - Number(a.uninherited),
  );
}

export function serializeTimingPoint(tp: TimingPoint): string {
  const beatLength = tp.uninherited ? 60000 / tp.bpm : -100 / (tp.sv || 1);
  const uninherited = tp.uninherited ? 1 : 0;
  return [
    round(tp.time),
    trimFloat(beatLength),
    tp.meter,
    tp.sampleSet,
    tp.sampleIndex,
    tp.volume,
    uninherited,
    tp.effects,
  ].join(",");
}

export function serializeHitObject(o: HitObject, keyCount: number): string {
  const x = columnToX(o.column, keyCount);
  const hold = isHold(o);
  const type = hold ? 128 : 1;
  const head = [x, MANIA_Y, round(o.time), type, o.hitSound];
  if (hold) {
    return `${head.join(",")},${round(o.endTime!)}:${DEFAULT_HITSAMPLE}`;
  }
  return `${head.join(",")},${DEFAULT_HITSAMPLE}`;
}

function round(n: number): number {
  return Math.round(n);
}

/** Format a float the way osu! does — trim trailing zeros but keep precision. */
function trimFloat(n: number): string {
  if (Number.isInteger(n)) return n.toString();
  // osu! uses invariant culture with up to ~6 significant digits.
  return parseFloat(n.toFixed(6)).toString();
}
