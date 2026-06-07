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

export interface RenderInput {
  beatmap: Beatmap;
  selection: ReadonlySet<number>;
  currentTime: number;
  divisor: number;
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

const NOTE_COLORS = ["#42a5f5", "#ef5350", "#42a5f5", "#ef5350", "#66bb6a", "#ffca28", "#ab47bc", "#26c6da", "#ff7043", "#8d6e63"];

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
    const x = o.column * lw;
    const yHead = vp.timeToY(o.time, input.currentTime);
    const color = NOTE_COLORS[o.column % NOTE_COLORS.length];
    const selected = o.id !== undefined && input.selection.has(o.id);

    if (isHold(o)) {
      const yTail = vp.timeToY(o.endTime!, input.currentTime);
      const top = Math.min(yHead, yTail);
      const bottom = Math.max(yHead, yTail);
      if (bottom < 0 || top > H) return;
      // Hold body.
      ctx.fillStyle = ghost ? color : shade(color, -0.25);
      ctx.globalAlpha = ghost ? ctx.globalAlpha : 0.75;
      ctx.fillRect(x + lw * 0.18, top, lw * 0.64, bottom - top);
      ctx.globalAlpha = ghost ? ctx.globalAlpha : 1;
      // Head + tail caps.
      this.cap(x, yHead, lw, noteH, color, selected);
      this.cap(x, yTail, lw, noteH, color, selected);
    } else {
      if (yHead < -noteH || yHead > H + noteH) return;
      this.cap(x, yHead, lw, noteH, color, selected);
    }
  }

  private cap(
    x: number,
    y: number,
    lw: number,
    noteH: number,
    color: string,
    selected: boolean,
  ): void {
    const ctx = this.ctx;
    const pad = lw * 0.12;
    ctx.fillStyle = color;
    roundRect(ctx, x + pad, y - noteH / 2, lw - pad * 2, noteH, 4);
    ctx.fill();
    if (selected) {
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 2;
      roundRect(ctx, x + pad, y - noteH / 2, lw - pad * 2, noteH, 4);
      ctx.stroke();
    } else {
      ctx.strokeStyle = "rgba(0,0,0,0.35)";
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
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
