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
  alignOffsetToOnsets,
} from "./timing/timing.ts";
import { serializeBeatmap } from "./osu/serializer.ts";
import { buildOsz, readOsz, osuFileName, oszFileName } from "./osu/osz.ts";
import { parseBeatmap } from "./osu/parser.ts";
import {
  saveDocument,
  loadDocument,
  saveAudio,
  loadAudio,
} from "./state/persistence.ts";
import { createEmptyBeatmap, isHold, type HitObject } from "./types.ts";

// ---------------------------------------------------------------------------
// Globals
// ---------------------------------------------------------------------------
const store = new EditorStore();
const audio = new AudioEngine();
const settings = new SettingsStore();
const vp = new Viewport(settings.get().scrollSpeed, 0);

let audioBytes: Uint8Array | null = null;
let divisor = 4;
let clipboard: HitObject[] = [];
let metronomeOn = false;
let lastMetronomeBeat = -1;
let player: ManiaPlayer | null = null;
let testStartMs = 0;
/** Detected onset times (ms) and whether to draw them on the chart. */
let onsets: number[] = [];
let showOnsets = false;

const $ = <T extends HTMLElement = HTMLElement>(sel: string): T =>
  document.querySelector(sel) as T;

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
  // While the immersive player is up it owns the screen; skip editor rendering
  // but keep the loop alive so the editor resumes cleanly on exit.
  if (player) {
    requestAnimationFrame(frame);
    return;
  }
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
      skin: settings.get().noteSkin,
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

overview.addEventListener("pointerdown", (e) => {
  if (!audio.isLoaded) return;
  const rect = overview.getBoundingClientRect();
  const frac = (e.clientX - rect.left) / rect.width;
  audio.seek(frac * audio.durationMs);
});

// ---------------------------------------------------------------------------
// Playfield mouse interaction
// ---------------------------------------------------------------------------
type Pending =
  | { kind: "place"; column: number; startTime: number; currentTime: number; startY: number }
  | { kind: "hold"; column: number; startTime: number; currentTime: number; startY: number }
  | { kind: "move"; lastTime: number; lastColumn: number; moved: boolean }
  | { kind: "resize"; id: number; end: "head" | "tail"; last: number }
  | { kind: "box"; x0: number; y0: number; x1: number; y1: number };

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

  if (e.shiftKey) {
    // Box select.
    pending = {
      kind: "box",
      x0: e.clientX - rect.left,
      y0: e.clientY - rect.top,
      x1: e.clientX - rect.left,
      y1: e.clientY - rect.top,
    };
    store.clearSelection();
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
  const ids: number[] = [];
  for (const o of store.beatmap.hitObjects) {
    const cx = o.column * lw + lw / 2;
    if (cx < xMin || cx > xMax) continue;
    const yHead = vp.timeToY(o.time, t);
    const yTail = isHold(o) ? vp.timeToY(o.endTime!, t) : yHead;
    const top = Math.min(yHead, yTail);
    const bottom = Math.max(yHead, yTail);
    if (bottom >= yMin && top <= yMax) ids.push(o.id!);
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

  switch (e.code) {
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
  store.loadBeatmap(createEmptyBeatmap(4));
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
      store.loadBeatmap(contents.beatmap);
      if (contents.audioBytes) {
        audioBytes = contents.audioBytes;
        await audio.load(toArrayBuffer(contents.audioBytes));
        await saveAudio(contents.audioBytes);
        rebuildPeaks();
        resetOnsets();
      }
      onLoaded();
    } else if (name.endsWith(".osu")) {
      const text = await file.text();
      store.loadBeatmap(parseBeatmap(text));
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
function downloadOsu(): void {
  const text = serializeBeatmap(store.beatmap);
  triggerDownload(new Blob([text], { type: "text/plain" }), osuFileName(store.beatmap));
  store.markSaved();
}

function downloadOsz(): void {
  const blob = buildOsz(store.beatmap, audioBytes);
  triggerDownload(blob, oszFileName(store.beatmap));
  store.markSaved();
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
  testStartMs = currentTime();
  const playCanvas = $("#play-canvas") as HTMLCanvasElement;
  $("#play-stage").hidden = false;
  player = new ManiaPlayer(
    playCanvas,
    store.beatmap,
    audio,
    settings.get(),
    exitTestPlay,
    testStartMs,
  );
  player.start();
  $("#btn-test").textContent = "■ Stop";
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

bindVolume("#pref-music", "#val-music", "musicVolume", (v) => audio.setVolume(v));
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

  renderTimingList();
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
audio.onTick(() => {
  $("#btn-play").textContent = audio.isPlaying ? "⏸" : "▶";
});

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------
let saveTimer: number | null = null;
function scheduleSave(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    saveDocument(store.beatmap, store.beatmap.general.audioFilename);
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
    store.loadBeatmap(doc.beatmap);
    const bytes = await loadAudio();
    if (bytes) {
      audioBytes = bytes;
      try {
        await audio.load(toArrayBuffer(bytes));
        rebuildPeaks();
        dropHint.hidden = true;
      } catch { /* corrupt audio cache */ }
    }
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
