/**
 * Shift every time in a beatmap by `deltaMs` (returns a clone). Used when
 * exporting a map that starts partway through the song: the audio is trimmed
 * and everything is moved earlier so the map's content lines up with the new
 * 0:00. Objects that would land before 0 are dropped; a hold straddling 0 has
 * its head clamped to 0.
 */
import type { Beatmap } from "../types.ts";

export function shiftBeatmap(map: Beatmap, deltaMs: number): Beatmap {
  const m = structuredClone(map);

  m.hitObjects = m.hitObjects
    .map((o) => ({
      ...o,
      time: o.time + deltaMs,
      endTime: o.endTime !== undefined ? o.endTime + deltaMs : undefined,
    }))
    .filter((o) => (o.endTime ?? o.time) >= 0)
    .map((o) => (o.time < 0 ? { ...o, time: 0 } : o))
    .sort((a, b) => a.time - b.time || a.column - b.column);

  m.timingPoints = m.timingPoints
    .map((tp) => ({ ...tp, time: Math.max(0, tp.time + deltaMs) }))
    .sort((a, b) => a.time - b.time);

  if (m.general.previewTime >= 0) {
    m.general.previewTime = Math.max(0, m.general.previewTime + deltaMs);
  }

  return m;
}
