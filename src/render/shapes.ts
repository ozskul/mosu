/**
 * Note-shape drawing shared by the editor playfield and the test-play renderer,
 * so the chosen skin looks identical in both. Each shape is drawn centred at
 * (cx, cy) within a box of width `w` and height `h`.
 */
import type { NoteSkin } from "../state/settings.ts";

export function roundRect(
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

export interface ShapeStyle {
  fill: string;
  stroke?: string;
  strokeWidth?: number;
  /** Glow/shadow blur for a lit-up look. */
  glow?: number;
}

/**
 * Trace the path of a note shape centred at (cx, cy). The caller fills/strokes.
 * `size` is the full lane width; the shape uses a sensible fraction of it.
 */
function traceShape(
  ctx: CanvasRenderingContext2D,
  skin: NoteSkin,
  cx: number,
  cy: number,
  w: number,
  h: number,
): void {
  switch (skin) {
    case "bar": {
      roundRect(ctx, cx - w / 2, cy - h / 2, w, h, Math.min(6, h / 2));
      break;
    }
    case "circle": {
      const r = Math.min(w, h * 1.6) / 2;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.closePath();
      break;
    }
    case "diamond": {
      const rx = w / 2;
      const ry = Math.max(h, w * 0.55) / 2;
      ctx.beginPath();
      ctx.moveTo(cx, cy - ry);
      ctx.lineTo(cx + rx, cy);
      ctx.lineTo(cx, cy + ry);
      ctx.lineTo(cx - rx, cy);
      ctx.closePath();
      break;
    }
    case "arrow": {
      // A downward-pointing chevron block (notes fall toward the receptor).
      const aw = w * 0.78;
      const ah = Math.max(h, w * 0.5);
      const x0 = cx - aw / 2;
      const x1 = cx + aw / 2;
      const top = cy - ah / 2;
      const bot = cy + ah / 2;
      const mid = cy + ah * 0.08;
      ctx.beginPath();
      ctx.moveTo(x0, top);
      ctx.lineTo(cx, top + ah * 0.35);
      ctx.lineTo(x1, top);
      ctx.lineTo(x1, mid);
      ctx.lineTo(cx, bot);
      ctx.lineTo(x0, mid);
      ctx.closePath();
      break;
    }
  }
}

export function drawNoteShape(
  ctx: CanvasRenderingContext2D,
  skin: NoteSkin,
  cx: number,
  cy: number,
  w: number,
  h: number,
  style: ShapeStyle,
): void {
  ctx.save();
  if (style.glow) {
    ctx.shadowColor = style.fill;
    ctx.shadowBlur = style.glow;
  }
  traceShape(ctx, skin, cx, cy, w, h);
  ctx.fillStyle = style.fill;
  ctx.fill();
  ctx.shadowBlur = 0;
  if (style.stroke) {
    ctx.strokeStyle = style.stroke;
    ctx.lineWidth = style.strokeWidth ?? 1;
    ctx.stroke();
  }
  ctx.restore();
}

/** A pleasant per-column note colour, consistent across editor and play. */
const COLUMN_COLORS = [
  "#3fb6ff", "#ff5d8f", "#3fb6ff", "#ff5d8f",
  "#5ad469", "#ffc83d", "#b06bff", "#21d4d4",
  "#ff8a3d", "#a1887f",
];

export function columnColor(column: number, keyCount: number): string {
  // For odd key counts, tint the centre column white-ish like many mania skins.
  if (keyCount % 2 === 1 && column === Math.floor(keyCount / 2)) return "#f4f4f8";
  return COLUMN_COLORS[column % COLUMN_COLORS.length];
}
