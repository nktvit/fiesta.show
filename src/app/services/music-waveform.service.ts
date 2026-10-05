import { Injectable, Signal, WritableSignal, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import {
  WAVEFORM_BUCKETS, computePeaks, getSilenceBoundaries, lruEvictions,
} from '../utils/music-waveform-peaks';
import { MusicManifest, MusicService, MusicTrack } from './music.service';
import { MusicSettingsService } from './music-settings.service';

const DB_NAME = 'fiesta-music-waveform';
const STORE = 'peaks';
const MAX_ENTRIES = 300;
/** Skip decoding anything bigger than this (the LOW rendition is normally 1-4 MB). */
const MAX_BYTES = 15 * 1024 * 1024;

interface PeakRecord {
  id: number;
  peaks: Float32Array;
  /** Seconds of audio that were decoded. */
  duration: number;
  at: number;
}

/**
 * Waveform peaks and silence bounds per track. Peaks are computed only when
 * settings.waveformSeekbar() or settings.removeSilence() is on, by decoding the
 * LOW quality rendition once, and cached in IndexedDB `fiesta-music-waveform`
 * (LRU 300). Anything that fails (no decode support, big file, offline) gives
 * up silently: no peaks, no bounds.
 */
@Injectable({ providedIn: 'root' })
export class MusicWaveformService {
  private readonly music = inject(MusicService);
  private readonly settings = inject(MusicSettingsService);

  private readonly signals = new Map<number, WritableSignal<Float32Array | null>>();
  private readonly boundsCache = new Map<number, { start: number; end: number }>();
  private readonly inFlight = new Map<number, AbortController>();
  private readonly failed = new Set<number>();
  private dbPromise: Promise<IDBDatabase | null> | null = null;

  /** Normalised peaks for the seek bar, or null until computed. */
  peaks(trackId: number): Signal<Float32Array | null> {
    return this.sig(trackId).asReadonly();
  }

  /** Starts computing peaks/bounds for `track` (no-op unless a waveform setting is on). */
  request(track: MusicTrack): void {
    if (!this.settings.waveformSeekbar() && !this.settings.removeSilence()) return;
    const id = track.id;
    if (this.sig(id)() || this.inFlight.has(id) || this.failed.has(id)) return;
    // Only the track being played is worth the bandwidth: drop other pending jobs.
    for (const [other, ac] of this.inFlight) {
      if (other !== id) {
        ac.abort();
        this.inFlight.delete(other);
      }
    }
    const ac = new AbortController();
    this.inFlight.set(id, ac);
    void this.load(track, ac).finally(() => {
      if (this.inFlight.get(id) === ac) this.inFlight.delete(id);
    });
  }

  /** Seconds of non-silent audio, from cache only (synchronous), or null. */
  bounds(trackId: number): { start: number; end: number } | null {
    return this.boundsCache.get(trackId) ?? null;
  }

  // ── internals ────────────────────────────────────────────────────────────

  private sig(id: number): WritableSignal<Float32Array | null> {
    let s = this.signals.get(id);
    if (!s) {
      s = signal<Float32Array | null>(null);
      this.signals.set(id, s);
      // Bound the in-memory map (a session can play thousands of tracks).
      if (this.signals.size > 60) {
        for (const k of [...this.signals.keys()]) {
          if (k !== id && this.signals.size > 40) {
            this.signals.delete(k);
            this.boundsCache.delete(k);
          }
        }
      }
    }
    return s;
  }

  private publish(id: number, peaks: Float32Array, duration: number): void {
    const b = getSilenceBoundaries(peaks, duration);
    this.boundsCache.set(id, { start: b.leadingSilenceSeconds, end: b.trailingSilenceStartTime });
    this.sig(id).set(peaks);
  }

  private async load(track: MusicTrack, ac: AbortController): Promise<void> {
    const id = track.id;
    try {
      const cached = await this.dbGet(id);
      if (ac.signal.aborted) return;
      if (cached) {
        this.publish(id, cached.peaks, cached.duration);
        void this.dbTouch(cached);
        return;
      }
      const m = await firstValueFrom(this.music.manifest(id, 'LOW'));
      if (ac.signal.aborted) return;
      const bytes = await this.fetchAudio(m, ac.signal);
      if (ac.signal.aborted) return;
      if (!bytes) {
        this.failed.add(id);
        return;
      }
      const buf = await decode(bytes);
      if (ac.signal.aborted) return;
      if (!buf) {
        this.failed.add(id);
        return;
      }
      const channels: Float32Array[] = [];
      for (let c = 0; c < Math.min(2, buf.numberOfChannels); c++) channels.push(buf.getChannelData(c));
      const peaks = computePeaks(channels, WAVEFORM_BUCKETS);
      this.publish(id, peaks, buf.duration);
      void this.dbPut({ id, peaks, duration: buf.duration, at: Date.now() });
    } catch {
      if (!ac.signal.aborted) this.failed.add(id);
    }
  }

  /** The whole LOW rendition as one buffer (init + segments for DASH), or null when too big. */
  private async fetchAudio(m: MusicManifest, signal: AbortSignal): Promise<ArrayBuffer | null> {
    if (m.kind === 'file') {
      if (!m.url) return null;
      return this.fetchLimited([m.url], signal);
    }
    if (!m.init || !m.media || !m.durations?.length) return null;
    const urls = [m.init, ...m.durations.map((_, i) => `${m.media}&n=${i + 1}`)];
    return this.fetchLimited(urls, signal);
  }

  private async fetchLimited(urls: string[], signal: AbortSignal): Promise<ArrayBuffer | null> {
    const parts: Uint8Array[] = [];
    let total = 0;
    for (const url of urls) {
      const r = await fetch(url, { signal });
      if (!r.ok) return null;
      const len = Number(r.headers.get('content-length') || 0);
      if (len && total + len > MAX_BYTES) return null;
      const b = new Uint8Array(await r.arrayBuffer());
      total += b.byteLength;
      if (total > MAX_BYTES) return null;
      parts.push(b);
    }
    const out = new Uint8Array(total);
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.byteLength;
    }
    return out.buffer;
  }

  // ── IndexedDB (fiesta-music-waveform) ────────────────────────────────────

  private db(): Promise<IDBDatabase | null> {
    if (this.dbPromise) return this.dbPromise;
    this.dbPromise = new Promise((resolve) => {
      try {
        if (typeof indexedDB === 'undefined') return resolve(null);
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
        req.onblocked = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
    return this.dbPromise;
  }

  private async tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | null> {
    const db = await this.db();
    if (!db) return null;
    return new Promise<T | null>((resolve) => {
      try {
        const t = db.transaction(STORE, mode);
        const r = fn(t.objectStore(STORE));
        t.oncomplete = () => resolve(r ? (r.result as T) : null);
        t.onerror = () => resolve(null);
        t.onabort = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }

  private async dbGet(id: number): Promise<PeakRecord | null> {
    const r = await this.tx<PeakRecord | undefined>('readonly', (s) => s.get(id));
    return r && r.peaks instanceof Float32Array ? r : null;
  }

  private async dbTouch(rec: PeakRecord): Promise<void> {
    await this.tx('readwrite', (s) => s.put({ ...rec, at: Date.now() }));
  }

  private async dbPut(rec: PeakRecord): Promise<void> {
    await this.tx('readwrite', (s) => s.put(rec));
    const all = await this.tx<PeakRecord[]>('readonly', (s) => s.getAll());
    const drop = lruEvictions((all ?? []).map((r) => ({ key: r.id, at: r.at })), MAX_ENTRIES);
    if (drop.length) {
      await this.tx('readwrite', (s) => {
        for (const k of drop) s.delete(k);
      });
    }
  }
}

/** decodeAudioData on a throwaway context; null when the browser can't decode it. */
async function decode(bytes: ArrayBuffer): Promise<AudioBuffer | null> {
  const w = window as unknown as {
    OfflineAudioContext?: typeof OfflineAudioContext;
    webkitOfflineAudioContext?: typeof OfflineAudioContext;
  };
  const Ctor = w.OfflineAudioContext ?? w.webkitOfflineAudioContext;
  if (!Ctor) return null;
  try {
    return await new Ctor(1, 1, 44100).decodeAudioData(bytes);
  } catch {
    return null;
  }
}
