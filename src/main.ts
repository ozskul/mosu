import "./style.css";
import { AudioEngine } from "./audio/AudioEngine.ts";
import { EditorStore } from "./state/EditorStore.ts";
import { PlayfieldRenderer } from "./render/PlayfieldRenderer.ts";
import { Viewport } from "./render/Viewport.ts";
import { ManiaPlayer } from "./play/ManiaPlayer.ts";
import { SettingsStore } from "./state/settings.ts";
import { detectTempo } from "./audio/tempo.ts";
import { detectOnsets } from "./audio/onsets.ts";
import {
  SNAP_DIVISORS,
  snapTime,
  stepTime,
  bpmFromTaps,
  activeBpmPoint,
  beatLengthFromBpm,
  alignOffsetToOnsets,
} from "./timing/timing.ts";
import { serializeBeatmap } from "./osu/serializer.ts";
import { buildOsz, readOsz, osuFileName, oszFileName } from "./osu/osz.ts";
import { parseBeatmap } from "./osu/parser.ts";
import { collectExportIssues, describeIssues } from "./osu/validate.ts";
import { shiftBeatmap } from "./osu/shift.ts";
import { encodeWav } from "./audio/wav.ts";
import {
  computeIntensity,
  intensityAt,
  findDrops,
  type IntensityEnvelope,
} from "./audio/intensity.ts";
import {
  saveDocument,
  loadDocument,
  saveAudio,
  loadAudio,
  saveBackground,
  loadBackground,
  clearBackground,
  saveVideo,
  loadVideo,
  clearVideo,
} from "./state/persistence.ts";
import { isHold, type Beatmap, type HitObject } from "./types.ts";
import {
  syncSharedMetadata,
  blankDifficultyFrom,
  duplicateDifficulty,
  emptySet,
  nextVersionName,
} from "./state/difficulties.ts";
import {
  generateChart,
  recommendedOD,
  DIFFICULTY_LEVELS,
  OD_BY_LEVEL,
  HP_BY_LEVEL,
  type DifficultyLevel,
  type ChartStyle,
} from "./generate/autochart.ts";

// ---------------------------------------------------------------------------
// Globals
// ---------------------------------------------------------------------------
const store = new EditorStore();
const audio = new AudioEngine();
const settings = new SettingsStore();
const vp = new Viewport(settings.get().scrollSpeed, 0);

let audioBytes: Uint8Array | null = null;
// Background media: a still image and/or a video. `bgMedia` is whichever is
// drawn behind the playfield (video wins when present).
let imgBytes: Uint8Array | null = null;
let vidBytes: Uint8Array | null = null;
let vidEl: HTMLVideoElement | null = null;
let imgUrl: string | null = null;
let vidUrl: string | null = null;
let bgMedia: HTMLImageElement | HTMLVideoElement | null = null;
let divisor = 4;
let clipboard: HitObject[] = [];
let metronomeOn = false;
let lastMetronomeBeat = -1;
let player: ManiaPlayer | null = null;
let testStartMs = 0;
/** Detected onset times (ms) and whether to draw them on the chart. */
let onsets: number[] = [];
let showOnsets = false;
let muted = false;
/** Song loudness envelope + detected drops (computed when audio loads). */
let intensityEnv: IntensityEnvelope | null = null;
let drops: number[] = [];
/** Editor-only "map start" position (ms) for test play; null = use playhead. */
let mapStartMs: number | null = null;

// The difficulty set: every difficulty shares the same audio. The store always
// edits `difficulties[activeIndex]`; switching loads a different one.
let difficulties: Beatmap[] = [store.beatmap];
let activeIndex = 0;

const $ = <T extends HTMLElement = HTMLElement>(sel: string): T =>
  document.querySelector(sel) as T;

// Inline SVG icons for the toggling toolbar buttons.
const ICON = {
  play: '<svg class="ico" viewBox="0 0 16 16"><path d="M5 3.2 12.5 8 5 12.8z" fill="currentColor"/></svg>',
  pause: '<svg class="ico" viewBox="0 0 16 16"><rect x="4" y="3.2" width="3" height="9.6" rx="1" fill="currentColor"/><rect x="9" y="3.2" width="3" height="9.6" rx="1" fill="currentColor"/></svg>',
  volOn: '<svg class="ico" viewBox="0 0 16 16"><path d="M3 6h2.5L9 3v10L5.5 10H3z" fill="currentColor"/><path d="M11 5.5a3.5 3.5 0 0 1 0 5M12.7 4a6 6 0 0 1 0 8" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
  volOff: '<svg class="ico" viewBox="0 0 16 16"><path d="M3 6h2.5L9 3v10L5.5 10H3z" fill="currentColor"/><path d="M11 6l4 4M15 6l-4 4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
};

const canvas = $("#playfield") as HTMLCanvasElement;
const overview = $("#overview") as HTMLCanvasElement;
const renderer = new PlayfieldRenderer(canvas);
const overviewCtx = overview.getContext("2d")!;

// ---------------------------------------------------------------------------
// Snap divisor select
// ---------------------------------------------------------------------------
const divisorSel = $("#sel-divisor") as HTMLSelectElement;
for (const d of SNAP_DIVISORS) {
  const opt = document.createElement("option");
  opt.value = String(d);
  opt.textContent = `1/${d}`;
  if (d === 4) opt.selected = true;
  divisorSel.appendChild(opt);
}
divisorSel.addEventListener("change", () => {
  divisor = parseInt(divisorSel.value, 10);
});

// Key count select
const keysSel = $("#diff-keys") as HTMLSelectElement;
for (let k = 1; k <= 10; k++) {
  const opt = document.createElement("option");
  opt.value = String(k);
  opt.textContent = `${k}K`;
  if (k === 4) opt.selected = true;
  keysSel.appendChild(opt);
}

// ---------------------------------------------------------------------------
// Render loop
// ---------------------------------------------------------------------------
function currentTime(): number {
  return audio.positionMs();
}

