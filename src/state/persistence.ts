/**
 * Local persistence. The beatmap document (JSON) lives in localStorage; the
 * decoded audio is too large for that, so its raw bytes are stored separately
 * in IndexedDB. On load we restore both so a refresh resumes exactly where you
 * left off.
 */
import type { Beatmap } from "../types.ts";

const DOC_KEY = "mosu.document.v1";
const DB_NAME = "mosu";
const STORE = "audio";
const AUDIO_KEY = "current";
const BG_KEY = "background";

export interface PersistedDoc {
  /** All difficulties in the set. */
  difficulties: Beatmap[];
  /** Index of the difficulty that was being edited. */
  activeIndex: number;
  audioFilename: string | null;
  /** Editor-only "map start" marker (ms) for test play; null if unset. */
  mapStartMs?: number | null;
  savedAt: number;
  /** Legacy single-difficulty field (older saves). */
  beatmap?: Beatmap;
}

export function saveDocument(
  difficulties: Beatmap[],
  activeIndex: number,
  audioFilename: string | null,
  mapStartMs: number | null = null,
): void {
  const doc: PersistedDoc = {
    difficulties,
    activeIndex,
    audioFilename,
    mapStartMs,
    savedAt: Date.now(),
  };
  try {
    localStorage.setItem(DOC_KEY, JSON.stringify(doc));
  } catch {
    // localStorage may be full or unavailable; ignore.
  }
}

export function loadDocument(): PersistedDoc | null {
  try {
    const raw = localStorage.getItem(DOC_KEY);
    if (!raw) return null;
    const doc = JSON.parse(raw) as PersistedDoc;
    // Migrate older single-difficulty saves.
    if (!doc.difficulties && doc.beatmap) {
      return {
        difficulties: [doc.beatmap],
        activeIndex: 0,
        audioFilename: doc.audioFilename ?? null,
        savedAt: doc.savedAt ?? Date.now(),
      };
    }
    if (!Array.isArray(doc.difficulties) || doc.difficulties.length === 0) {
      return null;
    }
    doc.activeIndex = Math.max(0, Math.min(doc.activeIndex ?? 0, doc.difficulties.length - 1));
    return doc;
  } catch {
    return null;
  }
}

export function clearDocument(): void {
  try {
    localStorage.removeItem(DOC_KEY);
  } catch {
    /* ignore */
  }
  void clearAudio();
}

// ---- audio (IndexedDB) ----------------------------------------------------

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function putBlob(key: string, bytes: Uint8Array): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      // Store a fresh copy so the buffer isn't detached elsewhere.
      tx.objectStore(STORE).put(bytes.slice(), key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    /* IndexedDB unavailable; just won't persist */
  }
}

async function getBlob(key: string): Promise<Uint8Array | null> {
  try {
    const db = await openDb();
    const result = await new Promise<Uint8Array | null>((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(key);
      req.onsuccess = () => resolve((req.result as Uint8Array) ?? null);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return result;
  } catch {
    return null;
  }
}

export const saveAudio = (bytes: Uint8Array) => putBlob(AUDIO_KEY, bytes);
export const loadAudio = () => getBlob(AUDIO_KEY);
export const saveBackground = (bytes: Uint8Array) => putBlob(BG_KEY, bytes);
export const loadBackground = () => getBlob(BG_KEY);

async function deleteBlob(key: string): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
    db.close();
  } catch {
    /* ignore */
  }
}

export const clearAudio = () => deleteBlob(AUDIO_KEY);
export const clearBackground = () => deleteBlob(BG_KEY);
