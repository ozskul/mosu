/**
 * Full-screen, osu!mania-style test-play mode.
 *
 * Unlike the editor view, this is an immersive "play session": the screen
 * transforms into a centred playfield with receptors, a countdown, falling
 * notes in the chosen skin, hit lighting, animated judgements and combo, live
 * accuracy/score, a progress bar, and a results screen at the end — similar to
 * entering Play mode in Roblox Studio. It owns its own canvas, render loop and
 * input, and judges presses against the chart. Press Esc to leave, R to retry.
 */
import { isHold, type Beatmap, type HitObject } from "../types.ts";
import type { AudioEngine } from "../audio/AudioEngine.ts";
import type { Settings } from "../state/settings.ts";
import { drawNoteShape, columnColor, roundRect } from "../render/shapes.ts";
import {
  accuracy,
  codeToLabel,
  defaultKeys,
  emptyStats,
  grade,
  judgementFor,
  MISS_WINDOW,
  type Judgement,
  type PlayStats,
} from "./judge.ts";

type Phase = "countdown" | "playing" | "results";

interface NoteState {
  note: HitObject;
  judged: boolean;
  holding: boolean;
  hitAt?: number; // song time the head was hit (for hold body fade)
}

interface Popup {
  judgement: Judgement;
  born: number; // performance.now
}

interface Explosion {
  column: number;
  born: number;
  judgement: Judgement;
}

const COUNTDOWN_MS = 1600;
const RECEPTOR_FROM_BOTTOM = 140;

const JUDGE_COLORS: Record<Judgement, string> = {
  perfect: "#ffd54f",
  great: "#66e06a",
  good: "#5aa9ff",
  miss: "#ff5572",
};
const JUDGE_TEXT: Record<Judgement, string> = {
  perfect: "PERFECT",
  great: "GREAT",
  good: "GOOD",
  miss: "MISS",
};

export class ManiaPlayer {
  private ctx: CanvasRenderingContext2D;
  private dpr = 1;
  private raf: number | null = null;
  private phase: Phase = "countdown";

  private states: NoteState[] = [];
  private keyMap = new Map<string, number>();
  private heldColumns = new Set<number>();
  private receptorFlash: number[]; // performance.now of last press per column
  private popups: Popup[] = [];
  private explosions: Explosion[] = [];
  private stats: PlayStats = emptyStats();
  private comboPop = 0; // performance.now of last combo change

  private startMs: number;
  private countdownStart = 0;
  private lastNoteTime: number;
  private finishedAt = 0;

  private keyDown: (e: KeyboardEvent) => void;
  private keyUp: (e: KeyboardEvent) => void;

  constructor(
    private canvas: HTMLCanvasElement,
    private beatmap: Beatmap,
    private audio: AudioEngine,
    private settings: Settings,
    private onExit: () => void,
    fromMs = 0,
  ) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D not supported");
    this.ctx = ctx;

    this.startMs = Math.max(0, fromMs);
    this.receptorFlash = new Array(beatmap.difficulty.keyCount).fill(-1);

    defaultKeys(beatmap.difficulty.keyCount).forEach((code, col) =>
      this.keyMap.set(code, col),
    );
    this.states = beatmap.hitObjects
      .filter((n) => (n.endTime ?? n.time) >= this.startMs - 50)
      .map((note) => ({ note, judged: false, holding: false }));
    this.lastNoteTime = this.states.reduce(
      (m, s) => Math.max(m, s.note.endTime ?? s.note.time),
      this.startMs,
    );