function frame(): void {
  syncVideo();
  // While the immersive player is up it owns the screen; skip editor rendering
  // but keep the loop alive so the editor resumes cleanly on exit.
  if (player) {
    requestAnimationFrame(frame);
    return;
  }
  // A bad frame must never freeze the editor: catch, log, keep looping.
  try {
    renderer.resize();
    const H = renderer.cssHeight;
    vp.judgeY = H - 90;

    handleMetronome();

    renderer.render(
      {
        beatmap: store.beatmap,
        selection: store.selection,
        currentTime: currentTime(),
        divisor,
        skin: "bar", // the editor always uses bars; the skin setting is test-only
        background: bgMedia,
        onsets: showOnsets ? onsets : null,
        pendingHold: pending?.kind === "hold" ? {
          column: pending.column,
          startTime: pending.startTime,
          endTime: pending.currentTime,
        } : null,
        hoverColumn,
        playMode: false,
      },
      vp,
    );
    drawOverview();
  } catch (err) {
    console.error("[mosu] editor frame error (recovered):", err);
  }
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------------------
// Overview / waveform timeline
// ---------------------------------------------------------------------------
let peaks: { min: Float32Array; max: Float32Array } | null = null;
function rebuildPeaks(): void {
  const w = Math.max(200, Math.floor(overview.getBoundingClientRect().width));
  peaks = audio.isLoaded ? audio.waveformPeaks(w) : null;
}

function drawOverview(): void {
  const dpr = window.devicePixelRatio || 1;
  const rect = overview.getBoundingClientRect();
  overview.width = Math.floor(rect.width * dpr);
  overview.height = Math.floor(rect.height * dpr);
  const ctx = overviewCtx;
  ctx.save();
  ctx.scale(dpr, dpr);
  const W = rect.width;
  const H = rect.height;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = "#11131a";
  ctx.fillRect(0, 0, W, H);

  const dur = audio.durationMs;
  if (peaks && dur > 0) {
    ctx.fillStyle = "#3a4256";
    const n = peaks.min.length;
    for (let i = 0; i < n; i++) {
      const x = (i / n) * W;
      const y0 = H / 2 - (peaks.max[i] * H) / 2;
      const y1 = H / 2 - (peaks.min[i] * H) / 2;
      ctx.fillRect(x, y0, Math.max(1, W / n), Math.max(1, y1 - y0));
    }
    // Note density ticks.
    ctx.fillStyle = "rgba(255,102,170,0.6)";
    for (const o of store.beatmap.hitObjects) {
      const x = (o.time / dur) * W;
      ctx.fillRect(x, H - 4, 1, 4);
    }
    // Detected drops (where the song gets intense).
    ctx.fillStyle = "rgba(178,107,255,0.85)";
    for (const d of drops) {
      const x = (d / dur) * W;
      ctx.fillRect(x - 1, 0, 2, H);
    }
    // Preview-point flag.
    const prev = store.beatmap.general.previewTime;
    if (prev >= 0 && prev <= dur) {
      const x = (prev / dur) * W;
      ctx.fillStyle = "#ff9800";
      ctx.fillRect(x, 0, 2, H);
      ctx.beginPath();
      ctx.moveTo(x + 2, 0);
      ctx.lineTo(x + 10, 4);
      ctx.lineTo(x + 2, 8);
      ctx.closePath();
      ctx.fill();
    }

    // Map-start flag (where Test play begins).
    if (mapStartMs != null && mapStartMs >= 0 && mapStartMs <= dur) {
      const x = (mapStartMs / dur) * W;
      ctx.fillStyle = "#4ad06a";
      ctx.fillRect(x, 0, 2, H);
      ctx.beginPath();
      ctx.moveTo(x, H);
      ctx.lineTo(x + 9, H - 4);
      ctx.lineTo(x, H - 8);
      ctx.closePath();
      ctx.fill();
    }

    // Playhead.
    const px = (currentTime() / dur) * W;
    ctx.strokeStyle = "#ffd54f";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(px, 0);
    ctx.lineTo(px, H);
    ctx.stroke();
  } else {
    ctx.fillStyle = "#444a5a";
    ctx.font = "12px system-ui";
    ctx.fillText("No audio loaded", 10, H / 2);
  }
  ctx.restore();
}

let overviewScrubbing = false;
function overviewSeek(clientX: number): void {
  const rect = overview.getBoundingClientRect();
  const frac = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  audio.seek(frac * audio.durationMs);
}
overview.addEventListener("pointerdown", (e) => {
  if (!audio.isLoaded) return;
  overviewScrubbing = true;
  overview.setPointerCapture(e.pointerId);
  overviewSeek(e.clientX);
});
overview.addEventListener("pointermove", (e) => {
  if (overviewScrubbing) overviewSeek(e.clientX);
});
overview.addEventListener("pointerup", (e) => {
  overviewScrubbing = false;
  try { overview.releasePointerCapture(e.pointerId); } catch { /* noop */ }
});

// ---------------------------------------------------------------------------
// Playfield mouse interaction
// ---------------------------------------------------------------------------
type Pending =
  | { kind: "place"; column: number; startTime: number; currentTime: number; startY: number }
  | { kind: "hold"; column: number; startTime: number; currentTime: number; startY: number }
  | { kind: "move"; lastTime: number; lastColumn: number; moved: boolean }
  | { kind: "resize"; id: number; end: "head" | "tail"; last: number }
  | { kind: "box"; x0: number; y0: number; x1: number; y1: number; base: number[] };

let pending: Pending | null = null;
let hoverColumn: number | null = null;
/** True once a move/resize drag has actually changed something (one undo step). */
let dragBatch = false;
const DRAG_THRESHOLD = 6; // px before a click becomes a hold/drag
const END_GRAB_PX = 13; // distance to a hold's head/tail to grab-resize it

function pointerToCell(e: PointerEvent): { column: number; time: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  const column = renderer.columnAtX(x, rect.width, store.keyCount);
  const rawTime = vp.yToTime(y, currentTime());
  const time = snapTime(store.beatmap.timingPoints, rawTime, divisor);
  return { column, time, y };
}

function noteAtPointer(e: PointerEvent): HitObject | null {
  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  const column = renderer.columnAtX(x, rect.width, store.keyCount);
  const t = currentTime();
  // Match the renderer's note height, plus a little grab tolerance.
  const lw = rect.width / store.keyCount;
  const noteH = Math.max(8, Math.min(18, lw * 0.28)) + 4;
  let hit: HitObject | null = null;
  for (const o of store.beatmap.hitObjects) {
    if (o.column !== column) continue;
    const yHead = vp.timeToY(o.time, t);
    if (isHold(o)) {
      const yTail = vp.timeToY(o.endTime!, t);
      const top = Math.min(yHead, yTail) - noteH / 2;
      const bottom = Math.max(yHead, yTail) + noteH / 2;
      if (y >= top && y <= bottom) hit = o;
    } else if (Math.abs(y - yHead) <= noteH) {
      hit = o;
    }
  }
  return hit;
}

canvas.addEventListener("pointermove", (e) => {
  const rect = canvas.getBoundingClientRect();
  hoverColumn = renderer.columnAtX(e.clientX - rect.left, rect.width, store.keyCount);

  if (!pending) {
    // Cursor affordance: ends of a hold resize, middle/tap moves.
    if (audio.isLoaded && !player) {
      const note = noteAtPointer(e);
      let cursor = "crosshair";
      if (note) {
        cursor = "move";
        if (isHold(note)) {
          const y = e.clientY - rect.top;
          const t = currentTime();
          const dEnd = Math.min(
            Math.abs(y - vp.timeToY(note.time, t)),
            Math.abs(y - vp.timeToY(note.endTime!, t)),
          );
          if (dEnd <= END_GRAB_PX) cursor = "ns-resize";
        }
      }
      canvas.style.cursor = cursor;
    }
    return;
  }
  const cell = pointerToCell(e);
  if (pending.kind === "place") {
    const dy = Math.abs(cell.y - pending.startY);
    if (dy > DRAG_THRESHOLD) {
      pending = { ...pending, kind: "hold", currentTime: cell.time };
    }
  } else if (pending.kind === "hold") {
    pending.currentTime = cell.time;
  } else if (pending.kind === "move") {
    const dt = cell.time - pending.lastTime;
    const dc = cell.column - pending.lastColumn;
    if (dt !== 0 || dc !== 0) {
      if (!dragBatch) { store.beginBatch(); dragBatch = true; }
      store.moveSelection(dt, dc);
      pending.lastTime = cell.time;
      pending.lastColumn = cell.column;
      pending.moved = true;
    }
  } else if (pending.kind === "resize") {
    if (cell.time !== pending.last) {
      if (!dragBatch) { store.beginBatch(); dragBatch = true; }
      store.resizeHoldEnd(pending.id, pending.end, cell.time);
      pending.last = cell.time;
    }
  } else if (pending.kind === "box") {
    pending.x1 = e.clientX - rect.left;
    pending.y1 = e.clientY - rect.top;
    applyBoxSelection(pending);
  }
});

canvas.addEventListener("pointerdown", (e) => {
  if (player || !audio.isLoaded) return;
  canvas.setPointerCapture(e.pointerId);
  const rect = canvas.getBoundingClientRect();
  const cell = pointerToCell(e);
  const hit = noteAtPointer(e);
  const additive = e.ctrlKey || e.metaKey;

  // Ctrl/Cmd + click a note toggles it in/out of the selection.
  if (hit && additive) {
    store.toggleSelect(hit.id!);
    return;
  }

  if (e.shiftKey) {
    // Box select — additive with Ctrl/Cmd held, otherwise replaces.
    pending = {
      kind: "box",
      x0: e.clientX - rect.left,
      y0: e.clientY - rect.top,
      x1: e.clientX - rect.left,
      y1: e.clientY - rect.top,
      base: additive ? [...store.selection] : [],
    };
    if (!additive) store.clearSelection();
    return;
  }

  if (hit) {
    // For a hold, grabbing near an end resizes that end; grabbing the middle
    // (or a tap) moves it.
    const y = e.clientY - rect.top;
    const t = currentTime();
    let end: "head" | "tail" | null = null;
    if (isHold(hit)) {
      const dHead = Math.abs(y - vp.timeToY(hit.time, t));
      const dTail = Math.abs(y - vp.timeToY(hit.endTime!, t));
      if (dHead <= END_GRAB_PX && dHead <= dTail) end = "head";
      else if (dTail <= END_GRAB_PX) end = "tail";
    }
    if (end) {
      store.setSelection([hit.id!]);
      pending = { kind: "resize", id: hit.id!, end, last: NaN };
    } else {
      if (!store.selection.has(hit.id!)) store.setSelection([hit.id!]);
      pending = { kind: "move", lastTime: cell.time, lastColumn: cell.column, moved: false };
    }
    return;
  }

  store.clearSelection();
  pending = {
    kind: "place",
    column: cell.column,
    startTime: cell.time,
    currentTime: cell.time,
    startY: cell.y,
  };
});

canvas.addEventListener("pointerup", (e) => {
  if (!pending) return;
  try { canvas.releasePointerCapture(e.pointerId); } catch { /* noop */ }

  if (pending.kind === "place") {
    store.toggleNote(pending.column, pending.startTime);
  } else if (pending.kind === "hold") {
    store.addHold(pending.column, pending.startTime, pending.currentTime);
  }
  // move/resize/box were applied incrementally; close any open drag batch.
  if (dragBatch) {
    store.endBatch();
    dragBatch = false;
  }
  pending = null;
});

function applyBoxSelection(box: Extract<Pending, { kind: "box" }>): void {
  const rect = canvas.getBoundingClientRect();
  const lw = rect.width / store.keyCount;
  const t = currentTime();
  const xMin = Math.min(box.x0, box.x1);
  const xMax = Math.max(box.x0, box.x1);
  const yMin = Math.min(box.y0, box.y1);
  const yMax = Math.max(box.y0, box.y1);
  const ids = new Set<number>(box.base);
  for (const o of store.beatmap.hitObjects) {
    const cx = o.column * lw + lw / 2;
    if (cx < xMin || cx > xMax) continue;
    const yHead = vp.timeToY(o.time, t);
    const yTail = isHold(o) ? vp.timeToY(o.endTime!, t) : yHead;
    const top = Math.min(yHead, yTail);
    const bottom = Math.max(yHead, yTail);
    if (bottom >= yMin && top <= yMax) ids.add(o.id!);
  }
  store.setSelection(ids);
}

// Mouse wheel scrubbing.
canvas.addEventListener(
  "wheel",
  (e) => {
    if (!audio.isLoaded) return;
    e.preventDefault();
    const dir: 1 | -1 = e.deltaY < 0 ? 1 : -1;
    const next = stepTime(store.beatmap.timingPoints, currentTime(), divisor, dir);
    audio.seek(next);
  },
  { passive: false },
);

// ---------------------------------------------------------------------------
// Keyboard shortcuts
// ---------------------------------------------------------------------------
window.addEventListener("keydown", (e) => {
  if (player) return; // the immersive player handles its own keys (Esc, R, lanes)
  // Ctrl/Cmd+S saves the whole mapset (.osz) — works even while typing in a field.
  if ((e.ctrlKey || e.metaKey) && e.code === "KeyS") {
    e.preventDefault();
    if (audio.isLoaded) downloadOsz();
    return;
  }
  const target = e.target as HTMLElement;
  if (target && (target.tagName === "INPUT" || target.tagName === "SELECT" || target.tagName === "TEXTAREA")) {
    return; // don't hijack form typing
  }

  const ctrl = e.ctrlKey || e.metaKey;
  if (ctrl && e.code === "KeyZ") { e.preventDefault(); store.undo(); return; }
  if (ctrl && (e.code === "KeyY" || (e.shiftKey && e.code === "KeyZ"))) { e.preventDefault(); store.redo(); return; }
  if (ctrl && e.code === "KeyC") { e.preventDefault(); clipboard = store.copySelection(); return; }
  if (ctrl && e.code === "KeyV") { e.preventDefault(); store.paste(clipboard, snapTime(store.beatmap.timingPoints, currentTime(), divisor)); return; }
  if (ctrl && e.code === "KeyA") {
    e.preventDefault();
    store.setSelection(store.beatmap.hitObjects.map((o) => o.id!));
    return;
  }
  if (ctrl && e.code === "KeyD") {
    // Duplicate the selection one beat later.
    e.preventDefault();
    const sel = store.selectedObjects();
    if (sel.length) {
      const base = Math.min(...sel.map((o) => o.time));
      const beat = beatLengthFromBpm(activeBpmPoint(store.beatmap.timingPoints, base).bpm);
      store.paste(store.copySelection(), base + beat);
    }
    return;
  }
  // Alt + arrows nudge the selection (time / column).
  if (e.altKey && store.selection.size > 0 && /^Arrow(Up|Down|Left|Right)$/.test(e.code)) {
    e.preventDefault();
    const sel = store.selectedObjects();
    const base = Math.min(...sel.map((o) => o.time));
    const step = beatLengthFromBpm(activeBpmPoint(store.beatmap.timingPoints, base).bpm) / divisor;
    if (e.code === "ArrowUp") store.moveSelection(step, 0);
    else if (e.code === "ArrowDown") store.moveSelection(-step, 0);
    else if (e.code === "ArrowRight") store.moveSelection(0, 1);
    else if (e.code === "ArrowLeft") store.moveSelection(0, -1);
    return;
  }

  switch (e.code) {
    case "Home":
      e.preventDefault();
      audio.seek(0);
      break;
    case "End":
      e.preventDefault();
      audio.seek(songLength());
      break;
    case "Space":
      e.preventDefault();
      audio.toggle();
      break;
    case "ArrowUp":
      e.preventDefault();
      audio.seek(stepTime(store.beatmap.timingPoints, currentTime(), divisor, 1));
      break;
    case "ArrowDown":
      e.preventDefault();
      audio.seek(stepTime(store.beatmap.timingPoints, currentTime(), divisor, -1));
      break;
    case "Delete":
    case "Backspace":
      e.preventDefault();
      store.deleteSelection();
      break;
    case "KeyM":
      store.mirrorSelection();
      break;
    default:
      // Number keys 1–9 place a note in that column at the playhead.
      if (/^Digit[1-9]$/.test(e.code)) {
        const col = parseInt(e.code.slice(5), 10) - 1;
        if (col < store.keyCount) {
          const t = snapTime(store.beatmap.timingPoints, currentTime(), divisor);
          store.toggleNote(col, t);
        }
      }
      break;
  }
});

// ---------------------------------------------------------------------------
// Metronome
// ---------------------------------------------------------------------------
function handleMetronome(): void {
  if (!metronomeOn || !audio.isPlaying) return;
  const t = currentTime();
  const bpm = activeBpmPoint(store.beatmap.timingPoints, t);
  const beatLen = 60000 / bpm.bpm;
  const beatIndex = Math.floor((t - bpm.time) / beatLen);
  if (beatIndex !== lastMetronomeBeat && beatIndex >= 0) {
    lastMetronomeBeat = beatIndex;
    audio.playClick(beatIndex % bpm.meter === 0, settings.get().metronomeVolume);
  }
}

// ---------------------------------------------------------------------------
// Toolbar wiring
// ---------------------------------------------------------------------------
$("#btn-play").addEventListener("click", () => audio.toggle());
$("#btn-undo").addEventListener("click", () => store.undo());
$("#btn-redo").addEventListener("click", () => store.redo());
$("#btn-test").addEventListener("click", () => (player ? exitTestPlay() : startTestPlay()));
$("#btn-new").addEventListener("click", () => {
  if (store.dirty && !confirm("Discard unsaved changes and start a new beatmap?")) return;
  loadSet(emptySet(4), 0);
  removeBackgroundMedia();
  mapStartMs = null;
  updateStartLabel();
  keysSel.value = "4";
  syncPanels();
});
$("#btn-save-osu").addEventListener("click", () => downloadOsu());
$("#btn-save-osz").addEventListener("click", () => downloadOsz());

const fileInput = $("#file-input") as HTMLInputElement;
$("#btn-open").addEventListener("click", () => fileInput.click());
$("#btn-pick-audio").addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => {
  const f = fileInput.files?.[0];
  if (f) void handleFile(f);
  fileInput.value = "";
});

