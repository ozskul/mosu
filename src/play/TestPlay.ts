/**
 * Minimal test-play mode. Lets the creator play the chart against the audio to
 * sanity-check playability. Notes scroll on the same playfield; each column is
 * bound to a key and presses are judged against the nearest unhit note within a
 * timing window. This is a feel-check, not a faithful scoring implementation.
 */
import { isHold, type Beatmap, type HitObject } from "../types.ts";
import type { AudioEngine } from "../audio/AudioEngine.ts";

export type Judgement = "perfect" | "great" | "good" | "miss";

/** Hit windows in milliseconds (absolute time difference). */
const WINDOWS: Record<Exclude<Judgement, "miss">, number> = {
  perfect: 40,
  great: 80,
  good: 120,
};
const MISS_WINDOW = 160;

export interface PlayStats {
  perfect: number;
  great: number;
  good: number;
  miss: number;
  combo: number;
  maxCombo: number;
}

interface NoteState {
  note: HitObject;
  judged: boolean;
  holding: boolean;
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
  // Fallback: spread the alpha home row.
  const pool = ["KeyA", "KeyS", "KeyD", "KeyF", "KeyG", "KeyH", "KeyJ", "KeyK", "KeyL", "Semicolon"];
  return pool.slice(0, keyCount);
}

export class TestPlay {
  private states: NoteState[] = [];
  private keyMap = new Map<string, number>();
  stats: PlayStats = { perfect: 0, great: 0, good: 0, miss: 0, combo: 0, maxCombo: 0 };
  private onUpdate: () => void;
  private keyDownHandler: (e: KeyboardEvent) => void;
  private keyUpHandler: (e: KeyboardEvent) => void;
  private active = false;

  constructor(
    beatmap: Beatmap,
    private audio: AudioEngine,
    onUpdate: () => void,
  ) {
    this.onUpdate = onUpdate;
    const keys = defaultKeys(beatmap.difficulty.keyCount);
    keys.forEach((code, col) => this.keyMap.set(code, col));
    this.states = beatmap.hitObjects.map((note) => ({
      note,
      judged: false,
      holding: false,
    }));
    this.keyDownHandler = (e) => this.handleDown(e);
    this.keyUpHandler = (e) => this.handleUp(e);
  }

  /** Returns the key bound to a column, for on-screen hints. */
  keyLabel(column: number): string {
    for (const [code, col] of this.keyMap) {
      if (col === column) return codeToLabel(code);
    }
    return "";
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    window.addEventListener("keydown", this.keyDownHandler);
    window.addEventListener("keyup", this.keyUpHandler);
  }

  stop(): void {
    this.active = false;
    window.removeEventListener("keydown", this.keyDownHandler);
    window.removeEventListener("keyup", this.keyUpHandler);
  }

  /** Call each frame to register misses for notes that scrolled past. */
  update(): void {
    const t = this.audio.positionMs();
    let changed = false;
    for (const s of this.states) {
      if (s.judged) continue;
      if (t - s.note.time > MISS_WINDOW) {
        s.judged = true;
        this.applyJudgement("miss");
        changed = true;
      }
    }
    if (changed) this.onUpdate();
  }

  private handleDown(e: KeyboardEvent): void {
    if (e.repeat) return;
    const col = this.keyMap.get(e.code);
    if (col === undefined) return;
    e.preventDefault();
    const t = this.audio.positionMs();
    // Nearest unjudged note in this column within the miss window.
    let best: NoteState | null = null;
    let bestDiff = Infinity;
    for (const s of this.states) {
      if (s.judged || s.note.column !== col) continue;
      const diff = Math.abs(s.note.time - t);
      if (diff < bestDiff && diff <= MISS_WINDOW) {
        best = s;
        bestDiff = diff;
      }
    }
    if (!best) return;
    const judgement = judgementFor(bestDiff);
    if (judgement === "miss") {
      best.judged = true;
      this.applyJudgement("miss");
    } else if (isHold(best.note)) {
      // Begin holding; final judgement on key release.
      best.holding = true;
    } else {
      best.judged = true;
      this.applyJudgement(judgement);
    }
    this.onUpdate();
  }

  private handleUp(e: KeyboardEvent): void {
    const col = this.keyMap.get(e.code);
    if (col === undefined) return;
    const t = this.audio.positionMs();
    for (const s of this.states) {
      if (s.holding && s.note.column === col) {
        s.holding = false;
        s.judged = true;
        const diff = Math.abs((s.note.endTime ?? s.note.time) - t);
        this.applyJudgement(judgementFor(diff));
        this.onUpdate();
      }
    }
  }

  private applyJudgement(j: Judgement): void {
    this.stats[j]++;
    if (j === "miss") {
      this.stats.combo = 0;
    } else {
      this.stats.combo++;
      this.stats.maxCombo = Math.max(this.stats.maxCombo, this.stats.combo);
    }
  }
}

function judgementFor(diff: number): Judgement {
  if (diff <= WINDOWS.perfect) return "perfect";
  if (diff <= WINDOWS.great) return "great";
  if (diff <= WINDOWS.good) return "good";
  return "miss";
}

function codeToLabel(code: string): string {
  if (code === "Space") return "␣";
  if (code === "Semicolon") return ";";
  return code.replace(/^Key/, "");
}
