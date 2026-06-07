// @vitest-environment jsdom
//
// Smoke test for the immersive ManiaPlayer. The render/judging code is heavy on
// canvas calls that pure tests can't see; this constructs a player against a
// stubbed canvas + audio and drives a frame + a keypress to catch null derefs,
// bad property access, and judging crashes.
import { describe, it, expect, beforeAll, vi } from "vitest";
import { ManiaPlayer } from "../src/play/ManiaPlayer.ts";
import { createEmptyBeatmap } from "../src/types.ts";
import { DEFAULT_SETTINGS } from "../src/state/settings.ts";

function mockCtx(): CanvasRenderingContext2D {
  const noop = () => {};
  const gradient = { addColorStop: noop };
  return new Proxy({} as any, {
    get(_t, prop) {
      if (prop === "createLinearGradient" || prop === "createRadialGradient") {
        return () => gradient;
      }
      if (prop === "measureText") return () => ({ width: 0 });
      return noop;
    },
    set() {
      return true;
    },
  });
}

beforeAll(() => {
  (HTMLCanvasElement.prototype as any).getContext = () => mockCtx();
  (HTMLCanvasElement.prototype as any).getBoundingClientRect = () =>
    ({ width: 1000, height: 700, left: 0, top: 0, right: 1000, bottom: 700 }) as DOMRect;
  let frames = 0;
  (globalThis as any).requestAnimationFrame = (cb: FrameRequestCallback) => {
    if (frames++ < 1) cb(0);
    return frames;
  };
  (globalThis as any).cancelAnimationFrame = () => {};
  (window as any).devicePixelRatio = 1;
});

function makeAudio() {
  let playing = false;
  return {
    seek: vi.fn(),
    pause: vi.fn(() => {
      playing = false;
    }),
    play: vi.fn(() => {
      playing = true;
      return Promise.resolve();
    }),
    playHit: vi.fn(),
    positionMs: () => 1000,
    get durationMs() {
      return 60000;
    },
    get isPlaying() {
      return playing;
    },
  };
}

describe("ManiaPlayer", () => {
  it("constructs, renders a frame, and judges a keypress without throwing", () => {
    const canvas = document.createElement("canvas");
    const beatmap = createEmptyBeatmap(4);
    beatmap.hitObjects.push(
      { id: 1, column: 0, time: 1000, hitSound: 0 },
      { id: 2, column: 1, time: 1500, hitSound: 0 },
      { id: 3, column: 3, time: 1000, endTime: 2000, hitSound: 0 }, // hold
    );
    const audio = makeAudio();
    const onExit = vi.fn();

    const player = new ManiaPlayer(
      canvas,
      beatmap,
      audio as any,
      DEFAULT_SETTINGS,
      onExit,
      0,
    );

    // start() seeks and renders one (stubbed) frame.
    expect(() => player.start()).not.toThrow();
    expect(audio.seek).toHaveBeenCalled();

    // A column keypress in the bound key for column 0 (4K default: D F J K).
    expect(() =>
      window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyD" })),
    ).not.toThrow();
    expect(() =>
      window.dispatchEvent(new KeyboardEvent("keyup", { code: "KeyD" })),
    ).not.toThrow();

    // Esc triggers the exit callback.
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "Escape" }));
    expect(onExit).toHaveBeenCalled();

    player.stop();
    expect(audio.pause).toHaveBeenCalled();
  });
});
