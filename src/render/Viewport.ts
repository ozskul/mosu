/**
 * Maps between time (ms) and vertical screen position for the scrolling
 * playfield. osu!mania notes fall from the top toward a judgement line near the
 * bottom: a note at the current playhead time sits exactly on the judgement
 * line, future notes are above it, past notes are below.
 */
export class Viewport {
  /** Pixels travelled per millisecond of song time (scroll speed). */
  pxPerMs: number;
  /** y of the judgement line. */
  judgeY: number;

  constructor(pxPerMs = 0.4, judgeY = 0) {
    this.pxPerMs = pxPerMs;
    this.judgeY = judgeY;
  }

  /** Screen y for a given time, relative to the current playhead time. */
  timeToY(time: number, currentTime: number): number {
    return this.judgeY - (time - currentTime) * this.pxPerMs;
  }

  /** Inverse of timeToY: the song time at a given screen y. */
  yToTime(y: number, currentTime: number): number {
    return currentTime + (this.judgeY - y) / this.pxPerMs;
  }

  /** Visible time window [topTime, bottomTime] for a canvas of `height`. */
  visibleRange(currentTime: number, height: number): [number, number] {
    const top = this.yToTime(0, currentTime);
    const bottom = this.yToTime(height, currentTime);
    return [bottom, top];
  }
}
