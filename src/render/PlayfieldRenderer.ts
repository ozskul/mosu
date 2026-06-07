/**
 * Canvas 2D renderer for the editor playfield. Draws the column lanes, the
 * beat grid (colour-coded by snap divisor), notes and hold bodies, the current
 * selection, an in-progress hold/drag preview, and the judgement line.
 *
 * The renderer is stateless with respect to editing — it just paints whatever
 * the EditorStore + Viewport describe each frame.
 */
import { isHold, type Beatmap, type HitObject } from "../types.ts";
import { gridLines } from "../timing/timing.ts";
import type { Viewport } from "./Viewport.ts";
import type { NoteSkin } from "../state/settings.ts";
import { drawNoteShape, columnColor, roundRect } from "./shapes.ts";

export interface RenderInput {
  beatmap: Beatmap;
  selection: ReadonlySet<number>;
  currentTime: number;
  divisor: number;
  /** Shape used to draw notes. */
  skin: NoteSkin;
  /** Detected onset times (ms, sorted) to draw as alignment guides. */
  onsets?: readonly number[] | null;
  /** Optional in-progress hold being dragged: column + start/end times. */
  pendingHold?: { column: number; startTime: number; endTime: number } | null;
  /** Optional column index currently hovered (for highlight). */
  hoverColumn?: number | null;
  /** Currently playing (test mode) — hides the editor grid niceties if true. */
  playMode?: boolean;
}

/** Colours keyed by the finest snap divisor a grid line aligns to. */
const DIVISOR_COLORS: Record<number, string> = {
  1: "#ffffff",
  2: "#d23bf0",
  3: "#7b61ff",
  4: "#4aa3ff",
  6: "#9b59b6",
  8: "#f1c40f",
  12: "#9b59b6",
  16: "#e67e22",
};

export class PlayfieldRenderer {
  private ctx: CanvasRenderingContext2D;
  private dpr = 1;

  constructor(private canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D not supported");
    this.ctx = ctx;
  }