// ---------------------------------------------------------------------------
// File handling (drag & drop + picker)
// ---------------------------------------------------------------------------
const dropHint = $("#drop-hint");
const stage = $(".stage");
["dragenter", "dragover"].forEach((ev) =>
  stage.addEventListener(ev, (e) => {
    e.preventDefault();
    dropHint.classList.add("drag-over");
    dropHint.hidden = false;
  }),
);
["dragleave", "drop"].forEach((ev) =>
  stage.addEventListener(ev, (e) => {
    e.preventDefault();
    dropHint.classList.remove("drag-over");
    if (ev === "drop") {
      const f = (e as DragEvent).dataTransfer?.files?.[0];
      if (f) void handleFile(f);
    } else if (audio.isLoaded) {
      dropHint.hidden = true;
    }
  }),
);

async function handleFile(file: File): Promise<void> {
  const name = file.name.toLowerCase();
  try {
    if (name.endsWith(".osz")) {
      const buf = new Uint8Array(await file.arrayBuffer());
      const contents = readOsz(buf);
      loadSet(contents.beatmaps, 0);
      mapStartMs = null;
      updateStartLabel();
      if (contents.audioBytes) {
        audioBytes = contents.audioBytes;
        await audio.load(toArrayBuffer(contents.audioBytes));
        await saveAudio(contents.audioBytes);
        rebuildPeaks();
        resetOnsets();
        ensureIntensity();
      }
      removeBackgroundMedia();
      if (contents.backgroundBytes && contents.backgroundFilename) {
        setImage(contents.backgroundBytes, contents.backgroundFilename);
      }
      if (contents.videoBytes && contents.videoFilename) {
        setVideo(contents.videoBytes, contents.videoFilename);
      }
      onLoaded();
    } else if (name.endsWith(".osu")) {
      const text = await file.text();
      loadSet([parseBeatmap(text)], 0);
      mapStartMs = null;
      updateStartLabel();
      onLoaded();
    } else if (isImageFile(file)) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      setImage(bytes, file.name);
      onLoaded(); // keep the drop overlay from lingering over the canvas
    } else if (isVideoFile(file)) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      setVideo(bytes, file.name);
      onLoaded();
    } else {
      // Treat as audio.
      const bytes = new Uint8Array(await file.arrayBuffer());
      audioBytes = bytes;
      store.updateGeneral({ audioFilename: file.name });
      await audio.load(toArrayBuffer(bytes));
      await saveAudio(bytes);
      rebuildPeaks();
      resetOnsets();
      ensureIntensity();
      onLoaded();
    }
  } catch (err) {
    alert(`Could not load "${file.name}": ${(err as Error).message}`);
  }
}

