/**
 * Pre-export sanity checks. A map can import into osu! yet refuse to play if it
 * lacks the essentials — most commonly **no uninherited (BPM) timing point**,
 * which osu!mania requires to position the scroll, or no hit objects/audio.
 * These checks surface those problems before the user ships a broken .osz.
 */
import type { Beatmap } from "../types.ts";

export interface ExportIssue {
  /** Blocking issues make the map unplayable; warnings are cosmetic/metadata. */
  blocking: boolean;
  message: string;
}

export function collectExportIssues(maps: Beatmap[], hasAudio: boolean): ExportIssue[] {
  const issues: ExportIssue[] = [];

  if (!hasAudio) {
    issues.push({
      blocking: true,
      message: "No audio is loaded — load the song before exporting.",
    });
  }

  for (const m of maps) {
    const name = m.metadata.version || "(unnamed)";
    if (!m.timingPoints.some((t) => t.uninherited)) {
      issues.push({
        blocking: true,
        message: `Difficulty “${name}” has no BPM timing point — osu!mania can't play it without one. Add one in the Timing tab (set BPM + offset, then “Add BPM point”).`,
      });
    }
    if (m.hitObjects.length === 0) {
      issues.push({
        blocking: true,
        message: `Difficulty “${name}” has no notes.`,
      });
    }
  }

  const first = maps[0];
  if (first && !first.metadata.title.trim()) {
    issues.push({ blocking: false, message: "No song Title set (Song tab)." });
  }
  if (first && !first.metadata.artist.trim()) {
    issues.push({ blocking: false, message: "No Artist set (Song tab)." });
  }

  return issues;
}

/** Build a human-readable summary, blocking issues first. */
export function describeIssues(issues: ExportIssue[]): string {
  const ordered = [...issues].sort((a, b) => Number(b.blocking) - Number(a.blocking));
  return ordered.map((i) => `• ${i.message}`).join("\n");
}
