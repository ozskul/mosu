/**
 * Audio engine built on the Web Audio API.
 *
 * Provides sample-accurate playback position, seeking, variable playback rate,
 * and precomputed waveform peaks for the timeline. AudioBufferSourceNodes are
 * one-shot, so a fresh source is created on every play; position is derived
 * from the AudioContext clock rather than polled from the node.
 */
export type AudioEngineListener = () => void;

export class AudioEngine {
  private ctx: AudioContext;
  private buffer: AudioBuffer | null = null;
  private source: AudioBufferSourceNode | null = null;
  private gain: GainNode;

  private playing = false;
  private rate = 1;
  /** AudioContext time at which playback (conceptually) started. */
  private startCtxTime = 0;
  /** Track offset (seconds) that corresponds to startCtxTime. */
  private startOffset = 0;
  /** Position when paused (seconds). */
  private pausedAt = 0;

  private endListeners = new Set<AudioEngineListener>();
  private rafId: number | null = null;
  private tickListeners = new Set<AudioEngineListener>();

  constructor() {
    this.ctx = new (window.AudioContext ||
      (window as any).webkitAudioContext)();
    this.gain = this.ctx.createGain();
    this.gain.connect(this.ctx.destination);
  }

  get isLoaded(): boolean {
    return this.buffer !== null;
  }

  /** The decoded audio buffer, or null if nothing is loaded. */
  get audioBuffer(): AudioBuffer | null {
    return this.buffer;
  }