function onLoaded(): void {
  if (audio.isLoaded) dropHint.hidden = true;
  syncPanels();
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------
/** Show export problems and let the user decide. Returns true to proceed. */
function passesExportCheck(maps: Beatmap[]): boolean {
  const issues = collectExportIssues(maps, audioBytes !== null && audioBytes.length > 0);
  if (issues.length === 0) return true;
  const hasBlocking = issues.some((i) => i.blocking);
  const head = hasBlocking
    ? "This map may not play in osu!:"
    : "Heads up:";
  return confirm(`${head}\n\n${describeIssues(issues)}\n\nExport anyway?`);
}

/**
 * When a map-start marker is set (and audio is loaded), exports begin there:
 * the audio is trimmed and every difficulty is shifted to the new 0:00. Keeps a
 * ~2s run-up before the first notes. Returns null when no trim should happen.
 */
function startTrim(): { delta: number; trimFromMs: number; wavName: string } | null {
  if (mapStartMs == null || !audio.audioBuffer) return null;
  const trimFromMs = Math.max(0, mapStartMs - 2000);
  if (trimFromMs <= 0) return null;
  const wavName =
    `${sanitizeName(`${store.beatmap.metadata.artist} - ${store.beatmap.metadata.title}`)} (from start).wav`;
  return { delta: -trimFromMs, trimFromMs, wavName };
}

function downloadOsu(): void {
  // Exports the active difficulty (shifted to the map start if one is set).
  const trim = startTrim();
  const map = trim ? shiftBeatmap(store.beatmap, trim.delta) : store.beatmap;
  if (!passesExportCheck([map])) return;
  const text = serializeBeatmap(map);
  triggerDownload(new Blob([text], { type: "text/plain" }), osuFileName(map));
  store.markSaved();
}

function downloadOsz(): void {
  // Exports the whole set; if a map start is set, trims the audio + shifts.
  commitActive();
  syncSharedMetadata(store.beatmap, difficulties);
  const trim = startTrim();

  let maps = difficulties;
  let audioForZip = audioBytes;
  if (trim && audio.audioBuffer) {
    maps = difficulties.map((d) => {
      const s = shiftBeatmap(d, trim.delta);
      s.general.audioFilename = trim.wavName;
      return s;
    });
    audioForZip = encodeWav(audio.audioBuffer, trim.trimFromMs / 1000, audio.audioBuffer.duration);
  }

  if (!passesExportCheck(maps)) return;
  const extra: Record<string, Uint8Array> = {};
  const bgName = maps[0].general.backgroundFilename;
  if (bgName && imgBytes) extra[bgName] = imgBytes;
  const vidName = maps[0].general.videoFilename;
  if (vidName && vidBytes) extra[vidName] = vidBytes;
  const blob = buildOsz(maps, audioForZip, extra);
  const fname = trim ? oszFileName(maps[0]).replace(/\.osz$/i, " (from start).osz") : oszFileName(maps[0]);
  triggerDownload(blob, fname);
  store.markSaved();
}

function sanitizeName(name: string): string {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "").trim() || "audio";
}

// ---------------------------------------------------------------------------
// Background media (cover image + optional video)
// ---------------------------------------------------------------------------
function setImage(bytes: Uint8Array, filename: string): void {
  imgBytes = bytes;
  store.updateGeneral({ backgroundFilename: filename });
  void saveBackground(bytes);
  refreshMedia();
}

function setVideo(bytes: Uint8Array, filename: string): void {
  vidBytes = bytes;
  store.updateGeneral({ videoFilename: filename });
  void saveVideo(bytes);
  refreshMedia();
}

function removeBackgroundMedia(): void {
  imgBytes = null;
  vidBytes = null;
  store.updateGeneral({ backgroundFilename: undefined, videoFilename: undefined });
  void clearBackground();
  void clearVideo();
  refreshMedia();
}

/** Rebuild media elements/URLs + thumbnail from the current image/video bytes. */
function refreshMedia(): void {
  if (imgUrl) { URL.revokeObjectURL(imgUrl); imgUrl = null; }
  if (vidUrl) { URL.revokeObjectURL(vidUrl); vidUrl = null; }
  vidEl = null;
  bgMedia = null;

  const thumb = $("#bg-thumb") as HTMLImageElement;
  const removeBtn = $("#btn-bg-remove") as HTMLButtonElement;

  if (imgBytes) {
    imgUrl = URL.createObjectURL(new Blob([imgBytes.slice()]));
    const img = new Image();
    img.onload = () => { if (!vidBytes) bgMedia = img; };
    img.src = imgUrl;
    thumb.src = imgUrl;
    thumb.hidden = false;
  } else {
    thumb.removeAttribute("src");
    thumb.hidden = true;
  }

  if (vidBytes) {
    vidUrl = URL.createObjectURL(new Blob([vidBytes.slice()]));
    const v = document.createElement("video");
    v.muted = true;
    v.playsInline = true;
    v.preload = "auto";
    v.src = vidUrl;
    v.addEventListener("loadeddata", () => { vidEl = v; bgMedia = v; });
    vidEl = v;
    bgMedia = v;
  }

  $("#bg-video-label").hidden = !vidBytes;
  removeBtn.hidden = !(imgBytes || vidBytes);
}

