/**
 * Helpers for managing a set of difficulties that share one song. In osu! a
 * mapset is several `.osu` files that share the audio and (by convention) the
 * same song metadata, differing in their Version name, key count, difficulty
 * settings and notes.
 *
 * The editor edits one difficulty at a time (the "active" one); these pure
 * helpers keep the shared fields consistent and mint sensible new names.
 */
import { createEmptyBeatmap, type Beatmap, type Metadata } from "../types.ts";

/** Metadata fields shared across every difficulty in a set (Version is NOT). */
export const SHARED_META: (keyof Metadata)[] = [
  "title",
  "titleUnicode",
  "artist",
  "artistUnicode",
  "creator",
  "source",
  "tags",
];

export function cloneBeatmap(map: Beatmap): Beatmap {
  return structuredClone(map);
}

/**
 * Copy the shared song metadata and the (entirely shared) general/audio block
 * from `from` into every other difficulty, so the set stays consistent.
 */
export function syncSharedMetadata(from: Beatmap, all: Beatmap[]): void {
  for (const m of all) {
    if (m === from) continue;
    for (const k of SHARED_META) {
      (m.metadata[k] as string) = from.metadata[k];
    }
    m.general = { ...from.general };
  }
}

/** Pick an unused Version name based on `base` (e.g. "Normal", "Normal 2", …). */
export function nextVersionName(existing: string[], base = "Normal"): string {
  const taken = new Set(existing);
  if (!taken.has(base)) return base;
  let i = 2;
  while (taken.has(`${base} ${i}`)) i++;
  return `${base} ${i}`;
}

/** A new blank difficulty that shares song metadata, audio and timing. */
export function blankDifficultyFrom(active: Beatmap, existingVersions: string[]): Beatmap {
  const copy = cloneBeatmap(active);
  copy.hitObjects = [];
  copy.metadata.version = nextVersionName(existingVersions, "Normal");
  return copy;
}

/** A full duplicate of a difficulty (notes included) with a fresh Version. */
export function duplicateDifficulty(active: Beatmap, existingVersions: string[]): Beatmap {
  const copy = cloneBeatmap(active);
  copy.metadata.version = nextVersionName(existingVersions, active.metadata.version || "Normal");
  return copy;
}

/** A brand-new, empty single-difficulty set. */
export function emptySet(keyCount = 4): Beatmap[] {
  return [createEmptyBeatmap(keyCount)];
}
