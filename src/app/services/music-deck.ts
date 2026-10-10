import { MusicManifest } from './music.service';
import { batchCount, batchUrl } from '../utils/music-seg-batch';

/** Seconds of audio to keep buffered ahead of the playhead. */
const BUFFER_AHEAD = 40;
/** Seconds of already-played audio kept for seeking back before it is trimmed. */
const BUFFER_BEHIND = 20;
/** What a standby deck buffers before the switch (init + the first ~10 s). */
export const PREPARE_AHEAD = 10;
/** Give up on a MediaSource that never opens (element reused, tab frozen). */
const SOURCE_OPEN_TIMEOUT = 15000;

/** The browser can't decode this rendition in MSE. */
export class UnsupportedError extends Error {}

export function mediaSourceCtor(): typeof MediaSource | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { MediaSource?: typeof MediaSource; ManagedMediaSource?: typeof MediaSource };
  return w.MediaSource ?? w.ManagedMediaSource ?? null;
}

/** Whether a manifest's audio can play here (progressive files always can). */
export function canPlayManifest(m: MusicManifest): boolean {
  if (m.kind === 'file') return true;
  const MS = mediaSourceCtor();
  return !!MS && MS.isTypeSupported(`audio/mp4; codecs="${m.codec}"`);
}

export interface DeckLoadOptions {
  /** Seconds to start from (restored position, quality retry). */
  startAt?: number;
}

/**
 * One audio element plus the Media Source Extensions pipeline that feeds it.
 * The player keeps two: the active deck and a standby deck that preloads the
 * next track (gapless, crossfade).
 *
 * TIDAL serves lossless as fragmented-MP4 FLAC (DASH). We drive MSE directly -
 * append the init segment, then each segment, keeping ~40 s buffered - because
 * dash.js rejects the `flac` codec string even where the browser decodes it.
 * Browsers without FLAC-in-MSE (or without MSE) get the AAC rendition instead.
 *
 * Every load bumps `seq`; a running segment loop compares against it (and the
 * caller's `isCurrent`) after each await and bows out when stale.
 */
export class MusicDeck {
  readonly el: HTMLAudioElement;
  /** Track this deck holds, or null when empty. */
  trackId: number | null = null;
  manifest: MusicManifest | null = null;
  /** Init appended (segments) / source set (file): the element can play. */
  ready = false;
  /** Background pipeline failures of the current load (segment fetch, append). */
  onError: ((e: unknown) => void) | null = null;

  private seq = 0;
  private ahead = BUFFER_AHEAD;
  private objectUrl: string | null = null;
  private loopDone = false;

  constructor(el: HTMLAudioElement) {
    this.el = el;
    el.preload = 'auto';
  }

  /**
   * Loads `m` and resolves once the element can play (init segment appended,
   * start position applied). Segments keep streaming in the background.
   */
  async load(m: MusicManifest, trackId: number, isCurrent: () => boolean, opts: DeckLoadOptions = {}): Promise<void> {
    this.ahead = BUFFER_AHEAD;
    await this.open(m, trackId, isCurrent, opts.startAt ?? 0);
  }

  /** Buffers the start of `m` (~10 s) without playing; resolves when that much is in (or it gave up). */
  async prepare(m: MusicManifest, trackId: number): Promise<boolean> {
    this.ahead = PREPARE_AHEAD;
    const seq = await this.open(m, trackId, () => true, 0);
    return this.whenBuffered(seq, PREPARE_AHEAD, 20000);
  }

  /** A prepared deck becomes the active one: buffer the full window from now on. */
  promote(): void {
    this.ahead = BUFFER_AHEAD;
  }

  /** Stops the pipeline and releases the element. */
  dispose(): void {
    this.seq++;
    this.trackId = null;
    this.manifest = null;
    this.ready = false;
    try {
      this.el.pause();
      if (this.el.hasAttribute('src')) {
        this.el.removeAttribute('src');
        this.el.load();
      }
    } catch {
      // a fake element in tests, or one already torn down
    }
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = null;
  }

  /** Seconds buffered ahead of the playhead. */
  bufferedAhead(): number {
    const a = this.el;
    for (let k = 0; k < a.buffered.length; k++) {
      if (a.buffered.start(k) <= a.currentTime + 0.5 && a.buffered.end(k) >= a.currentTime) {
        return a.buffered.end(k) - a.currentTime;
      }
    }
    return 0;
  }