/** Keep the background video roughly in sync with audio playback. */
function syncVideo(): void {
  if (bgMedia !== vidEl || !vidEl || !vidEl.duration) return;
  const pos = currentTime() / 1000;
  if (audio.isPlaying && !player) {
    if (vidEl.paused) void vidEl.play().catch(() => {});
    if (Math.abs(vidEl.currentTime - pos) > 0.3) vidEl.currentTime = Math.min(pos, vidEl.duration);
  } else if (player) {
    // Test mode drives its own clock; keep the video tracking audio.
    if (vidEl.paused && audio.isPlaying) void vidEl.play().catch(() => {});
    if (!audio.isPlaying && !vidEl.paused) vidEl.pause();
    if (Math.abs(vidEl.currentTime - pos) > 0.3) vidEl.currentTime = Math.min(pos, vidEl.duration);
  } else {
    if (!vidEl.paused) vidEl.pause();
    vidEl.currentTime = Math.min(pos, vidEl.duration);
  }
}

function isVideoFile(file: File): boolean {
  return file.type.startsWith("video/") || /\.(mp4|webm|mov|m4v)$/i.test(file.name);
}

function isImageFile(file: File): boolean {
  return file.type.startsWith("image/") || /\.(jpe?g|png|gif|webp)$/i.test(file.name);
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------------------------------------------------------------------------
// Immersive test play (osu!mania-style)
// ---------------------------------------------------------------------------
function startTestPlay(): void {
  if (!audio.isLoaded) { alert("Load audio first."); return; }
  if (store.beatmap.hitObjects.length === 0) { alert("Place some notes first."); return; }
  store.clearSelection();
  audio.pause();
  // Begin at the map-start marker if set, otherwise the current playhead.
  testStartMs = mapStartMs != null ? mapStartMs : currentTime();
  const playCanvas = $("#play-canvas") as HTMLCanvasElement;
  $("#play-stage").hidden = false;
  player = new ManiaPlayer(
    playCanvas,
    store.beatmap,
    audio,
    settings.get(),
    exitTestPlay,
    testStartMs,
    bgMedia,
  );
  player.start();
  $("#btn-test").textContent = "Stop";
  $("#btn-test").classList.add("playing");
}

function exitTestPlay(): void {
  if (!player) return;
  player.stop();
  player = null;
  $("#play-stage").hidden = true;
  $("#btn-test").textContent = "▶ Test";
  $("#btn-test").classList.remove("playing");
  audio.seek(testStartMs);
}

// ---------------------------------------------------------------------------
// Difficulty set (multiple difficulties sharing one song)
// ---------------------------------------------------------------------------
/** Keep the array slot pointing at the live edited beatmap. */
function commitActive(): void {
  difficulties[activeIndex] = store.beatmap;
}

function switchDifficulty(index: number): void {
  if (index === activeIndex || index < 0 || index >= difficulties.length) return;
  commitActive();
  // Propagate shared song metadata from the current diff to the rest.
  syncSharedMetadata(store.beatmap, difficulties);
  activeIndex = index;
  store.loadBeatmap(difficulties[index]); // clears history for the new diff
  renderDiffList();
}

function addDifficulty(duplicate: boolean): void {
  commitActive();
  syncSharedMetadata(store.beatmap, difficulties);
  const versions = difficulties.map((d) => d.metadata.version);
  const created = duplicate
    ? duplicateDifficulty(store.beatmap, versions)
    : blankDifficultyFrom(store.beatmap, versions);
  difficulties.push(created);
  activeIndex = difficulties.length - 1;
  store.loadBeatmap(created);
  renderDiffList();
  scheduleSave();
}

function deleteDifficulty(index: number): void {
  if (difficulties.length <= 1) {
    alert("A mapset needs at least one difficulty.");
    return;
  }
  const name = difficulties[index].metadata.version || "Untitled";
  if (!confirm(`Delete difficulty "${name}"? This can't be undone.`)) return;
  commitActive();
  difficulties.splice(index, 1);
  if (activeIndex >= difficulties.length) activeIndex = difficulties.length - 1;
  else if (index < activeIndex) activeIndex -= 1;
  store.loadBeatmap(difficulties[activeIndex]);
  renderDiffList();
  scheduleSave();
}

/** Replace the whole set (import / new / restore). */
function loadSet(diffs: Beatmap[], index = 0): void {
  difficulties = diffs.length ? diffs : emptySet();
  activeIndex = Math.max(0, Math.min(index, difficulties.length - 1));
  store.loadBeatmap(difficulties[activeIndex]);
  renderDiffList();
}

function renderDiffList(): void {
  const list = $("#diff-list");
  list.innerHTML = "";
  difficulties.forEach((d, i) => {
    const row = document.createElement("div");
    row.className = `diff-row${i === activeIndex ? " active" : ""}`;
    const keys = d.difficulty.keyCount;
    const notes = d.hitObjects.length;
    row.innerHTML =
      `<span class="name">${escapeHtml(d.metadata.version || "(unnamed)")}</span>` +
      `<span class="meta">${keys}K · ${notes}</span>` +
      `<button class="rename icon-btn" title="Rename difficulty" aria-label="Rename">` +
        `<svg class="ico" viewBox="0 0 16 16"><path d="M10.5 2.5l3 3L6 13l-3.5.5L3 10z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg></button>` +
      `<button class="del icon-btn" title="Delete difficulty" aria-label="Delete">` +
        `<svg class="ico" viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></button>`;
    const nameEl = row.querySelector(".name") as HTMLElement;
    nameEl.addEventListener("click", () => switchDifficulty(i));
    row.querySelector(".meta")!.addEventListener("click", () => switchDifficulty(i));
    row.querySelector(".rename")!.addEventListener("click", (e) => {
      e.stopPropagation();
      beginRename(nameEl, i, d.metadata.version);
    });
    row.querySelector(".del")!.addEventListener("click", (e) => {
      e.stopPropagation();
      deleteDifficulty(i);
    });
    list.appendChild(row);
  });
}

/** Rename a difficulty's Version. Works for any difficulty, active or not. */
function renameDifficulty(index: number, newName: string): void {
  const name = newName.trim();
  if (!name || difficulties[index]?.metadata.version === name) {
    renderDiffList();
    return;
  }
  if (index === activeIndex) {
    store.updateMetadata({ version: name }); // undoable + syncs the Song tab field
  } else {
    difficulties[index].metadata.version = name;
    scheduleSave();
  }
  renderDiffList();
}

/** Turn a row's name into an inline text input for editing. */
function beginRename(nameEl: HTMLElement, index: number, current: string): void {
  const input = document.createElement("input");
  input.className = "diff-rename";
  input.value = current;
  nameEl.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const commit = (save: boolean) => {
    if (done) return;
    done = true;
    if (save) renameDifficulty(index, input.value);
    else renderDiffList();
  };
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") { e.preventDefault(); commit(true); }
    else if (e.key === "Escape") { e.preventDefault(); commit(false); }
  });
  input.addEventListener("blur", () => commit(true));
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c,
  );
}

// ---------------------------------------------------------------------------
// Side panel binding
// ---------------------------------------------------------------------------
document.querySelectorAll<HTMLButtonElement>(".tabs button").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tabs button").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    const tab = btn.dataset.tab;
    document.querySelectorAll<HTMLElement>(".tab").forEach((t) => {
      t.hidden = t.dataset.tab !== tab;
    });
  });
});

