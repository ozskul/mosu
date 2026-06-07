/**
 * Core domain model for an osu!mania beatmap.
 *
 * The shapes here are an editor-friendly intermediate representation. They are
 * translated to/from the on-disk `.osu` text format by `src/osu/serializer.ts`
 * and `src/osu/parser.ts`. See those files for the exact format mapping and a
 * link to the upstream spec.
 */

export interface GeneralInfo {
  /** File name of the audio track as it will appear inside the .osz. */
  audioFilename: string;
  /** Delay (ms) before the audio starts during play. */
  audioLeadIn: number;
  /** Time (ms) of the audio preview point, or -1 for none. */
  previewTime: number;
}

export interface Metadata {
  title: string;
  titleUnicode: string;
  artist: string;
  artistUnicode: string;
  creator: string;
  /** The difficulty name (osu! calls this "Version"). */
  version: string;
  source: string;
  /** Space-separated search tags. */
  tags: string;
}

export interface DifficultyInfo {
  /**
   * Number of columns / keys. In the .osu format this is stored as
   * `CircleSize` in the [Difficulty] section.
   */
  keyCount: number;
  hp: number;
  od: number;
}

/**
 * A timing point. osu! has two kinds:
 *  - "uninherited" (red lines) define the BPM via `beatLength = 60000 / bpm`.
 *  - "inherited" (green lines) override scroll velocity / volume / hitsounds.
 *    Their slider velocity multiplier is encoded as `beatLength = -100 / sv`.
 */
export interface TimingPoint {
  time: number;
  uninherited: boolean;
  /** BPM, meaningful when `uninherited` is true. */
  bpm: number;
  /** Slider-velocity multiplier, meaningful when `uninherited` is false. */
  sv: number;
  /** Beats per measure (time signature numerator). */
  meter: number;
  /** Playback volume 0–100. */
  volume: number;
  sampleSet: number;
  sampleIndex: number;
  /** Effects bitfield (bit 0 = kiai). */
  effects: number;
}

/** Hitsound additions bitfield used by both osu! and this editor. */
export const HitSound = {
  Normal: 0,
  Whistle: 2,
  Finish: 4,
  Clap: 8,
} as const;

/**
 * A single playable object. A note with `endTime` set is a long/hold note,
 * otherwise it is a tap.
 */
export interface HitObject {
  /**
   * Editor-only stable identity, used to track selection across undo/redo
   * snapshots. Not part of the .osu format and ignored by the serializer.
   */
  id?: number;
  /** 0-based column index, 0 = leftmost. */
  column: number;
  /** Start time in ms. */
  time: number;
  /** End time in ms for hold notes; undefined for taps. */
  endTime?: number;
  /** Hitsound additions bitfield. */
  hitSound: number;
}

let nextHitObjectId = 1;
/** Allocate a fresh editor-only hit object id. */
export function allocId(): number {
  return nextHitObjectId++;
}

export interface Beatmap {
  /** osu! file format version this map targets. */
  formatVersion: number;
  general: GeneralInfo;
  metadata: Metadata;
  difficulty: DifficultyInfo;
  timingPoints: TimingPoint[];
  hitObjects: HitObject[];
}

export function createEmptyBeatmap(keyCount = 4): Beatmap {
  return {
    formatVersion: 14,
    general: {
      audioFilename: "audio.mp3",
      audioLeadIn: 0,
      previewTime: -1,
    },
    metadata: {
      title: "",
      titleUnicode: "",
      artist: "",
      artistUnicode: "",
      creator: "",
      version: "Normal",
      source: "",
      tags: "",
    },
    difficulty: {
      keyCount,
      hp: 5,
      od: 8,
    },
    timingPoints: [],
    hitObjects: [],
  };
}

/** True when the object is a hold/long note. */
export function isHold(o: HitObject): boolean {
  return o.endTime !== undefined && o.endTime > o.time;
}