  // ── internals ────────────────────────────────────────────────────────────

  private async open(m: MusicManifest, trackId: number, isCurrent: () => boolean, startAt: number): Promise<number> {
    this.dispose();
    const seq = this.seq;
    const alive = () => seq === this.seq && isCurrent();
    this.trackId = trackId;
    this.manifest = m;
    this.loopDone = false;
    const a = this.el;

    if (m.kind === 'file') {
      a.src = m.url!;
      if (startAt > 0) {
        a.addEventListener('loadedmetadata', () => { if (alive()) a.currentTime = startAt; }, { once: true });
      }
      this.ready = true;
      this.loopDone = true;
      return seq;
    }

    const MS = mediaSourceCtor();
    const mime = `audio/mp4; codecs="${m.codec}"`;
    if (!MS || !MS.isTypeSupported(mime)) throw new UnsupportedError();

    const durations = m.durations ?? [];
    const total = durations.reduce((s, d) => s + d, 0);
    const ms = new MS();
    // Safari's ManagedMediaSource only opens when AirPlay is off or offered an alternative.
    if ((window as unknown as { ManagedMediaSource?: unknown }).ManagedMediaSource === MS) {
      (a as HTMLAudioElement & { disableRemotePlayback: boolean }).disableRemotePlayback = true;
    }
    this.objectUrl = URL.createObjectURL(ms);
    a.src = this.objectUrl;
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('sourceopen timeout')), SOURCE_OPEN_TIMEOUT);
      ms.addEventListener('sourceopen', () => { clearTimeout(t); resolve(); }, { once: true });
    });
    if (!alive()) return seq;

    const sb = ms.addSourceBuffer(mime);
    if (total) ms.duration = total;

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
    if (!alive()) return seq;

    // Where segment n starts, for mapping a seek (or a restored position) to a segment.
    const starts: number[] = [];
    durations.reduce((t, d) => { starts.push(t); return t + d; }, 0);
    const segmentAt = (t: number) => {
      let k = starts.findIndex((s, idx) => s <= t && t < s + durations[idx]);
      if (k < 0) k = durations.length - 1;
      return k + 1;
    };
    let cursor = 1;
    /** Requests since start / last seek: drives the 1 -> 4 -> 8 batch ramp. */
    let step = 0;
    if (startAt > 0 && durations.length) {
      cursor = segmentAt(startAt);
      a.currentTime = startAt;
    }
    this.ready = true;

    const onSeeking = () => {
      const t = a.currentTime;
      const buffered = Array.from({ length: a.buffered.length }, (_, k) => [a.buffered.start(k), a.buffered.end(k)]);
      if (!buffered.some(([s, e]) => s <= t && e > t)) {
        cursor = segmentAt(t);
        step = 0;
      }
    };
    a.addEventListener('seeking', onSeeking);

    // The feeding loop runs on in the background; load() returns now.
    void (async () => {
      try {
        while (alive() && cursor <= durations.length) {
          if (this.bufferedAhead() > this.ahead) {
            await new Promise((r) => setTimeout(r, 500));
            continue;
          }
          if (a.buffered.length && a.buffered.start(0) < a.currentTime - BUFFER_BEHIND - 10) {
            const done = whenIdle();
            sb.remove(0, a.currentTime - BUFFER_BEHIND);
            await done;
          }
          const n = cursor;
          // A standby deck only needs ~10 s: two small batches, not a full window.
          const c = batchCount(step++, n, durations.length, this.ahead <= PREPARE_AHEAD ? 2 : undefined);
          cursor += c;
          const buf = await fetchBuf(batchUrl(m.media!, n, c));
          if (!alive()) break;
          await append(buf);
        }
        if (alive() && cursor > durations.length && ms.readyState === 'open') ms.endOfStream();
      } catch (e) {
        if (alive()) this.onError?.(e);
      } finally {
        a.removeEventListener('seeking', onSeeking);
        if (seq === this.seq) this.loopDone = true;
      }
    })();
    return seq;
  }

  private async whenBuffered(seq: number, seconds: number, timeout: number): Promise<boolean> {
    const t0 = Date.now();
    while (seq === this.seq && Date.now() - t0 < timeout) {
      if (this.bufferedAhead() >= seconds - 0.5 || this.loopDone) return seq === this.seq && this.ready;
      await new Promise((r) => setTimeout(r, 200));
    }
    return false;
  }
}