function bindInput(sel: string, get: () => string, set: (v: string) => void): void {
  const el = $(sel) as HTMLInputElement;
  el.addEventListener("input", () => set(el.value));
  (el as any)._sync = () => { el.value = get(); };
}

bindInput("#meta-title", () => store.beatmap.metadata.title, (v) => store.updateMetadata({ title: v }));
bindInput("#meta-artist", () => store.beatmap.metadata.artist, (v) => store.updateMetadata({ artist: v }));
bindInput("#meta-creator", () => store.beatmap.metadata.creator, (v) => store.updateMetadata({ creator: v }));
bindInput("#meta-version", () => store.beatmap.metadata.version, (v) => store.updateMetadata({ version: v }));
bindInput("#meta-source", () => store.beatmap.metadata.source, (v) => store.updateMetadata({ source: v }));
bindInput("#meta-tags", () => store.beatmap.metadata.tags, (v) => store.updateMetadata({ tags: v }));
bindInput("#meta-leadin", () => String(store.beatmap.general.audioLeadIn), (v) => store.updateGeneral({ audioLeadIn: Number(v) || 0 }));
bindInput("#meta-preview", () => String(store.beatmap.general.previewTime), (v) => store.updateGeneral({ previewTime: Number(v) }));
bindInput("#diff-hp", () => String(store.beatmap.difficulty.hp), (v) => store.updateDifficulty({ hp: Number(v) }));
bindInput("#diff-od", () => String(store.beatmap.difficulty.od), (v) => store.updateDifficulty({ od: Number(v) }));

keysSel.addEventListener("change", () => {
  store.updateDifficulty({ keyCount: parseInt(keysSel.value, 10) });
});

// Difficulty manager
$("#btn-diff-add").addEventListener("click", () => addDifficulty(false));
$("#btn-diff-dup").addEventListener("click", () => addDifficulty(true));

// Recommend an OD from the current difficulty's note density.
$("#btn-recommend-od").addEventListener("click", () => {
  const od = recommendedOD(store.beatmap.hitObjects);
  store.updateDifficulty({ od });
});

// Map-start marker (where Test play begins).
function updateStartLabel(): void {
  $("#start-label").textContent = mapStartMs == null ? "— not set" : formatTime(mapStartMs, true);
}
$("#btn-start-set").addEventListener("click", () => {
  mapStartMs = Math.round(currentTime());
  updateStartLabel();
  scheduleSave();
});
$("#btn-start-jump").addEventListener("click", () => {
  if (mapStartMs != null) audio.seek(mapStartMs);
});
$("#btn-start-clear").addEventListener("click", () => {
  mapStartMs = null;
  updateStartLabel();
  scheduleSave();
});

// Preview point ("where the song-select snippet starts") — set without typing.
$("#btn-preview-set").addEventListener("click", () => {
  store.updateGeneral({ previewTime: Math.round(currentTime()) });
});
$("#btn-preview-jump").addEventListener("click", () => {
  const t = store.beatmap.general.previewTime;
  if (t >= 0) audio.seek(t);
});
$("#btn-preview-clear").addEventListener("click", () => {
  store.updateGeneral({ previewTime: -1 });
});

// Background image + video pickers.
const bgInput = $("#bg-input") as HTMLInputElement;
const vidInput = $("#vid-input") as HTMLInputElement;
$("#btn-bg-pick").addEventListener("click", () => bgInput.click());
$("#btn-vid-pick").addEventListener("click", () => vidInput.click());
$("#btn-bg-remove").addEventListener("click", () => removeBackgroundMedia());
bgInput.addEventListener("change", async () => {
  const f = bgInput.files?.[0];
  if (f) setImage(new Uint8Array(await f.arrayBuffer()), f.name);
  bgInput.value = "";
});
vidInput.addEventListener("change", async () => {
  const f = vidInput.files?.[0];
  if (f) setVideo(new Uint8Array(await f.arrayBuffer()), f.name);
  vidInput.value = "";
});

// Timing controls
$("#btn-add-bpm").addEventListener("click", () => {
  const bpm = Number(($("#t-bpm") as HTMLInputElement).value) || 120;
  const offset = Number(($("#t-offset") as HTMLInputElement).value) || 0;
  const meter = Number(($("#t-meter") as HTMLInputElement).value) || 4;
  store.addTimingPoint({
    time: offset,
    uninherited: true,
    bpm,
    sv: 1,
    meter,
    volume: 100,
    sampleSet: 0,
    sampleIndex: 0,
    effects: 0,
  });
});

$("#btn-add-sv").addEventListener("click", () => {
  const sv = Number(($("#t-sv") as HTMLInputElement).value) || 1;
  store.addTimingPoint({
    time: Math.round(currentTime()),
    uninherited: false,
    bpm: 120,
    sv,
    meter: 4,
    volume: 100,
    sampleSet: 0,
    sampleIndex: 0,
    effects: 0,
  });
});

$("#t-metronome").addEventListener("change", (e) => {
  metronomeOn = (e.target as HTMLInputElement).checked;
});

$("#btn-clear").addEventListener("click", () => {
  if (confirm("Remove all notes?")) {
    store.setSelection(store.beatmap.hitObjects.map((o) => o.id!));
    store.deleteSelection();
  }
});

// BPM tap tool
let taps: number[] = [];
let tapTimer: number | null = null;
$("#btn-tap").addEventListener("click", () => {
  const now = performance.now();
  taps.push(now);
  if (taps.length > 8) taps.shift();
  const bpm = bpmFromTaps(taps);
  if (bpm) ($("#t-bpm") as HTMLInputElement).value = bpm.toFixed(2);
  if (tapTimer) clearTimeout(tapTimer);
  tapTimer = window.setTimeout(() => (taps = []), 2000);
});

// ---------------------------------------------------------------------------
// Auto tempo detection
// ---------------------------------------------------------------------------
const detectBtn = $("#btn-detect") as HTMLButtonElement;
const detectStatus = $("#detect-status");
detectBtn.addEventListener("click", async () => {
  const buffer = audio.audioBuffer;
  if (!buffer) { alert("Load audio first."); return; }
  detectBtn.disabled = true;
  detectStatus.hidden = false;
  detectStatus.textContent = "Analysing audio…";
  try {
    const { bpm, offsetMs, confidence } = await detectTempo(buffer);
    ($("#t-bpm") as HTMLInputElement).value = bpm.toFixed(2);
    ($("#t-offset") as HTMLInputElement).value = String(offsetMs);
    const pct = Math.round(confidence * 100);
    detectStatus.textContent =
      `Detected ~${bpm} BPM, offset ${offsetMs} ms (confidence ${pct}%). ` +
      `Tweak if needed, then “Add BPM point”.`;
  } catch (err) {
    detectStatus.textContent = `Detection failed: ${(err as Error).message}`;
  } finally {
    detectBtn.disabled = false;
  }
});

// ---------------------------------------------------------------------------
// Beat (onset) detection — draws every transient on the chart as a guide
// ---------------------------------------------------------------------------
const detectBeatsBtn = $("#btn-detect-beats") as HTMLButtonElement;
const showBeats = $("#show-beats") as HTMLInputElement;
const beatsStatus = $("#beats-status");

detectBeatsBtn.addEventListener("click", () => {
  const buffer = audio.audioBuffer;
  if (!buffer) { alert("Load audio first."); return; }
  detectBeatsBtn.disabled = true;
  beatsStatus.hidden = false;
  beatsStatus.textContent = "Scanning for beats…";
  // Defer so the "Scanning…" text paints before the (synchronous) analysis.
  setTimeout(() => {
    try {
      onsets = detectOnsets(buffer);
      showOnsets = true;
      showBeats.checked = true;
      beatsStatus.textContent =
        `Found ${onsets.length} beats. Teal guides mark where the song hits — ` +
        `line up your offset and notes to them.`;
    } catch (err) {
      beatsStatus.textContent = `Beat detection failed: ${(err as Error).message}`;
    } finally {
      detectBeatsBtn.disabled = false;
    }
  }, 20);
});

