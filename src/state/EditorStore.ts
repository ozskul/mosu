/**
 * Central editor state: the beatmap document, the current selection, and an
 * undo/redo history. Mutations go through methods that snapshot the document so
 * undo/redo is uniform and reliable. Subscribers are notified on every change.
 */
import {
  allocId,
  createEmptyBeatmap,
  isHold,
  type Beatmap,
  type HitObject,
  type TimingPoint,
} from "../types.ts";

type Listener = () => void;

interface Snapshot {
  beatmap: Beatmap;
  selection: number[];
}

const HISTORY_LIMIT = 200;

export class EditorStore {
  private _beatmap: Beatmap;
  private _selection = new Set<number>();
  private undoStack: Snapshot[] = [];
  private redoStack: Snapshot[] = [];
  private listeners = new Set<Listener>();
  private _dirty = false;

  constructor(beatmap?: Beatmap) {
    this._beatmap = beatmap ?? createEmptyBeatmap(4);
    this.ensureIds();
  }

  // ---- access -------------------------------------------------------------

  get beatmap(): Beatmap {
    return this._beatmap;
  }

  get keyCount(): number {
    return this._beatmap.difficulty.keyCount;
  }

  get selection(): ReadonlySet<number> {
    return this._selection;
  }

  get dirty(): boolean {
    return this._dirty;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    this.listeners.forEach((fn) => fn());
  }

  // ---- history ------------------------------------------------------------

  /** Replace the whole document (e.g. on import). Clears history. */
  loadBeatmap(map: Beatmap): void {
    this._beatmap = map;
    this.ensureIds();
    this._selection.clear();
    this.undoStack = [];
    this.redoStack = [];
    this._dirty = false;
    this.emit();
  }

  /** Run a mutation, snapshotting state first so it can be undone. */
  private mutate(fn: () => void): void {
    this.pushHistory();
    fn();
    this._dirty = true;
    this.emit();
  }

  private pushHistory(): void {
    this.undoStack.push(this.snapshot());
    if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
    this.redoStack = [];
  }

  private snapshot(): Snapshot {
    return {
      beatmap: structuredClone(this._beatmap),
      selection: [...this._selection],
    };
  }

  private restore(s: Snapshot): void {
    this._beatmap = s.beatmap;
    this._selection = new Set(s.selection);
  }

  undo(): void {
    const s = this.undoStack.pop();
    if (!s) return;
    this.redoStack.push(this.snapshot());
    this.restore(s);
    this._dirty = true;
    this.emit();
  }

  redo(): void {
    const s = this.redoStack.pop();
    if (!s) return;
    this.undoStack.push(this.snapshot());
    this.restore(s);
    this._dirty = true;
    this.emit();
  }

  markSaved(): void {
    this._dirty = false;
    this.emit();
  }

  // ---- metadata / difficulty ---------------------------------------------

  updateMetadata(patch: Partial<Beatmap["metadata"]>): void {
    this.mutate(() => {
      Object.assign(this._beatmap.metadata, patch);
    });
  }

  updateGeneral(patch: Partial<Beatmap["general"]>): void {
    this.mutate(() => {
      Object.assign(this._beatmap.general, patch);
    });
  }

  updateDifficulty(patch: Partial<Beatmap["difficulty"]>): void {
    this.mutate(() => {
      const prevKeys = this._beatmap.difficulty.keyCount;
      Object.assign(this._beatmap.difficulty, patch);
      const keys = this._beatmap.difficulty.keyCount;
      if (keys !== prevKeys) {
        // Drop notes that fall outside the new column range.
        this._beatmap.hitObjects = this._beatmap.hitObjects.filter(
          (o) => o.column < keys,
        );
      }
    });
  }

  // ---- timing points ------------------------------------------------------

  addTimingPoint(tp: Omit<TimingPoint, "time"> & { time: number }): void {
    this.mutate(() => {
      this._beatmap.timingPoints.push({ ...tp });
      this._beatmap.timingPoints.sort((a, b) => a.time - b.time);
    });
  }

  updateTimingPoint(index: number, patch: Partial<TimingPoint>): void {
    this.mutate(() => {
      const tp = this._beatmap.timingPoints[index];
      if (!tp) return;
      Object.assign(tp, patch);
      this._beatmap.timingPoints.sort((a, b) => a.time - b.time);
    });
  }

  removeTimingPoint(index: number): void {
    this.mutate(() => {
      this._beatmap.timingPoints.splice(index, 1);
    });
  }

  // ---- hit objects --------------------------------------------------------

  private noteAt(column: number, time: number, tol = 1): HitObject | undefined {
    return this._beatmap.hitObjects.find(
      (o) => o.column === column && Math.abs(o.time - time) <= tol,
    );
  }

  /** Add a tap note, or remove an existing note at the same cell (toggle). */
  toggleNote(column: number, time: number): void {
    const existing = this.noteAt(column, time);
    if (existing) {
      this.removeById(existing.id!);
      return;
    }
    this.mutate(() => {
      const note: HitObject = { id: allocId(), column, time, hitSound: 0 };
      this._beatmap.hitObjects.push(note);
      this._beatmap.hitObjects.sort((a, b) => a.time - b.time);
    });
  }

