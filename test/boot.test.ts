// @vitest-environment jsdom
//
// Boot smoke test. The unit tests cover pure logic; this one actually imports
// the UI controller (main.ts) against a jsdom DOM with the browser APIs the app
// touches stubbed out, to catch wiring/boot-time crashes (missing elements,
// null contexts, etc.) that pure tests can't see.
import { describe, it, expect, beforeAll, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** A no-op Canvas 2D context covering every method the renderer uses. */
function mockCtx(): CanvasRenderingContext2D {
  const noop = () => {};
  return new Proxy(
    {
      // settable style properties are just stored
      fillStyle: "",
      strokeStyle: "",
      lineWidth: 1,
      globalAlpha: 1,
      font: "",
      textAlign: "",
    } as any,
    {
      get(target, prop) {
        if (prop in target) return target[prop];
        if (prop === "measureText") return () => ({ width: 0 });
        return noop;
      },
      set(target, prop, value) {
        target[prop] = value;
        return true;
      },
    },
  );
}

beforeAll(() => {
  // Inject the real index.html body so every queried element exists.
  const html = readFileSync(resolve(process.cwd(), "index.html"), "utf8");
  const body = html.match(/<body>([\s\S]*)<\/body>/)?.[1] ?? "";
  document.body.innerHTML = body;

  // Stub Web Audio.
  class FakeAudioContext {
    state = "running";
    currentTime = 0;
    destination = {};
    createGain() {
      return { gain: { value: 1 }, connect: () => {} };
    }
    createBufferSource() {
      return { connect: () => {}, start: () => {}, stop: () => {}, playbackRate: { value: 1 } } as any;
    }
    createOscillator() {
      return { connect: () => {}, start: () => {}, stop: () => {}, frequency: { value: 0 }, onended: null } as any;
    }
    resume() {
      return Promise.resolve();
    }
    close() {
      return Promise.resolve();
    }
    decodeAudioData() {
      return Promise.resolve({ duration: 1, getChannelData: () => new Float32Array(16) });
    }
  }
  (globalThis as any).AudioContext = FakeAudioContext;
  (window as any).AudioContext = FakeAudioContext;

  // Canvas 2D.
  (HTMLCanvasElement.prototype as any).getContext = () => mockCtx();
  (HTMLCanvasElement.prototype as any).getBoundingClientRect = () =>
    ({ width: 800, height: 600, left: 0, top: 0, right: 800, bottom: 600 }) as DOMRect;

  // rAF: run the first frame once, then stop (no infinite recursion in tests).
  let frames = 0;
  (globalThis as any).requestAnimationFrame = (cb: FrameRequestCallback) => {
    if (frames++ < 2) cb(0);
    return frames;
  };
  (globalThis as any).cancelAnimationFrame = () => {};
  (window as any).devicePixelRatio = 1;
});

describe("app boot", () => {
  it("imports main.ts and wires the UI without throwing", async () => {
    const err = vi.fn();
    window.addEventListener("error", err);

    await expect(import("../src/main.ts")).resolves.toBeDefined();
    // Give the async restore()/microtasks a chance to run.
    await new Promise((r) => setTimeout(r, 0));

    // Snap divisor select got populated from SNAP_DIVISORS.
    const divisorSel = document.querySelector("#sel-divisor") as HTMLSelectElement;
    expect(divisorSel.options.length).toBeGreaterThan(0);

    // Key-count select got populated.
    const keysSel = document.querySelector("#diff-keys") as HTMLSelectElement;
    expect(keysSel.options.length).toBe(10);

    // A core control exists and the dirty flag starts hidden (clean doc).
    expect(document.querySelector("#btn-save-osz")).not.toBeNull();
    expect((document.querySelector("#dirty-flag") as HTMLElement).hidden).toBe(true);

    expect(err).not.toHaveBeenCalled();
  });
});