showBeats.addEventListener("change", () => {
  showOnsets = showBeats.checked;
  if (showOnsets && onsets.length === 0) {
    // Nothing detected yet — kick off a detection for convenience.
    detectBeatsBtn.click();
  }
});

/** Discard detected onsets (e.g. when a different track is loaded). */
function resetOnsets(): void {
  onsets = [];
  showOnsets = false;
  showBeats.checked = false;
  beatsStatus.hidden = true;
  intensityEnv = null;
  drops = [];
}

/** Compute the loudness envelope + drops for the loaded track (cached). */
function ensureIntensity(): void {
  if (intensityEnv || !audio.audioBuffer) return;
  intensityEnv = computeIntensity(audio.audioBuffer);
  drops = findDrops(intensityEnv);
}

// ---------------------------------------------------------------------------
// Auto-align: set the BPM grid's offset so beat lines land on detected beats
// ---------------------------------------------------------------------------
const alignBtn = $("#btn-align") as HTMLButtonElement;
alignBtn.addEventListener("click", async () => {
  const buffer = audio.audioBuffer;
  if (!buffer) { alert("Load audio first."); return; }
  alignBtn.disabled = true;
  beatsStatus.hidden = false;
  beatsStatus.textContent = "Aligning grid to the beats…";
  try {
    // Make sure we have beats to align to.
    if (onsets.length === 0) onsets = detectOnsets(buffer);
    if (onsets.length === 0) {
      beatsStatus.textContent = "Couldn't find clear beats to align to.";
      return;
    }
    showOnsets = true;
    showBeats.checked = true;

    // Use an existing BPM if there is one; otherwise auto-detect it.
    const reds = store.beatmap.timingPoints
      .map((tp, i) => ({ tp, i }))
      .filter((x) => x.tp.uninherited);
    let bpm: number;
    if (reds.length > 0) {
      bpm = reds[0].tp.bpm;
    } else {
      const r = await detectTempo(buffer);
      bpm = r.bpm;
    }

    const offset = alignOffsetToOnsets(onsets, bpm);
    if (reds.length > 0) {
      store.updateTimingPoint(reds[0].i, { time: offset });
    } else {
      store.addTimingPoint({
        time: offset, uninherited: true, bpm, sv: 1, meter: 4,
        volume: 100, sampleSet: 0, sampleIndex: 0, effects: 0,
      });
    }
    ($("#t-bpm") as HTMLInputElement).value = bpm.toFixed(2);
    ($("#t-offset") as HTMLInputElement).value = String(offset);
    beatsStatus.textContent =
      `Grid aligned: ${bpm.toFixed(2)} BPM, offset ${offset} ms. ` +
      `The white beat lines should now sit on the teal beats.`;
  } catch (err) {
    beatsStatus.textContent = `Align failed: ${(err as Error).message}`;
  } finally {
    alignBtn.disabled = false;
  }
});

// ---------------------------------------------------------------------------
// Auto-map generator
// ---------------------------------------------------------------------------
const genDiffSel = $("#gen-diff") as HTMLSelectElement;
const genStyle = $("#gen-style") as HTMLSelectElement;
const genDensity = $("#gen-density") as HTMLInputElement;
const genDensityVal = $("#gen-density-val");
const genLn = $("#gen-ln") as HTMLInputElement;
const genLnAmt = $("#gen-ln-amt") as HTMLInputElement;
const genLnAmtVal = $("#gen-ln-amt-val");
const genChord = $("#gen-chord") as HTMLInputElement;
const genChordVal = $("#gen-chord-val");
const genFollow = $("#gen-follow") as HTMLInputElement;
const genIntensity = $("#gen-intensity") as HTMLInputElement;
const genIntensityVal = $("#gen-intensity-val");
const genStatus = $("#gen-status");

const renderGenVals = () => {
  genDensityVal.textContent = `${Number(genDensity.value).toFixed(2)}×`;
  genLnAmtVal.textContent = `${Number(genLnAmt.value).toFixed(2)}×`;
  genChordVal.textContent = `${Number(genChord.value).toFixed(2)}×`;
  genIntensityVal.textContent = `${Math.round(Number(genIntensity.value) * 100)}%`;
};
[genDensity, genLnAmt, genChord, genIntensity].forEach((el) =>
  el.addEventListener("input", renderGenVals),
);
renderGenVals();

function genSetStatus(msg: string): void {
  genStatus.hidden = false;
  genStatus.textContent = msg;
}

/** Ensure audio, detected beats, and a BPM timing point exist. */
async function ensureGenPrereqs(): Promise<boolean> {
  const buffer = audio.audioBuffer;
  if (!buffer) { alert("Load audio first."); return false; }
  if (onsets.length === 0) {
    genSetStatus("Scanning for beats…");
    onsets = detectOnsets(buffer);
  }
  if (onsets.length === 0) {
    genSetStatus("Couldn't find clear beats in this audio.");
    return false;
  }
  if (!store.beatmap.timingPoints.some((t) => t.uninherited)) {
    genSetStatus("Detecting tempo…");
    const r = await detectTempo(buffer);
    const offset = alignOffsetToOnsets(onsets, r.bpm);
    store.addTimingPoint({
      time: offset, uninherited: true, bpm: r.bpm, sv: 1, meter: 4,
      volume: 100, sampleSet: 0, sampleIndex: 0, effects: 0,
    });
  }
  return true;
}

function uniqueVersion(base: string): string {
  return nextVersionName(difficulties.map((d) => d.metadata.version), base);
}

function levelLabel(level: DifficultyLevel): string {
  return level.charAt(0).toUpperCase() + level.slice(1);
}

function makeNotes(level: DifficultyLevel) {
  ensureIntensity();
  const follow = genFollow.checked && intensityEnv != null;
  return generateChart(onsets, store.beatmap.timingPoints, {
    keyCount: store.keyCount,
    level,
    density: Number(genDensity.value),
    longNotes: genLn.checked,
    lnAmount: Number(genLnAmt.value),
    chordAmount: Number(genChord.value),
    style: genStyle.value as ChartStyle,
    intensityAt: follow ? (ms) => intensityAt(intensityEnv!, ms) : undefined,
    intensityStrength: Number(genIntensity.value),
    seed: (Math.random() * 0xffffffff) >>> 0,
  });
}

async function generateInto(target: "current" | "new"): Promise<void> {
  if (!(await ensureGenPrereqs())) return;
  const level = genDiffSel.value as DifficultyLevel;
  if (target === "current" && store.beatmap.hitObjects.length > 0) {
    if (!confirm("Replace the notes in this difficulty with a generated chart?")) return;
  }
  const notes = makeNotes(level);
  if (notes.length === 0) { genSetStatus("Generator produced no notes — try a higher density."); return; }
  if (target === "new") {
    addDifficulty(false);
    store.updateMetadata({ version: uniqueVersion(levelLabel(level)) });
  }
  store.replaceNotes(notes);
  store.updateDifficulty({ od: OD_BY_LEVEL[level], hp: HP_BY_LEVEL[level] });
  genSetStatus(`Generated ${notes.length} notes (${levelLabel(level)}, OD ${OD_BY_LEVEL[level]}). Undo (Ctrl+Z) reverts it.`);
}

async function generateSpread(): Promise<void> {
  if (!(await ensureGenPrereqs())) return;
  if (store.dirty && store.beatmap.hitObjects.length > 0 &&
      !confirm("Generate a full Easy→Insane spread? New difficulties will be added.")) return;
  const levels: DifficultyLevel[] = DIFFICULTY_LEVELS.filter((l) => l !== "expert");
  let total = 0;
  for (let i = 0; i < levels.length; i++) {
    const level = levels[i];
    // Reuse the current difficulty if it's empty; otherwise add a new one.
    if (i === 0 && store.beatmap.hitObjects.length === 0) {
      store.updateMetadata({ version: uniqueVersion(levelLabel(level)) });
    } else {
      addDifficulty(false);
      store.updateMetadata({ version: uniqueVersion(levelLabel(level)) });
    }
    const notes = makeNotes(level);
    store.replaceNotes(notes);
    store.updateDifficulty({ od: OD_BY_LEVEL[level], hp: HP_BY_LEVEL[level] });
    total += notes.length;
  }
  renderDiffList();
  genSetStatus(`Generated a ${levels.length}-difficulty spread (${total} notes total).`);
}