  addNote(column: number, time: number): HitObject | null {
    if (this.noteAt(column, time)) return null;
    let created: HitObject | null = null;
    this.mutate(() => {
      created = { id: allocId(), column, time, hitSound: 0 };
      this._beatmap.hitObjects.push(created);
      this._beatmap.hitObjects.sort((a, b) => a.time - b.time);
    });
    return created;
  }

  /** Add a hold note spanning [startTime, endTime] in a column. */
  addHold(column: number, startTime: number, endTime: number): void {
    const lo = Math.min(startTime, endTime);
    const hi = Math.max(startTime, endTime);
    if (hi - lo < 1) {
      this.toggleNote(column, lo);
      return;
    }
    this.mutate(() => {
      // Remove any notes that the hold would overlap in this column.
      this._beatmap.hitObjects = this._beatmap.hitObjects.filter((o) => {
        if (o.column !== column) return true;
        const oStart = o.time;
        const oEnd = isHold(o) ? o.endTime! : o.time;
        return oEnd < lo || oStart > hi;
      });
      this._beatmap.hitObjects.push({
        id: allocId(),
        column,
        time: lo,
        endTime: hi,
        hitSound: 0,
      });
      this._beatmap.hitObjects.sort((a, b) => a.time - b.time);
    });
  }

  removeById(id: number): void {
    this.mutate(() => {
      this._beatmap.hitObjects = this._beatmap.hitObjects.filter(
        (o) => o.id !== id,
      );
      this._selection.delete(id);
    });
  }

  deleteSelection(): void {
    if (this._selection.size === 0) return;
    this.mutate(() => {
      this._beatmap.hitObjects = this._beatmap.hitObjects.filter(
        (o) => !this._selection.has(o.id!),
      );
      this._selection.clear();
    });
  }

  // ---- selection ----------------------------------------------------------

  setSelection(ids: Iterable<number>): void {
    this._selection = new Set(ids);
    this.emit();
  }

  toggleSelect(id: number): void {
    if (this._selection.has(id)) this._selection.delete(id);
    else this._selection.add(id);
    this.emit();
  }

  clearSelection(): void {
    if (this._selection.size === 0) return;
    this._selection.clear();
    this.emit();
  }

  selectedObjects(): HitObject[] {
    return this._beatmap.hitObjects.filter((o) => this._selection.has(o.id!));
  }

  /** Move every selected note by a time delta (ms) and/or column delta. */
  moveSelection(deltaTime: number, deltaColumn: number): void {
    if (this._selection.size === 0) return;
    const keys = this.keyCount;
    this.mutate(() => {
      for (const o of this._beatmap.hitObjects) {
        if (!this._selection.has(o.id!)) continue;
        o.time += deltaTime;
        if (o.endTime !== undefined) o.endTime += deltaTime;
        o.column = clampInt(o.column + deltaColumn, 0, keys - 1);
      }
      this._beatmap.hitObjects.sort((a, b) => a.time - b.time);
    });
  }

  /** Mirror selected notes horizontally (column -> keyCount-1-column). */
  mirrorSelection(): void {
    if (this._selection.size === 0) return;
    const keys = this.keyCount;
    this.mutate(() => {
      for (const o of this._beatmap.hitObjects) {
        if (!this._selection.has(o.id!)) continue;
        o.column = keys - 1 - o.column;
      }
    });
  }

  // ---- clipboard ----------------------------------------------------------

  /** Returns a serialisable copy of the current selection, time-zeroed. */
  copySelection(): HitObject[] {
    const sel = this.selectedObjects();
    if (sel.length === 0) return [];
    const base = Math.min(...sel.map((o) => o.time));
    return sel.map((o) => ({
      column: o.column,
      time: o.time - base,
      endTime: o.endTime !== undefined ? o.endTime - base : undefined,
      hitSound: o.hitSound,
    }));
  }

  /** Paste clipboard notes so the earliest lands at `atTime`. */
  paste(clip: HitObject[], atTime: number): void {
    if (clip.length === 0) return;
    const keys = this.keyCount;
    this.mutate(() => {
      const newIds: number[] = [];
      for (const c of clip) {
        if (c.column >= keys) continue;
        const id = allocId();
        newIds.push(id);
        this._beatmap.hitObjects.push({
          id,
          column: c.column,
          time: c.time + atTime,
          endTime: c.endTime !== undefined ? c.endTime + atTime : undefined,
          hitSound: c.hitSound,
        });
      }
      this._beatmap.hitObjects.sort((a, b) => a.time - b.time);
      this._selection = new Set(newIds);
    });
  }

  // ---- helpers ------------------------------------------------------------

  /** Make sure every hit object has an editor id (after import/clone). */
  private ensureIds(): void {
    for (const o of this._beatmap.hitObjects) {
      if (o.id === undefined) o.id = allocId();
    }
  }
}

function clampInt(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.round(v)));
}
