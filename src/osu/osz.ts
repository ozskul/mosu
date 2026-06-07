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
 * Create an .osz blob containing one or more difficulties (each a `.osu`) and
 * the shared audio. `audioBytes` should be the raw bytes of the audio file the
 * difficulties reference.
 *
 * Each difficulty is written under a filename that includes its Version, so
 * multiple difficulties land as a single mapset in osu!. If two difficulties
 * share a Version name we de-duplicate the filename so neither is dropped.
 */
export function buildOsz(
  maps: Beatmap[],
  audioBytes: Uint8Array | null,
  extraFiles: Record<string, Uint8Array> = {},
): Blob {
  if (maps.length === 0) throw new Error("No difficulties to export.");
  const files: Record<string, Uint8Array> = {};
  const used = new Set<string>();
  for (const map of maps) {
    let name = osuFileName(map);
    if (used.has(name.toLowerCase())) {
      name = name.replace(/\.osu$/i, ` ~${used.size + 1}.osu`);
    }
    used.add(name.toLowerCase());
    files[name] = strToU8(serializeBeatmap(map));
  }
  if (audioBytes && audioBytes.length > 0) {
    files[maps[0].general.audioFilename] = audioBytes;
  }
  // Background image and any other shared assets.
  for (const [name, bytes] of Object.entries(extraFiles)) {
    if (name && bytes && bytes.length > 0) files[name] = bytes;
  }
  const zipped = zipSync(files, { level: 6 });
  // Copy into a fresh ArrayBuffer so Blob doesn't alias the underlying buffer.
  return new Blob([zipped.slice()], { type: "application/x-osu-archive" });
}

export interface OszContents {
  /** All parsed difficulties, in archive order. */
  beatmaps: Beatmap[];
  audioFilename: string | null;
  audioBytes: Uint8Array | null;
  backgroundFilename: string | null;
  backgroundBytes: Uint8Array | null;
}

/** Read an .osz archive, returning every difficulty and the shared audio. */
export function readOsz(data: Uint8Array): OszContents {
  const entries = unzipSync(data);
  const osuNames = Object.keys(entries).filter((n) =>
    n.toLowerCase().endsWith(".osu"),
  );
  if (osuNames.length === 0) {
    throw new Error("No .osu difficulty found inside the .osz archive.");
  }
  const beatmaps = osuNames.map((n) => parseBeatmap(strFromU8(entries[n])));

  let audioFilename: string | null = null;
  let audioBytes: Uint8Array | null = null;
  const wanted = beatmaps[0].general.audioFilename.toLowerCase();
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

  // Background image (named by the first difficulty, else any image file).
  let backgroundFilename: string | null = null;
  let backgroundBytes: Uint8Array | null = null;
  const bgWanted = beatmaps[0].general.backgroundFilename?.toLowerCase();
  for (const name of Object.keys(entries)) {
    if (bgWanted && name.toLowerCase() === bgWanted) {
      backgroundFilename = name;
      backgroundBytes = entries[name];
      break;
    }
  }
  if (!backgroundBytes) {
    const imgName = Object.keys(entries).find((n) => /\.(jpe?g|png)$/i.test(n));
    if (imgName) {
      backgroundFilename = imgName;
      backgroundBytes = entries[imgName];
    }
  }

  return { beatmaps, audioFilename, audioBytes, backgroundFilename, backgroundBytes };
}

function sanitize(name: string): string {
  // Strip characters illegal on common filesystems.
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "").trim() || "beatmap";
}