$("#btn-generate").addEventListener("click", () => void generateInto("current"));
$("#btn-generate-new").addEventListener("click", () => void generateInto("new"));
$("#btn-generate-spread").addEventListener("click", () => void generateSpread());

// ---------------------------------------------------------------------------
// Style / preferences
// ---------------------------------------------------------------------------
const skinSel = $("#pref-skin") as HTMLSelectElement;
skinSel.addEventListener("change", () => {
  settings.set("noteSkin", skinSel.value as any);
});

function bindVolume(sel: string, valSel: string, key: "musicVolume" | "hitsoundVolume" | "metronomeVolume" | "playScrollSpeed", apply?: (v: number) => void): void {
  const el = $(sel) as HTMLInputElement;
  const val = $(valSel);
  const render = (v: number) => { val.textContent = key === "playScrollSpeed" ? v.toFixed(2) : `${Math.round(v * 100)}%`; };
  el.addEventListener("input", () => {
    const v = Number(el.value);
    settings.set(key, v);
    render(v);
    apply?.(v);
  });
  (el as any)._syncPref = () => { el.value = String(settings.get()[key]); render(settings.get()[key]); };
}

bindVolume("#pref-music", "#val-music", "musicVolume", (v) => {
  if (!muted) audio.setVolume(v);
});

// Mute toggle (toolbar).
const muteBtn = $("#btn-mute") as HTMLButtonElement;
muteBtn.innerHTML = ICON.volOn;
muteBtn.addEventListener("click", () => {
  muted = !muted;
  audio.setVolume(muted ? 0 : settings.get().musicVolume);
  muteBtn.innerHTML = muted ? ICON.volOff : ICON.volOn;
  muteBtn.classList.toggle("danger", muted);
});
bindVolume("#pref-hitsound", "#val-hitsound", "hitsoundVolume");
bindVolume("#pref-metronome", "#val-metronome", "metronomeVolume");
bindVolume("#pref-playscroll", "#val-playscroll", "playScrollSpeed");

const hitsoundsToggle = $("#pref-hitsounds") as HTMLInputElement;
hitsoundsToggle.addEventListener("change", () => {
  settings.set("hitsounds", hitsoundsToggle.checked);
});

function syncPrefs(): void {
  const s = settings.get();
  skinSel.value = s.noteSkin;
  hitsoundsToggle.checked = s.hitsounds;
  document.querySelectorAll<HTMLElement>("[id^='pref-']").forEach((el) => {
    const fn = (el as any)._syncPref;
    if (fn) fn();
  });
}

// ---------------------------------------------------------------------------
// Panel sync on store change
// ---------------------------------------------------------------------------
function syncPanels(): void {
  document.querySelectorAll<HTMLElement>("input, select").forEach((el) => {
    const sync = (el as any)._sync;
    if (sync) sync();
  });
  keysSel.value = String(store.keyCount);
  ($("#diff-keys") as HTMLSelectElement).value = String(store.keyCount);
  $("#stat-notes").textContent = String(store.beatmap.hitObjects.length);
  $("#stat-length").textContent = formatTime(songLength());

  ($("#btn-undo") as HTMLButtonElement).disabled = !store.canUndo;
  ($("#btn-redo") as HTMLButtonElement).disabled = !store.canRedo;
  $("#dirty-flag").hidden = !store.dirty;
  const selCount = store.selection.size;
  const selEl = $("#sel-count");
  selEl.hidden = selCount === 0;
  selEl.textContent = `${selCount} selected`;

  renderTimingList();
  renderDiffList();
}

function songLength(): number {
  const objs = store.beatmap.hitObjects;
  const last = objs.length ? Math.max(...objs.map((o) => o.endTime ?? o.time)) : 0;
  return Math.max(last, audio.durationMs);
}

function renderTimingList(): void {
  const list = $("#timing-list");
  list.innerHTML = "";
  store.beatmap.timingPoints.forEach((tp, i) => {
    const row = document.createElement("div");
    row.className = `tp-row ${tp.uninherited ? "red" : "green"}`;
    const label = tp.uninherited ? `${tp.bpm.toFixed(2)} BPM` : `SV ${tp.sv.toFixed(2)}×`;
    row.innerHTML =
      `<span class="kind">${tp.uninherited ? "BPM" : "SV"}</span>` +
      `<span class="jump">${formatTime(tp.time)} · ${label}</span>` +
      `<button data-del="${i}">✕</button>`;
    row.querySelector(".jump")!.addEventListener("click", () => audio.seek(tp.time));
    row.querySelector("[data-del]")!.addEventListener("click", () => store.removeTimingPoint(i));
    list.appendChild(row);
  });
}

store.subscribe(() => {
  syncPanels();
  scheduleSave();
});

// ---------------------------------------------------------------------------
// Time display
// ---------------------------------------------------------------------------
function tickClock(): void {
  $("#time-cur").textContent = formatTime(currentTime(), true);
  $("#time-tot").textContent = formatTime(audio.durationMs, true);
  requestAnimationFrame(tickClock);
}

function formatTime(ms: number, withMs = false): string {
  const total = Math.max(0, Math.floor(ms));
  const m = Math.floor(total / 60000);
  const s = Math.floor((total % 60000) / 1000);
  const base = `${m}:${String(s).padStart(2, "0")}`;
  return withMs ? `${base}.${String(total % 1000).padStart(3, "0")}` : base;
}

// ---------------------------------------------------------------------------
// Toolbar live controls
// ---------------------------------------------------------------------------
($("#sel-rate") as HTMLSelectElement).addEventListener("change", (e) => {
  audio.setRate(Number((e.target as HTMLSelectElement).value));
});
const scrollRange = $("#rng-scroll") as HTMLInputElement;
scrollRange.value = String(settings.get().scrollSpeed);
scrollRange.addEventListener("input", () => {
  const v = Number(scrollRange.value);
  vp.pxPerMs = v;
  settings.set("scrollSpeed", v);
});
// The play/pause icon tracks the engine, which emits ticks on every state change.
$("#btn-play").innerHTML = ICON.play;
audio.onTick(() => {
  $("#btn-play").innerHTML = audio.isPlaying ? ICON.pause : ICON.play;
});

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------
let saveTimer: number | null = null;
function scheduleSave(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    commitActive();
    saveDocument(difficulties, activeIndex, store.beatmap.general.audioFilename, mapStartMs);
  }, 600);
}

window.addEventListener("beforeunload", (e) => {
  if (store.dirty) {
    e.preventDefault();
    e.returnValue = "";
  }
});

async function restore(): Promise<void> {
  const doc = loadDocument();
  if (doc) {
    loadSet(doc.difficulties, doc.activeIndex);
    mapStartMs = doc.mapStartMs ?? null;
    updateStartLabel();
    const bytes = await loadAudio();
    if (bytes) {
      audioBytes = bytes;
      try {
        await audio.load(toArrayBuffer(bytes));
        rebuildPeaks();
        ensureIntensity();
        dropHint.hidden = true;
      } catch { /* corrupt audio cache */ }
    }
    const bg = await loadBackground();
    if (bg && store.beatmap.general.backgroundFilename) imgBytes = bg;
    const vid = await loadVideo();
    if (vid && store.beatmap.general.videoFilename) vidBytes = vid;
    if (imgBytes || vidBytes) refreshMedia();
  }
  syncPanels();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
audio.setVolume(settings.get().musicVolume);
syncPrefs();
window.addEventListener("resize", rebuildPeaks);
void restore();
requestAnimationFrame(frame);
requestAnimationFrame(tickClock);
