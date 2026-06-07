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

export interface PersistedDoc {
  beatmap: Beatmap;
  audioFilename: string | null;
  savedAt: number;
}

export function saveDocument(
  beatmap: Beatmap,
  audioFilename: string | null,
): void {
  const doc: PersistedDoc = { beatmap, audioFilename, savedAt: Date.now() };
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
    return JSON.parse(raw) as PersistedDoc;
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

export async function saveAudio(bytes: Uint8Array): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      // Store a fresh copy so the buffer isn't detached elsewhere.
      tx.objectStore(STORE).put(bytes.slice(), AUDIO_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    /* IndexedDB unavailable; audio just won't persist */
  }
}

export async function loadAudio(): Promise<Uint8Array | null> {
  try {
    const db = await openDb();
    const result = await new Promise<Uint8Array | null>((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(AUDIO_KEY);
      req.onsuccess = () => resolve((req.result as Uint8Array) ?? null);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return result;
  } catch {
    return null;
  }
}

export async function clearAudio(): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(AUDIO_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
    db.close();
  } catch {
    /* ignore */
  }
}
