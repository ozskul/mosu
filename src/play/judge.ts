/**
 * Shared judging utilities for test play: hit windows, judgement classification,
 * default key bindings per column, and key-label formatting.
 */
export type Judgement = "perfect" | "great" | "good" | "miss";

/** Hit windows in milliseconds (absolute time difference). */
export const WINDOWS: Record<Exclude<Judgement, "miss">, number> = {
  perfect: 40,
  great: 80,
  good: 120,
};
export const MISS_WINDOW = 160;

export interface PlayStats {
  perfect: number;
  great: number;
  good: number;
  miss: number;
  combo: number;
  maxCombo: number;
}

export function emptyStats(): PlayStats {
  return { perfect: 0, great: 0, good: 0, miss: 0, combo: 0, maxCombo: 0 };
}

export function judgementFor(diff: number): Judgement {
  if (diff <= WINDOWS.perfect) return "perfect";
  if (diff <= WINDOWS.great) return "great";
  if (diff <= WINDOWS.good) return "good";
  return "miss";
}

/** Weighted value of each judgement for accuracy (0–1 per note). */
export function judgementWeight(j: Judgement): number {
  switch (j) {
    case "perfect":
      return 1;
    case "great":
      return 2 / 3;
    case "good":
      return 1 / 3;
    case "miss":
      return 0;
  }
}

export function accuracy(stats: PlayStats): number {
  const judged = stats.perfect + stats.great + stats.good + stats.miss;
  if (judged === 0) return 1;
  const earned =
    stats.perfect * judgementWeight("perfect") +
    stats.great * judgementWeight("great") +
    stats.good * judgementWeight("good");
  return earned / judged;
}

export function grade(acc: number): string {
  if (acc >= 1) return "SS";
  if (acc >= 0.95) return "S";
  if (acc >= 0.9) return "A";
  if (acc >= 0.8) return "B";
  if (acc >= 0.7) return "C";
  return "D";
}

/** Default per-column key bindings for common key counts. */
export function defaultKeys(keyCount: number): string[] {
  const layouts: Record<number, string[]> = {
    1: ["Space"],
    2: ["KeyF", "KeyJ"],
    3: ["KeyF", "Space", "KeyJ"],
    4: ["KeyD", "KeyF", "KeyJ", "KeyK"],
    5: ["KeyD", "KeyF", "Space", "KeyJ", "KeyK"],
    6: ["KeyS", "KeyD", "KeyF", "KeyJ", "KeyK", "KeyL"],
    7: ["KeyS", "KeyD", "KeyF", "Space", "KeyJ", "KeyK", "KeyL"],
    8: ["KeyA", "KeyS", "KeyD", "KeyF", "KeyJ", "KeyK", "KeyL", "Semicolon"],
  };
  if (layouts[keyCount]) return layouts[keyCount];
  const pool = [
    "KeyA", "KeyS", "KeyD", "KeyF", "KeyG",
    "KeyH", "KeyJ", "KeyK", "KeyL", "Semicolon",
  ];
  return pool.slice(0, keyCount);
}

export function codeToLabel(code: string): string {
  if (code === "Space") return "␣";
  if (code === "Semicolon") return ";";
  return code.replace(/^Key/, "");
}
