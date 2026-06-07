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
  /** Rotation in radians (used by the directional arrow skin). */
  rotation?: number;
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
      // Sized to the lane width so circles read at scale (like osu! notes).
      const r = w * 0.46;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.closePath();
      break;
    }
    case "diamond": {
      const rx = w / 2;
      const ry = Math.max(h, w * 0.6) / 2;
      ctx.beginPath();
      ctx.moveTo(cx, cy - ry);
      ctx.lineTo(cx + rx, cy);
      ctx.lineTo(cx, cy + ry);
      ctx.lineTo(cx - rx, cy);
      ctx.closePath();
      break;
    }
    case "arrow": {
      // An UP-pointing arrow (shaft + head); the caller rotates it per column
      // so each lane shows a real ← ↓ ↑ → direction.
      const aw = w * 0.82;
      const ah = Math.max(h * 1.1, w * 0.82);
      const headH = ah * 0.5;
      const sw = aw * 0.42; // shaft width
      const top = cy - ah / 2;
      const bot = cy + ah / 2;
      const headBaseY = top + headH;
      ctx.beginPath();
      ctx.moveTo(cx, top); // apex
      ctx.lineTo(cx + aw / 2, headBaseY); // head right
      ctx.lineTo(cx + sw / 2, headBaseY);
      ctx.lineTo(cx + sw / 2, bot); // shaft right
      ctx.lineTo(cx - sw / 2, bot); // shaft left
      ctx.lineTo(cx - sw / 2, headBaseY);
      ctx.lineTo(cx - aw / 2, headBaseY); // head left
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
  // For rotated skins (arrows), draw at the origin under a rotation transform.
  const rot = style.rotation ?? 0;
  if (rot) {
    ctx.translate(cx, cy);
    ctx.rotate(rot);
    traceShape(ctx, skin, 0, 0, w, h);
  } else {
    traceShape(ctx, skin, cx, cy, w, h);
  }
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

/**
 * Rotation (radians) for the directional arrow skin per column. 4K reads as the
 * classic ← ↓ ↑ →; other key counts cycle the four directions across columns.
 */
const ARROW_DIRS = [-Math.PI / 2, Math.PI, 0, Math.PI / 2]; // left, down, up, right
export function arrowAngle(column: number): number {
  return ARROW_DIRS[((column % 4) + 4) % 4];
}

/** A pleasant per-column note colour, consistent across editor and play. */
const COLUMN_COLORS = [
  "#3fb6ff", "#ff5d8f", "#3fb6ff", "#ff5d8f",
  "#5ad469", "#ffc83d", "#b06bff", "#21d4d4",
  "#ff8a3d", "#a1887f",
];

/**
 * Draw an image covering the whole (W×H) area, centre-cropped (CSS
 * background-size: cover). No-op if the image hasn't loaded yet.
 */
export function drawCover(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  W: number,
  H: number,
): void {
  if (!img.width || !img.height) return;
  const ir = img.width / img.height;
  const cr = W / H;
  let dw: number;
  let dh: number;
  if (ir > cr) {
    dh = H;
    dw = H * ir;
  } else {
    dw = W;
    dh = W / ir;
  }
  ctx.drawImage(img, (W - dw) / 2, (H - dh) / 2, dw, dh);
}

export function columnColor(column: number, keyCount: number): string {
  // For odd key counts, tint the centre column white-ish like many mania skins.
  if (keyCount % 2 === 1 && column === Math.floor(keyCount / 2)) return "#f4f4f8";
  return COLUMN_COLORS[column % COLUMN_COLORS.length];
}
