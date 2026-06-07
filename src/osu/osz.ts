/**
 * Pack/unpack `.osz` archives. An .osz is just a ZIP containing one or more
 * `.osu` difficulty files plus the shared audio (and optionally hitsounds and a
 * background image). We use fflate for synchronous, dependency-light zipping in
 * the browser.
 */
import { zipSync, unzipSync, strToU8, strFromU8 } from "fflate";
import type { Beatmap } from "../types.ts";
import { serializeBeatmap } from "./serializer.ts";
import { parseBeatmap } from "./parser.ts";

/** Build a filename like "Artist - Title (Creator) [Version].osu". */
export function osuFileName(map: Beatmap): string {
  const m = map.metadata;
  const base = `${m.artist} - ${m.title} (${m.creator}) [${m.version}]`;
  return `${sanitize(base)}.osu`;
}

export function oszFileName(map: Beatmap): string {
  const m = map.metadata;
  return `${sanitize(`${m.artist} - ${m.title}`)}.osz`;
}

/**
 * Create an .osz blob containing the given beatmap and its audio.
 * `audioBytes` should be the raw bytes of the audio file referenced by
 * `map.general.audioFilename`.
 */
export function buildOsz(map: Beatmap, audioBytes: Uint8Array | null): Blob {
  const files: Record<string, Uint8Array> = {};
  files[osuFileName(map)] = strToU8(serializeBeatmap(map));
  if (audioBytes && audioBytes.length > 0) {
    files[map.general.audioFilename] = audioBytes;
  }
  const zipped = zipSync(files, { level: 6 });
  // Copy into a fresh ArrayBuffer so Blob doesn't alias the underlying buffer.
  return new Blob([zipped.slice()], { type: "application/x-osu-archive" });
}

export interface OszContents {
  /** The first parsed difficulty (the editor is single-difficulty for now). */
  beatmap: Beatmap;
  audioFilename: string | null;
  audioBytes: Uint8Array | null;
}

/** Read an .osz archive, returning the first difficulty and its audio. */
export function readOsz(data: Uint8Array): OszContents {
  const entries = unzipSync(data);
  const osuName = Object.keys(entries).find((n) => n.toLowerCase().endsWith(".osu"));
  if (!osuName) {
    throw new Error("No .osu difficulty found inside the .osz archive.");
  }
  const beatmap = parseBeatmap(strFromU8(entries[osuName]));

  let audioFilename: string | null = null;
  let audioBytes: Uint8Array | null = null;
  const wanted = beatmap.general.audioFilename.toLowerCase();
  for (const name of Object.keys(entries)) {
    if (name.toLowerCase() === wanted) {
      audioFilename = name;
      audioBytes = entries[name];
      break;
    }
  }
  // Fallback: any audio-looking file.
  if (!audioBytes) {
    const audioName = Object.keys(entries).find((n) =>
      /\.(mp3|ogg|wav)$/i.test(n),
    );
    if (audioName) {
      audioFilename = audioName;
      audioBytes = entries[audioName];
    }
  }

  return { beatmap, audioFilename, audioBytes };
}

function sanitize(name: string): string {
  // Strip characters illegal on common filesystems.
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "").trim() || "beatmap";
}