  /** Resize the backing store to match the displayed size and device pixels. */
  resize(): { width: number; height: number } {
    const rect = this.canvas.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, Math.floor(rect.width * this.dpr));
    this.canvas.height = Math.max(1, Math.floor(rect.height * this.dpr));
    return { width: rect.width, height: rect.height };
  }

  get cssWidth(): number {
    return this.canvas.getBoundingClientRect().width;
  }
  get cssHeight(): number {
    return this.canvas.getBoundingClientRect().height;
  }

  /** Geometry helpers shared with hit-testing in the controller. */
  laneWidth(width: number, keyCount: number): number {
    return width / keyCount;
  }
  columnAtX(x: number, width: number, keyCount: number): number {
    const lw = this.laneWidth(width, keyCount);
    return Math.max(0, Math.min(keyCount - 1, Math.floor(x / lw)));
  }

  render(input: RenderInput, vp: Viewport): void {
    const ctx = this.ctx;
    const W = this.cssWidth;
    const H = this.cssHeight;
    ctx.save();
    ctx.scale(this.dpr, this.dpr);
    ctx.clearRect(0, 0, W, H);

    const keys = input.beatmap.difficulty.keyCount;
    const lw = this.laneWidth(W, keys);

    // Playfield background.
    ctx.fillStyle = "#11131a";
    ctx.fillRect(0, 0, W, H);

    // Lane separators + hover highlight.
    for (let c = 0; c < keys; c++) {
      const x = c * lw;
      if (input.hoverColumn === c) {
        ctx.fillStyle = "rgba(255,255,255,0.04)";
        ctx.fillRect(x, 0, lw, H);
      }
      ctx.strokeStyle = "rgba(255,255,255,0.08)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, H);
      ctx.stroke();
    }
    // Right border.
    ctx.beginPath();
    ctx.moveTo(W - 0.5, 0);
    ctx.lineTo(W - 0.5, H);
    ctx.stroke();

    // Beat grid lines.
    const [t0, t1] = vp.visibleRange(input.currentTime, H);
    const lines = gridLines(input.beatmap.timingPoints, t0, t1, input.divisor);
    for (const line of lines) {
      const y = vp.timeToY(line.time, input.currentTime);
      if (y < 0 || y > H) continue;
      ctx.strokeStyle = DIVISOR_COLORS[line.divisor] ?? "#888";
      ctx.globalAlpha = line.divisor === 1 ? 0.55 : 0.22;
      ctx.lineWidth = line.divisor === 1 ? 2 : 1;
      ctx.beginPath();
      ctx.moveTo(0, y + 0.5);
      ctx.lineTo(W, y + 0.5);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // Detected onset guides (where the song actually "hits"), so notes and the
    // beat grid can be lined up to the audio. Drawn in teal to stand apart from
    // the snap grid.
    if (input.onsets && input.onsets.length) {
      const teal = "#17e0c4";
      const start = lowerBound(input.onsets, t0);
      for (let i = start; i < input.onsets.length; i++) {
        const t = input.onsets[i];
        if (t > t1) break;
        const y = vp.timeToY(t, input.currentTime);
        if (y < 0 || y > H) continue;
        ctx.strokeStyle = teal;
        ctx.globalAlpha = 0.15;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(0, y + 0.5);
        ctx.lineTo(W, y + 0.5);
        ctx.stroke();
        // Solid arrow markers in the gutters for clear alignment.
        ctx.globalAlpha = 0.9;
        ctx.fillStyle = teal;
        ctx.beginPath();
        ctx.moveTo(0, y - 5);
        ctx.lineTo(7, y);
        ctx.lineTo(0, y + 5);
        ctx.closePath();
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(W, y - 5);
        ctx.lineTo(W - 7, y);
        ctx.lineTo(W, y + 5);
        ctx.closePath();
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }

    // Judgement line.
    ctx.strokeStyle = "#ffd54f";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(0, vp.judgeY + 0.5);
    ctx.lineTo(W, vp.judgeY + 0.5);
    ctx.stroke();

    // Notes.
    const noteH = Math.max(8, Math.min(18, lw * 0.28));
    for (const o of input.beatmap.hitObjects) {
      this.drawNote(o, input, vp, lw, noteH, H);
    }

    // Pending hold preview.
    if (input.pendingHold) {
      const { column, startTime, endTime } = input.pendingHold;
      const ghost: HitObject = {
        column,
        time: Math.min(startTime, endTime),
        endTime: Math.max(startTime, endTime),
        hitSound: 0,
      };
      ctx.globalAlpha = 0.5;
      this.drawNote(ghost, input, vp, lw, noteH, H, true);
      ctx.globalAlpha = 1;
    }

    ctx.restore();
  }

  private drawNote(
    o: HitObject,
    input: RenderInput,
    vp: Viewport,
    lw: number,
    noteH: number,
    H: number,
    ghost = false,
  ): void {
    const ctx = this.ctx;
    const cx = o.column * lw + lw / 2;
    const yHead = vp.timeToY(o.time, input.currentTime);
    const color = columnColor(o.column, input.beatmap.difficulty.keyCount);
    const selected = o.id !== undefined && input.selection.has(o.id);

    if (isHold(o)) {
      const yTail = vp.timeToY(o.endTime!, input.currentTime);
      const top = Math.min(yHead, yTail);
      const bottom = Math.max(yHead, yTail);
      if (bottom < 0 || top > H) return;
      // Hold body.
      ctx.save();
      ctx.fillStyle = ghost ? color : shade(color, -0.25);
      ctx.globalAlpha = ghost ? 0.5 : 0.7;
      roundRect(ctx, cx - lw * 0.32, top, lw * 0.64, bottom - top, 5);
      ctx.fill();
      ctx.restore();
      // Head + tail caps.
      this.cap(cx, yHead, lw, noteH, color, selected, input.skin);
      this.cap(cx, yTail, lw, noteH, color, selected, input.skin);
    } else {
      if (yHead < -noteH || yHead > H + noteH) return;
      this.cap(cx, yHead, lw, noteH, color, selected, input.skin);
    }
  }

  private cap(
    cx: number,
    y: number,
    lw: number,
    noteH: number,
    color: string,
    selected: boolean,
    skin: NoteSkin,
  ): void {
    drawNoteShape(this.ctx, skin, cx, y, lw * 0.76, noteH, {
      fill: color,
      stroke: selected ? "#ffffff" : "rgba(0,0,0,0.35)",
      strokeWidth: selected ? 2.5 : 1,
      glow: selected ? 8 : 0,
    });
  }
}

/** First index in a sorted array whose value is >= target. */
function lowerBound(arr: readonly number[], target: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function shade(hex: string, amt: number): string {
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) & 0xff;
  let g = (n >> 8) & 0xff;
  let b = n & 0xff;
  r = Math.max(0, Math.min(255, Math.round(r + 255 * amt)));
  g = Math.max(0, Math.min(255, Math.round(g + 255 * amt)));
  b = Math.max(0, Math.min(255, Math.round(b + 255 * amt)));
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
}