  /** The underlying AudioContext (shared for click/hitsound synthesis). */
  get context(): AudioContext {
    return this.ctx;
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  /** Total duration in milliseconds. */
  get durationMs(): number {
    return this.buffer ? this.buffer.duration * 1000 : 0;
  }

  get playbackRate(): number {
    return this.rate;
  }

  /** Decode an audio file (ArrayBuffer) and make it the active track. */
  async load(data: ArrayBuffer): Promise<void> {
    this.stopInternal();
    // decodeAudioData detaches the buffer in some browsers; copy to be safe.
    const copy = data.slice(0);
    this.buffer = await this.ctx.decodeAudioData(copy);
    this.pausedAt = 0;
    this.startOffset = 0;
    this.emitTick();
  }

  /** Current playback position in milliseconds. */
  positionMs(): number {
    if (!this.buffer) return 0;
    let sec: number;
    if (this.playing) {
      sec = this.startOffset + (this.ctx.currentTime - this.startCtxTime) * this.rate;
    } else {
      sec = this.pausedAt;
    }
    return clamp(sec * 1000, 0, this.durationMs);
  }

  setVolume(v: number): void {
    this.gain.gain.value = clamp(v, 0, 1);
  }

  setRate(rate: number): void {
    const wasPlaying = this.playing;
    const pos = this.positionMs();
    this.rate = clamp(rate, 0.25, 2);
    if (wasPlaying) {
      // Restart the source at the new rate from the current position.
      this.seek(pos);
      this.play();
    }
  }

  async play(): Promise<void> {
    if (!this.buffer || this.playing) return;
    if (this.ctx.state === "suspended") await this.ctx.resume();

    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer;
    src.playbackRate.value = this.rate;
    src.connect(this.gain);

    const offsetSec = clamp(this.pausedAt, 0, this.buffer.duration);
    this.startOffset = offsetSec;
    this.startCtxTime = this.ctx.currentTime;
    src.start(0, offsetSec);
    src.onended = () => {
      // onended fires on manual stop too; only react when still "playing".
      if (this.source === src && this.playing) {
        this.playing = false;
        this.pausedAt = this.durationMs / 1000;
        this.source = null;
        this.stopTick();
        this.emitEnded();
      }
    };
    this.source = src;
    this.playing = true;
    this.startTick();
  }

  pause(): void {
    if (!this.playing) return;
    this.pausedAt = this.positionMs() / 1000;
    this.stopInternal();
    this.stopTick();
    this.emitTick();
  }

  toggle(): void {
    if (this.playing) this.pause();
    else void this.play();
  }

  /** Seek to a position in milliseconds, preserving play/pause state. */
  seek(ms: number): void {
    const wasPlaying = this.playing;
    this.stopInternal();
    this.pausedAt = clamp(ms, 0, this.durationMs) / 1000;
    if (wasPlaying) void this.play();
    else this.emitTick();
  }

  /**
   * Compute downsampled waveform peaks (one min/max pair per bucket) for
   * rendering an overview. Returns Float32 arrays of length `buckets`.
   */
  waveformPeaks(buckets: number): { min: Float32Array; max: Float32Array } {
    const min = new Float32Array(buckets);
    const max = new Float32Array(buckets);
    if (!this.buffer) return { min, max };
    const ch = this.buffer.getChannelData(0);
    const per = Math.max(1, Math.floor(ch.length / buckets));
    for (let b = 0; b < buckets; b++) {
      let lo = 1;
      let hi = -1;
      const start = b * per;
      const end = Math.min(ch.length, start + per);
      for (let i = start; i < end; i++) {
        const v = ch[i];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      min[b] = lo;
      max[b] = hi;
    }
    return { min, max };
  }

  /**
   * Play a short metronome click through the shared context. Reusing the main
   * context avoids the per-tick AudioContext churn that browsers throttle.
   */
  playClick(accent: boolean, volume: number): void {
    if (volume <= 0) return;
    const ac = this.ctx;
    if (ac.state === "suspended") void ac.resume();
    const osc = ac.createOscillator();
    const g = ac.createGain();
    osc.frequency.value = accent ? 1600 : 1050;
    g.gain.setValueAtTime(Math.min(1, volume) * 0.4, ac.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + 0.05);
    osc.connect(g);
    g.connect(ac.destination);
    osc.start();
    osc.stop(ac.currentTime + 0.06);
  }

  /**
   * Play a soft percussive hitsound (filtered noise burst) through the shared
   * context. Used by test play for note feedback.
   */
  playHit(volume: number): void {
    if (volume <= 0) return;
    const ac = this.ctx;
    if (ac.state === "suspended") void ac.resume();
    const dur = 0.06;
    const frames = Math.floor(ac.sampleRate * dur);
    const noise = ac.createBuffer(1, frames, ac.sampleRate);
    const data = noise.getChannelData(0);
    for (let i = 0; i < frames; i++) {
      // Decaying white noise for a clicky tick.
      data[i] = (Math.random() * 2 - 1) * (1 - i / frames);
    }
    const src = ac.createBufferSource();
    src.buffer = noise;
    const bp = ac.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 2200;
    bp.Q.value = 0.8;
    const g = ac.createGain();
    g.gain.setValueAtTime(Math.min(1, volume) * 0.5, ac.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + dur);
    src.connect(bp);
    bp.connect(g);
    g.connect(ac.destination);
    src.start();
    src.stop(ac.currentTime + dur);
  }

  onEnded(fn: AudioEngineListener): () => void {
    this.endListeners.add(fn);
    return () => this.endListeners.delete(fn);
  }

  /** Fires roughly every animation frame while context state changes. */
  onTick(fn: AudioEngineListener): () => void {
    this.tickListeners.add(fn);
    return () => this.tickListeners.delete(fn);
  }

  private startTick(): void {
    if (this.rafId !== null) return;
    const loop = () => {
      this.emitTick();
      if (this.playing) this.rafId = requestAnimationFrame(loop);
      else this.rafId = null;
    };
    this.rafId = requestAnimationFrame(loop);
  }

  private stopTick(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  private stopInternal(): void {
    if (this.source) {
      try {
        this.source.onended = null;
        this.source.stop();
      } catch {
        /* already stopped */
      }
      this.source.disconnect();
      this.source = null;
    }
    this.playing = false;
  }

  private emitEnded(): void {
    this.endListeners.forEach((fn) => fn());
  }

  private emitTick(): void {
    this.tickListeners.forEach((fn) => fn());
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