    this.keyDown = (e) => this.onKeyDown(e);
    this.keyUp = (e) => this.onKeyUp(e);
  }

  start(): void {
    window.addEventListener("keydown", this.keyDown);
    window.addEventListener("keyup", this.keyUp);
    this.audio.seek(this.startMs);
    this.phase = "countdown";
    this.countdownStart = performance.now();
    this.loop();
  }

  stop(): void {
    window.removeEventListener("keydown", this.keyDown);
    window.removeEventListener("keyup", this.keyUp);
    if (this.raf !== null) cancelAnimationFrame(this.raf);
    this.raf = null;
    this.audio.pause();
  }

  // ---- timing -------------------------------------------------------------

  private songTime(): number {
    if (this.phase === "countdown") {
      const elapsed = performance.now() - this.countdownStart;
      return this.startMs - (COUNTDOWN_MS - elapsed);
    }
    return this.audio.positionMs();
  }

  // ---- input --------------------------------------------------------------

  private onKeyDown(e: KeyboardEvent): void {
    if (e.code === "Escape") {
      e.preventDefault();
      this.onExit();
      return;
    }
    if (e.code === "KeyR") {
      e.preventDefault();
      this.retry();
      return;
    }
    if (this.phase !== "playing") return;
    const col = this.keyMap.get(e.code);
    if (col === undefined || e.repeat) return;
    e.preventDefault();
    this.heldColumns.add(col);
    this.receptorFlash[col] = performance.now();

    const t = this.audio.positionMs();
    let best: NoteState | null = null;
    let bestDiff = Infinity;
    for (const s of this.states) {
      if (s.judged || s.holding || s.note.column !== col) continue;
      const diff = Math.abs(s.note.time - t);
      if (diff < bestDiff && diff <= MISS_WINDOW) {
        best = s;
        bestDiff = diff;
      }
    }
    if (!best) return;
    const j = judgementFor(bestDiff);
    if (j === "miss") {
      best.judged = true;
      this.apply("miss", col);
    } else if (isHold(best.note)) {
      best.holding = true;
      best.hitAt = t;
      this.flash(best.note.column, j);
      if (this.settings.hitsounds) this.audio.playHit(this.settings.hitsoundVolume);
      // Head judged immediately; tail judged on release.
      this.apply(j, col, false);
    } else {
      best.judged = true;
      this.apply(j, col);
    }
  }

  private onKeyUp(e: KeyboardEvent): void {
    const col = this.keyMap.get(e.code);
    if (col === undefined) return;
    this.heldColumns.delete(col);
    if (this.phase !== "playing") return;
    const t = this.audio.positionMs();
    for (const s of this.states) {
      if (s.holding && s.note.column === col) {
        s.holding = false;
        s.judged = true;
        const diff = Math.abs((s.note.endTime ?? s.note.time) - t);
        this.apply(judgementFor(diff), col);
      }
    }
  }

  private apply(j: Judgement, col: number, popAndExplode = true): void {
    this.stats[j]++;
    if (j === "miss") {
      this.stats.combo = 0;
    } else {
      this.stats.combo++;
      this.stats.maxCombo = Math.max(this.stats.maxCombo, this.stats.combo);
    }
    this.comboPop = performance.now();
    if (popAndExplode) {
      this.popups.push({ judgement: j, born: performance.now() });
      if (j !== "miss") this.flash(col, j);
      if (j !== "miss" && this.settings.hitsounds) {
        this.audio.playHit(this.settings.hitsoundVolume);
      }
    }
  }

  private flash(col: number, j: Judgement): void {
    this.explosions.push({ column: col, born: performance.now(), judgement: j });
  }

  private retry(): void {
    this.states.forEach((s) => {
      s.judged = false;
      s.holding = false;
      s.hitAt = undefined;
    });
    this.stats = emptyStats();
    this.popups = [];
    this.explosions = [];
    this.heldColumns.clear();
    this.audio.pause();
    this.audio.seek(this.startMs);
    this.phase = "countdown";
    this.countdownStart = performance.now();
  }

  // ---- update -------------------------------------------------------------

  private update(): void {
    const now = performance.now();
    if (this.phase === "countdown") {
      if (now - this.countdownStart >= COUNTDOWN_MS) {
        this.phase = "playing";
        void this.audio.play();
      }
      return;
    }
    if (this.phase === "playing") {
      const t = this.audio.positionMs();
      // Miss notes that scrolled past the window.
      for (const s of this.states) {
        if (s.judged || s.holding) continue;
        if (t - s.note.time > MISS_WINDOW) {
          s.judged = true;
          this.apply("miss", s.note.column);
        }
      }
      // End of chart (or audio finished).
      if (t >= this.lastNoteTime + 800 || (!this.audio.isPlaying && t >= this.lastNoteTime)) {
        this.phase = "results";
        this.finishedAt = now;
        this.audio.pause();
      }
    }
    // Expire popups/explosions.
    this.popups = this.popups.filter((p) => now - p.born < 500);
    this.explosions = this.explosions.filter((x) => now - x.born < 260);
  }

  // ---- render -------------------------------------------------------------

  private loop = (): void => {
    this.update();
    this.draw();
    this.raf = requestAnimationFrame(this.loop);
  };

  private resize(): { w: number; h: number } {
    const rect = this.canvas.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, Math.floor(rect.width * this.dpr));
    this.canvas.height = Math.max(1, Math.floor(rect.height * this.dpr));
    return { w: rect.width, h: rect.height };
  }

  private draw(): void {
    const { w: W, h: H } = this.resize();
    const ctx = this.ctx;
    ctx.save();
    ctx.scale(this.dpr, this.dpr);

    // Background.
    const bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, "#0a0b12");
    bg.addColorStop(1, "#05060a");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    const keys = this.beatmap.difficulty.keyCount;
    const laneW = Math.max(46, Math.min(86, (Math.min(W * 0.6, 560)) / keys));
    const fieldW = laneW * keys;
    const x0 = (W - fieldW) / 2;
    const receptorY = H - RECEPTOR_FROM_BOTTOM;
    const pxPerMs = this.settings.playScrollSpeed;
    const t = this.songTime();

    this.drawField(ctx, x0, fieldW, laneW, keys, receptorY, H);
    this.drawNotes(ctx, x0, laneW, keys, receptorY, t, pxPerMs, H);
    this.drawReceptors(ctx, x0, laneW, keys, receptorY);
    this.drawExplosions(ctx, x0, laneW, receptorY);
    this.drawHud(ctx, W, H, x0, fieldW, receptorY);

    if (this.phase === "countdown") this.drawCountdown(ctx, W, receptorY);
    if (this.phase === "results") this.drawResults(ctx, W, H);

    ctx.restore();
  }

  private drawField(
    ctx: CanvasRenderingContext2D,
    x0: number,
    fieldW: number,
    laneW: number,
    keys: number,
    receptorY: number,
    H: number,
  ): void {
    // Field panel.
    ctx.fillStyle = "rgba(10,12,20,0.7)";
    ctx.fillRect(x0, 0, fieldW, H);
    // Lane separators + held highlight.
    for (let c = 0; c < keys; c++) {
      const x = x0 + c * laneW;
      if (this.heldColumns.has(c)) {
        const g = ctx.createLinearGradient(0, receptorY - 220, 0, receptorY);
        g.addColorStop(0, "rgba(255,255,255,0)");
        g.addColorStop(1, "rgba(255,255,255,0.10)");
        ctx.fillStyle = g;
        ctx.fillRect(x, 0, laneW, receptorY);
      }
      ctx.strokeStyle = "rgba(255,255,255,0.07)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, H);
      ctx.stroke();
    }
    ctx.strokeStyle = "rgba(255,255,255,0.16)";
    ctx.lineWidth = 2;
    ctx.strokeRect(x0, 0, fieldW, H);
  }

  private drawNotes(
    ctx: CanvasRenderingContext2D,
    x0: number,
    laneW: number,
    keys: number,
    receptorY: number,
    t: number,
    pxPerMs: number,
    H: number,
  ): void {
    const noteH = Math.max(14, laneW * 0.34);
    const timeToY = (time: number) => receptorY - (time - t) * pxPerMs;
    void keys;
    for (const s of this.states) {
      const o = s.note;
      const cx = x0 + o.column * laneW + laneW / 2;
      const color = columnColor(o.column, this.beatmap.difficulty.keyCount);
      const yHead = timeToY(o.time);

      if (isHold(o)) {
        const yTail = timeToY(o.endTime!);
        const top = Math.min(yHead, yTail);
        const bottom = Math.max(yHead, yTail);
        if (bottom < -noteH || top > H + noteH) continue;
        // Clamp the head to the receptor while holding so the body "drains".
        const headY = s.holding ? Math.min(yHead, receptorY) : yHead;
        const bodyTop = Math.min(headY, yTail);
        const bodyBottom = Math.max(headY, yTail);
        ctx.save();
        ctx.globalAlpha = s.judged && !s.holding ? 0.25 : 0.8;
        const bodyW = laneW * 0.5;
        const grad = ctx.createLinearGradient(0, bodyTop, 0, bodyBottom);
        grad.addColorStop(0, color);
        grad.addColorStop(1, shade(color, -0.3));
        ctx.fillStyle = grad;
        roundRect(ctx, cx - bodyW / 2, bodyTop, bodyW, bodyBottom - bodyTop, 6);
        ctx.fill();
        ctx.restore();
        if (!s.judged || s.holding) {
          drawNoteShape(ctx, this.settings.noteSkin, cx, headY, laneW * 0.78, noteH, {
            fill: color,
            stroke: "rgba(0,0,0,0.4)",
            strokeWidth: 1,
            glow: s.holding ? 14 : 0,
          });
          drawNoteShape(ctx, this.settings.noteSkin, cx, yTail, laneW * 0.78, noteH, {
            fill: shade(color, -0.15),
          });
        }
      } else {
        if (s.judged) continue;
        if (yHead < -noteH || yHead > H + noteH) continue;
        drawNoteShape(ctx, this.settings.noteSkin, cx, yHead, laneW * 0.78, noteH, {
          fill: color,
          stroke: "rgba(0,0,0,0.4)",
          strokeWidth: 1,
        });
      }
    }
  }

  private drawReceptors(
    ctx: CanvasRenderingContext2D,
    x0: number,
    laneW: number,
    keys: number,
    receptorY: number,
  ): void {
    const now = performance.now();
    // Judgement line glow.
    ctx.save();
    ctx.shadowColor = "rgba(255,213,79,0.8)";
    ctx.shadowBlur = 16;
    ctx.strokeStyle = "rgba(255,213,79,0.9)";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(x0, receptorY);
    ctx.lineTo(x0 + laneW * keys, receptorY);
    ctx.stroke();
    ctx.restore();

    const h = Math.max(16, laneW * 0.36);
    for (let c = 0; c < keys; c++) {
      const cx = x0 + c * laneW + laneW / 2;
      const pressed = this.heldColumns.has(c);
      const since = now - this.receptorFlash[c];
      const lit = pressed || since < 90;
      const color = columnColor(c, keys);
      ctx.save();
      ctx.globalAlpha = lit ? 0.95 : 0.5;
      if (lit) {
        ctx.shadowColor = color;
        ctx.shadowBlur = 18;
      }
      roundRect(ctx, cx - laneW * 0.4, receptorY - h / 2, laneW * 0.8, h, 6);
      ctx.lineWidth = 3;
      ctx.strokeStyle = color;
      ctx.stroke();
      ctx.globalAlpha = lit ? 0.28 : 0.08;
      ctx.fillStyle = color;
      ctx.fill();
      ctx.restore();

      // Key label.
      ctx.fillStyle = "rgba(255,255,255,0.45)";
      ctx.font = "bold 13px system-ui";
      ctx.textAlign = "center";
      ctx.fillText(this.keyLabel(c), cx, receptorY + h / 2 + 22);
    }
  }

  private drawExplosions(
    ctx: CanvasRenderingContext2D,
    x0: number,
    laneW: number,
    receptorY: number,
  ): void {
    const now = performance.now();
    for (const x of this.explosions) {
      const age = (now - x.born) / 260;
      const cx = x0 + x.column * laneW + laneW / 2;
      const r = laneW * (0.35 + age * 0.5);
      ctx.save();
      ctx.globalAlpha = (1 - age) * 0.7;
      ctx.strokeStyle = JUDGE_COLORS[x.judgement];
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(cx, receptorY, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = (1 - age) * 0.35;
      ctx.fillStyle = JUDGE_COLORS[x.judgement];
      ctx.beginPath();
      ctx.arc(cx, receptorY, laneW * 0.3 * (1 - age), 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  private drawHud(
    ctx: CanvasRenderingContext2D,
    W: number,
    H: number,
    x0: number,
    fieldW: number,
    receptorY: number,
  ): void {
    const now = performance.now();
    // Combo (centre of field, above receptors).
    if (this.stats.combo > 1) {
      const pop = Math.max(0, 1 - (now - this.comboPop) / 120);
      const scale = 1 + pop * 0.25;
      ctx.save();
      ctx.translate(x0 + fieldW / 2, receptorY - 200);
      ctx.scale(scale, scale);
      ctx.fillStyle = "rgba(255,255,255,0.92)";
      ctx.font = "bold 40px system-ui";
      ctx.textAlign = "center";
      ctx.fillText(`${this.stats.combo}`, 0, 0);
      ctx.restore();
    }

    // Judgement popup (latest), centred.
    const pop = this.popups[this.popups.length - 1];
    if (pop) {
      const age = (now - pop.born) / 500;
      ctx.save();
      ctx.globalAlpha = 1 - age;
      const s = 1 + (1 - Math.min(1, age * 4)) * 0.3;
      ctx.translate(x0 + fieldW / 2, receptorY - 150);
      ctx.scale(s, s);
      ctx.fillStyle = JUDGE_COLORS[pop.judgement];
      ctx.font = "bold 26px system-ui";
      ctx.textAlign = "center";
      ctx.fillText(JUDGE_TEXT[pop.judgement], 0, 0);
      ctx.restore();
    }

    // Accuracy + score, top-right.
    const acc = accuracy(this.stats);
    ctx.fillStyle = "rgba(255,255,255,0.9)";
    ctx.font = "bold 22px system-ui";
    ctx.textAlign = "right";
    ctx.fillText(`${(acc * 100).toFixed(2)}%`, W - 24, 36);
    ctx.fillStyle = "rgba(255,255,255,0.5)";
    ctx.font = "13px system-ui";
    ctx.fillText(`max combo ${this.stats.maxCombo}`, W - 24, 56);

    // Title, top-left.
    ctx.textAlign = "left";
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    ctx.font = "bold 16px system-ui";
    const m = this.beatmap.metadata;
    ctx.fillText(`${m.artist || "Unknown"} — ${m.title || "Untitled"}`, 24, 34);
    ctx.fillStyle = "rgba(255,255,255,0.4)";
    ctx.font = "12px system-ui";
    ctx.fillText(`[${m.version || ""}]  ·  Esc to exit  ·  R to retry`, 24, 54);

    // Progress bar (top).
    const dur = this.audio.durationMs || this.lastNoteTime;
    const prog = dur > 0 ? Math.min(1, Math.max(0, this.audio.positionMs() / dur)) : 0;
    ctx.fillStyle = "rgba(255,255,255,0.12)";
    ctx.fillRect(0, 0, W, 4);
    ctx.fillStyle = "#ff66aa";
    ctx.fillRect(0, 0, W * prog, 4);
    void H;
  }

  private drawCountdown(
    ctx: CanvasRenderingContext2D,
    W: number,
    receptorY: number,
  ): void {
    const remaining = COUNTDOWN_MS - (performance.now() - this.countdownStart);
    const secs = Math.ceil(remaining / 533); // ~3,2,1 over the countdown
    const label = secs <= 0 ? "GO" : String(Math.min(3, secs));
    const within = (remaining % 533) / 533; // 1 at start of each tick -> 0
    const scale = 1 + within * 0.5;
    ctx.save();
    ctx.translate(W / 2, receptorY - 200);
    ctx.scale(scale, scale);
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 64px system-ui";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label, 0, 0);
    ctx.restore();
    ctx.textBaseline = "alphabetic";
  }

  private drawResults(ctx: CanvasRenderingContext2D, W: number, H: number): void {
    const fade = Math.min(1, (performance.now() - this.finishedAt) / 300);
    ctx.save();
    ctx.globalAlpha = 0.85 * fade;
    ctx.fillStyle = "#05060a";
    ctx.fillRect(0, 0, W, H);
    ctx.restore();

    const acc = accuracy(this.stats);
    const cx = W / 2;
    let y = H / 2 - 120;
    ctx.textAlign = "center";

    ctx.fillStyle = "#ff66aa";
    ctx.font = "bold 28px system-ui";
    ctx.fillText("Results", cx, y);
    y += 70;

    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 80px system-ui";
    ctx.fillText(grade(acc), cx, y);
    y += 50;

    ctx.font = "bold 30px system-ui";
    ctx.fillText(`${(acc * 100).toFixed(2)}%`, cx, y);
    y += 40;

    ctx.fillStyle = "rgba(255,255,255,0.8)";
    ctx.font = "16px system-ui";
    ctx.fillText(
      `PERFECT ${this.stats.perfect}   GREAT ${this.stats.great}   ` +
        `GOOD ${this.stats.good}   MISS ${this.stats.miss}`,
      cx,
      y,
    );
    y += 28;
    ctx.fillText(`Max combo ${this.stats.maxCombo}`, cx, y);
    y += 50;

    ctx.fillStyle = "rgba(255,255,255,0.55)";
    ctx.font = "14px system-ui";
    ctx.fillText("Press R to retry  ·  Esc to return to the editor", cx, y);
    ctx.textAlign = "left";
  }

  private keyLabel(column: number): string {
    for (const [code, col] of this.keyMap) if (col === column) return codeToLabel(code);
    return "";
  }
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
