/**
 * Minimal 16-bit PCM WAV encoder. Used to export a trimmed clip of the loaded
 * song so a map can start partway through the track in the real osu! client
 * (osu! plays audio from 0:00, so to "start later" the audio must be cut).
 *
 * Operates on anything shaped like an AudioBuffer so it's unit-testable.
 */
import type { AudioLike } from "./onsets.ts";

/** Encode [startSec, endSec) of `buffer` as a stereo/mono 16-bit WAV. */
export function encodeWav(buffer: AudioLike, startSec: number, endSec: number): Uint8Array {
  const sr = buffer.sampleRate;
  const numCh = Math.min(2, Math.max(1, buffer.numberOfChannels));
  const startFrame = clampInt(Math.round(startSec * sr), 0, buffer.length);
  const endFrame = clampInt(Math.round(endSec * sr), startFrame, buffer.length);
  const frames = endFrame - startFrame;

  const blockAlign = numCh * 2;
  const dataSize = frames * blockAlign;
  const out = new ArrayBuffer(44 + dataSize);
  const view = new DataView(out);

  writeString(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(view, 8, "WAVE");
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true); // PCM fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numCh, true);
  view.setUint32(24, sr, true);
  view.setUint32(28, sr * blockAlign, true); // byte rate
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true); // bits per sample
  writeString(view, 36, "data");
  view.setUint32(40, dataSize, true);

  const channels: Float32Array[] = [];
  for (let c = 0; c < numCh; c++) channels.push(buffer.getChannelData(c));

  let offset = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < numCh; c++) {
      const sample = channels[c][startFrame + i] ?? 0;
      const s = Math.max(-1, Math.min(1, sample));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      offset += 2;
    }
  }
  return new Uint8Array(out);
}

function writeString(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
}

function clampInt(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
