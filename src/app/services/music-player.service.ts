import { HttpErrorResponse } from '@angular/common/http';
import { computed, inject, Injectable, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { MusicManifest, MusicService, MusicTrack } from './music.service';

/** Seconds of audio to keep buffered ahead of the playhead. */
const BUFFER_AHEAD = 40;
/** Seconds of already-played audio kept for seeking back before it is trimmed. */
const BUFFER_BEHIND = 20;

/** Why playback stopped working, in words the bar can show. */
export type MusicError = 'session_expired' | 'unavailable' | 'unsupported' | 'network';

/**
 * App-wide music player. Lives in the root injector so playback survives route
 * changes; the mini player bar and the pages only read its signals.
 *
 * Playback: TIDAL serves lossless as fragmented-MP4 FLAC (DASH). We drive
 * Media Source Extensions directly - append the init segment, then each
 * segment, keeping ~40 s buffered - because dash.js rejects the `flac` codec
 * string even where the browser decodes it. Browsers without FLAC-in-MSE (or
 * without MSE) get the AAC rendition instead.
 */
@Injectable({ providedIn: 'root' })
export class MusicPlayerService {
  private music = inject(MusicService);
  private audio = typeof Audio !== 'undefined' ? new Audio() : null;

  readonly queue = signal<MusicTrack[]>([]);
  readonly index = signal(-1);
  readonly track = computed(() => this.queue()[this.index()] ?? null);
  readonly playing = signal(false);
  readonly loading = signal(false);
  readonly error = signal<MusicError | null>(null);
  readonly position = signal(0);
  readonly duration = signal(0);
  /** FULL or PREVIEW for the current track once its manifest is in. */
  readonly presentation = signal<MusicManifest['presentation'] | null>(null);
  readonly quality = signal('');
  readonly hasNext = computed(() => this.index() < this.queue().length - 1);
  readonly hasPrev = computed(() => this.index() > 0);

  /** Bumped on every track change; stale async work compares against it and bows out. */
  private generation = 0;

  constructor() {
    const a = this.audio;
    if (!a) return;
    a.preload = 'auto';
    a.addEventListener('playing', () => { this.playing.set(true); this.loading.set(false); });
    a.addEventListener('pause', () => this.playing.set(false));
    a.addEventListener('waiting', () => { if (!a.paused) this.loading.set(true); });
    a.addEventListener('timeupdate', () => this.position.set(a.currentTime));
    a.addEventListener('ended', () => (this.hasNext() ? this.next() : this.playing.set(false)));
    a.addEventListener('error', () => {
      if (a.src) this.fail('unavailable');
    });
    this.bindMediaSession();
  }

  /** Play `track`, optionally as part of a list so next/previous work. */
  async play(track: MusicTrack, queue: MusicTrack[] = [track]): Promise<void> {
    const i = queue.findIndex((t) => t.id === track.id);
    this.queue.set(i >= 0 ? queue : [track]);
    await this.start(i >= 0 ? i : 0);
  }

  toggle(): void {
    const a = this.audio;
    if (!a || !this.track()) return;
    if (a.paused) a.play().catch(() => undefined);
    else a.pause();
  }

  next(): void {
    if (this.hasNext()) void this.start(this.index() + 1);
  }

  prev(): void {
    // Like every player: restart the track first, go back only near its start.
    if (this.position() > 3 || !this.hasPrev()) this.seek(0);
    else void this.start(this.index() - 1);
  }

  seek(seconds: number): void {
    if (this.audio && this.track()) this.audio.currentTime = Math.max(0, seconds);
  }

  stop(): void {
    this.generation++;
    this.audio?.pause();
    if (this.audio) this.audio.removeAttribute('src');
    this.queue.set([]);
    this.index.set(-1);
    this.playing.set(false);
    this.loading.set(false);
    this.error.set(null);
    this.position.set(0);
    this.duration.set(0);
    this.presentation.set(null);
  }

  private async start(i: number): Promise<void> {
    const a = this.audio;
    const track = this.queue()[i];
    if (!a || !track) return;
    const gen = ++this.generation;
    this.index.set(i);
    this.error.set(null);
    this.loading.set(true);
    this.playing.set(false);
    this.position.set(0);
    this.duration.set(track.duration);
    this.presentation.set(null);
    a.pause();
    this.updateMediaSession(track);

    try {
      const manifest = await firstValueFrom(this.music.manifest(track.id, this.pickQuality()));
      if (gen !== this.generation) return;
      this.presentation.set(manifest.presentation);
      this.quality.set(manifest.quality);

      if (manifest.kind === 'file') {
        a.src = manifest.url!;
        await a.play().catch(() => undefined);
        return;
      }
      await this.playSegments(manifest, gen);
    } catch (e) {
      if (gen !== this.generation) return;
      this.fail(this.classify(e));
    }
  }

  private async playSegments(m: MusicManifest, gen: number): Promise<void> {
    const a = this.audio!;
    const MS = this.mediaSourceCtor();
    const mime = `audio/mp4; codecs="${m.codec}"`;
    if (!MS || !MS.isTypeSupported(mime)) throw new UnsupportedError();

    const durations = m.durations ?? [];
    const total = durations.reduce((s, d) => s + d, 0);
    const ms = new MS();
    a.src = URL.createObjectURL(ms);
    await new Promise<void>((r) => ms.addEventListener('sourceopen', () => r(), { once: true }));
    if (gen !== this.generation) return;

    const sb = ms.addSourceBuffer(mime);
    if (total) { ms.duration = total; this.duration.set(total); }

    const whenIdle = () => new Promise<void>((r) => sb.addEventListener('updateend', () => r(), { once: true }));
    const append = (buf: ArrayBuffer) => {
      const done = whenIdle();
      sb.appendBuffer(buf);
      return done;
    };
    const fetchBuf = async (url: string) => {
      const r = await fetch(url);
      if (!r.ok) throw new Error('segment ' + r.status);
      return r.arrayBuffer();
    };

    await append(await fetchBuf(m.init!));
    if (gen !== this.generation) return;
    a.play().catch(() => undefined);

    // Where segment n starts, for mapping a seek back to a segment.
    const starts: number[] = [];
    durations.reduce((t, d) => { starts.push(t); return t + d; }, 0);
    let cursor = 1;
    const onSeeking = () => {
      const t = a.currentTime;
      const buffered = Array.from({ length: a.buffered.length }, (_, k) => [a.buffered.start(k), a.buffered.end(k)]);
      if (!buffered.some(([s, e]) => s <= t && e > t)) {
        let k = starts.findIndex((s, idx) => s <= t && t < s + durations[idx]);
        if (k < 0) k = durations.length - 1;
        cursor = k + 1;
      }
    };
    a.addEventListener('seeking', onSeeking);

    const aheadOf = () => {
      for (let k = 0; k < a.buffered.length; k++) {
        if (a.buffered.start(k) <= a.currentTime + 0.5 && a.buffered.end(k) >= a.currentTime) {
          return a.buffered.end(k) - a.currentTime;
        }
      }
      return 0;
    };

    try {
      while (gen === this.generation && cursor <= durations.length) {
        if (aheadOf() > BUFFER_AHEAD) {
          await new Promise((r) => setTimeout(r, 500));
          continue;
        }
        if (a.buffered.length && a.buffered.start(0) < a.currentTime - BUFFER_BEHIND - 10) {
          const done = whenIdle();
          sb.remove(0, a.currentTime - BUFFER_BEHIND);
          await done;
        }
        const n = cursor++;
        await append(await fetchBuf(`${m.media}&n=${n}`));
      }
      if (gen === this.generation && cursor > durations.length && ms.readyState === 'open') ms.endOfStream();
    } catch (e) {
      if (gen === this.generation) this.fail(this.classify(e));
    } finally {
      a.removeEventListener('seeking', onSeeking);
    }
  }

  /** FLAC where the browser can decode it in MSE, otherwise AAC 320. */
  private pickQuality(): 'LOSSLESS' | 'HIGH' {
    const MS = this.mediaSourceCtor();
    return MS && MS.isTypeSupported('audio/mp4; codecs="flac"') ? 'LOSSLESS' : 'HIGH';
  }

  private mediaSourceCtor(): typeof MediaSource | null {
    const w = window as unknown as { MediaSource?: typeof MediaSource; ManagedMediaSource?: typeof MediaSource };
    return w.MediaSource ?? w.ManagedMediaSource ?? null;
  }

  private classify(e: unknown): MusicError {
    if (e instanceof UnsupportedError) return 'unsupported';
    if (e instanceof HttpErrorResponse) {
      if (e.status === 401) return 'session_expired';
      if (e.status === 0) return 'network';
    }
    return 'unavailable';
  }

  private fail(e: MusicError): void {
    this.error.set(e);
    this.loading.set(false);
    this.playing.set(false);
  }

  // ── Lock screen / media keys ──────────────────────────────────────────────

  private updateMediaSession(t: MusicTrack): void {
    if (!('mediaSession' in navigator)) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: t.title,
      artist: t.artist,
      album: t.album,
      artwork: t.cover ? [{ src: t.cover, sizes: '320x320', type: 'image/jpeg' }] : [],
    });
  }

  private bindMediaSession(): void {
    if (!('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    ms.setActionHandler('play', () => this.toggle());
    ms.setActionHandler('pause', () => this.toggle());
    ms.setActionHandler('previoustrack', () => this.prev());
    ms.setActionHandler('nexttrack', () => this.next());
    ms.setActionHandler('seekto', (d) => { if (d.seekTime !== undefined) this.seek(d.seekTime); });
  }
}

class UnsupportedError extends Error {}
