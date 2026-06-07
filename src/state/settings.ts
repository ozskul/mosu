/**
 * Persisted, editor-wide user preferences (distinct from the beatmap document).
 * These are visual/audio conveniences — note skin, scroll speeds, volumes — and
 * are stored in localStorage so they survive reloads.
 */
export type NoteSkin = "bar" | "circle" | "diamond" | "arrow";

export interface Settings {
  /** Shape used to draw note heads/taps. */
  noteSkin: NoteSkin;
  /** Editor scroll speed (pixels per ms). */
  scrollSpeed: number;
  /** Test-play scroll speed (pixels per ms). */
  playScrollSpeed: number;
  /** Music volume, 0–1. */
  musicVolume: number;
  /** Hitsound volume in test play, 0–1. */
  hitsoundVolume: number;
  /** Metronome click volume, 0–1. */
  metronomeVolume: number;
  /** Whether hitsounds play during test play. */
  hitsounds: boolean;
}

const KEY = "mosu.settings.v1";

export const DEFAULT_SETTINGS: Settings = {
  noteSkin: "bar",
  scrollSpeed: 0.45,
  playScrollSpeed: 0.7,
  musicVolume: 0.8,
  hitsoundVolume: 0.5,
  metronomeVolume: 0.4,
  hitsounds: true,
};

type Listener = (s: Settings) => void;

export class SettingsStore {
  private state: Settings;
  private listeners = new Set<Listener>();

  constructor() {
    this.state = load();
  }

  get(): Settings {
    return this.state;
  }

  set<K extends keyof Settings>(key: K, value: Settings[K]): void {
    this.state = { ...this.state, [key]: value };
    save(this.state);
    this.listeners.forEach((fn) => fn(this.state));
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

function load(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<Settings>) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function save(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* ignore quota / unavailable */
  }
}
