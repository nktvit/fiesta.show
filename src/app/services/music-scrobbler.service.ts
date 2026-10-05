import { Injectable, NgZone, computed, inject, signal } from '@angular/core';
import { MusicLibraryService } from './music-library.service';
import { MusicPlayerService } from './music-player.service';
import {
  PlayClock, SCROBBLE_SERVICES, ScrobbleMeta, ScrobbleQueueItem, ScrobbleServiceId, enqueue, scrobbleMeta, scrobbleThreshold,
} from './music-scrobble-core';
import {
  ScrobbleCreds, ScrobbleError, audioscrobblerSubmit, listenBrainzLove, listenBrainzSubmit, malojaScrobble,
} from './music-scrobble-providers';
import { MusicSettingsService } from './music-settings.service';
import { MusicToastService } from './music-toast.service';
import { MusicTrack } from './music.service';

export interface ScrobbleConfig {
  enabled: Record<ScrobbleServiceId, boolean>;
  /** Love a track on every enabled service when it is liked in the library. */
  loveOnLike: boolean;
}

export const SCROBBLE_SERVICE_NAMES: Record<ScrobbleServiceId, string> = {
  listenbrainz: 'ListenBrainz',
  maloja: 'Maloja',
  librefm: 'Libre.fm',
  lastfm: 'Last.fm',
};

const DEFAULT_CONFIG: ScrobbleConfig = {
  enabled: { listenbrainz: false, maloja: false, librefm: false, lastfm: false },
  loveOnLike: false,
};
const MAX_TRIES = 20;

interface Run {
  track: MusicTrack;
  meta: ScrobbleMeta;
  /** Epoch seconds the track started. */
  startedAt: number;
  clock: PlayClock;
  scrobbled: boolean;
}

/**
 * Scrobbling to ListenBrainz / Maloja / Libre.fm / Last.fm. Driven by the player
 * event bus; counts played seconds (not wall clock), sends playing_now at track
 * start, one scrobble past the threshold, and queues failures for a retry.
 * Credentials and the queue live under fiesta:music:secret:*.
 */
@Injectable({ providedIn: 'root' })
export class MusicScrobblerService {
  private readonly player = inject(MusicPlayerService);
  private readonly library = inject(MusicLibraryService);
  private readonly settings = inject(MusicSettingsService);
  private readonly toast = inject(MusicToastService);
  private readonly zone = inject(NgZone);

  /** Per-service switches (persisted, not secret). */
  readonly config = this.settings.scoped<ScrobbleConfig>('scrobble-config', DEFAULT_CONFIG);
  /** Tokens, keys and session keys: fiesta:music:secret:scrobble-creds. */
  readonly creds = this.settings.scoped<ScrobbleCreds>('secret:scrobble-creds', {});
  /** Submissions waiting for a retry: fiesta:music:secret:scrobble-queue. */
  readonly queue = this.settings.scoped<ScrobbleQueueItem[]>('secret:scrobble-queue', []);
  /** Last problem per service (absent when the last call worked). */
  readonly errors = signal<Partial<Record<ScrobbleServiceId, string>>>({});
  readonly anyReady = computed(() => SCROBBLE_SERVICES.some((s) => this.isReady(s)));

  private started = false;
  private run: Run | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private flushing = false;
  private seq = 0;
  private loving = new Set<string>();

  /** Subscribes to the player and library. Called once by MusicStartupService; cheap when nothing is enabled. */
  start(): void {
    if (this.started || typeof window === 'undefined') return;
    this.started = true;
    this.player.on('trackstart', (e) => this.onTrackStart(e.track));
    this.player.on('play', (e) => this.onPlay(e.track));
    this.player.on('pause', () => this.onPause());
    this.player.on('trackend', (e) => this.onTrackEnd(e.track, e.playedSeconds));
    this.library.onFavoriteChange((item, liked) => {
      if (liked && item.kind === 'track') void this.loveEverywhere(item.data);
    });
    window.addEventListener('online', () => void this.flush());
    if (this.queue().length && this.anyReady()) void this.flush();
  }

  // ── configuration ────────────────────────────────────────────────────────

  /** Credentials are present for `id` (it can be switched on). */
  hasCreds(id: ScrobbleServiceId): boolean {
    const c = this.creds();
    switch (id) {
      case 'listenbrainz': return !!c.listenbrainz?.token;
      case 'maloja': return !!c.maloja?.url && !!c.maloja?.key;
      case 'librefm': return !!c.librefm?.session;
      case 'lastfm': return !!c.lastfm?.session;
    }
  }

  /** Enabled and connected. */
  isReady(id: ScrobbleServiceId): boolean {
    return !!this.config().enabled[id] && this.hasCreds(id);
  }

  setEnabled(id: ScrobbleServiceId, on: boolean): void {
    this.config.update((c) => ({ ...c, enabled: { ...c.enabled, [id]: on } }));
    if (on && this.queue().length) void this.flush();
  }

  setLoveOnLike(on: boolean): void {
    this.config.update((c) => ({ ...c, loveOnLike: on }));
  }

  /** Saves credentials for one service. */
  setCreds<K extends keyof ScrobbleCreds>(id: K, value: ScrobbleCreds[K]): void {
    this.creds.update((c) => ({ ...c, [id]: value }));
    this.clearError(id);
  }

  /** Forgets a service's credentials and switches it off; its queued items are dropped. */
  disconnect(id: ScrobbleServiceId): void {
    this.creds.update((c) => {
      const next = { ...c };
      delete next[id];
      return next;
    });
    this.config.update((c) => ({ ...c, enabled: { ...c.enabled, [id]: false } }));
    this.queue.update((q) => q.filter((i) => i.service !== id));
    this.clearError(id);
  }

  // ── engine ───────────────────────────────────────────────────────────────

  private onTrackStart(track: MusicTrack): void {
    this.stopTimer();
    const clock = new PlayClock();
    const run: Run = { track, meta: scrobbleMeta(track), startedAt: Math.floor(Date.now() / 1000), clock, scrobbled: false };
    this.run = run;
    if (this.player.playing()) this.startClock(run);
    if (!this.anyReady()) return;
    for (const id of SCROBBLE_SERVICES) {
      if (id === 'maloja' || !this.isReady(id)) continue; // Maloja has no now-playing call
      void this.submit({ service: id, kind: 'nowplaying', meta: run.meta, ts: run.startedAt }).catch((e) => this.noteFailure(id, e));
    }
  }

  private onPlay(track: MusicTrack): void {
    if (this.run && this.run.track.id === track.id) this.startClock(this.run);
  }

  private onPause(): void {
    this.run?.clock.stop();
    this.stopTimer();
  }

  private onTrackEnd(track: MusicTrack, playedSeconds: number): void {
    const run = this.run;
    this.stopTimer();
    if (!run || run.track.id !== track.id) return;
    run.clock.stop();
    this.run = null;
    this.maybeScrobble(run, Math.max(run.clock.seconds(), playedSeconds));
  }

  private startClock(run: Run): void {
    run.clock.start();
    if (run.scrobbled || this.timer !== null || !this.anyReady()) return;
    // Outside the zone: a 1 s tick should not trigger change detection.
    this.zone.runOutsideAngular(() => {
      this.timer = setInterval(() => {
        const r = this.run;
        if (!r || r.scrobbled) return this.stopTimer();
        const need = scrobbleThreshold(r.meta.duration, this.settings.scrobblePercent());
        if (need !== null && r.clock.seconds() >= need) this.zone.run(() => this.maybeScrobble(r, r.clock.seconds()));
      }, 1000);
    });
  }

  private stopTimer(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  private maybeScrobble(run: Run, played: number): void {
    if (run.scrobbled) return;
    const need = scrobbleThreshold(run.meta.duration, this.settings.scrobblePercent());
    if (need === null || played < need) return;
    run.scrobbled = true;
    this.stopTimer();
    for (const id of SCROBBLE_SERVICES) {
      if (!this.isReady(id)) continue;
      const item = this.makeItem(id, 'scrobble', run.meta, run.startedAt);
      void this.submit(item).then(
        () => this.noteSuccess(id),
        (e) => this.fail(item, e),
      );
    }
  }

  private async loveEverywhere(track: MusicTrack): Promise<void> {
    if (!this.config().loveOnLike) return;
    const meta = scrobbleMeta(track);
    const key = `${meta.artist}\u0000${meta.title}`;
    if (this.loving.has(key)) return;
    this.loving.add(key);
    try {
      for (const id of SCROBBLE_SERVICES) {
        if (id === 'maloja' || !this.isReady(id)) continue;
        const item = this.makeItem(id, 'love', meta, 0);
        await this.submit(item).then(
          () => this.noteSuccess(id),
          (e) => this.fail(item, e),
        );
      }
    } finally {
      this.loving.delete(key);
    }
  }

  private makeItem(service: ScrobbleServiceId, kind: 'scrobble' | 'love', meta: ScrobbleMeta, ts: number): ScrobbleQueueItem {
    return { id: `${Date.now().toString(36)}-${++this.seq}`, service, kind, meta, ts, tries: 0 };
  }

  /** One call to one service. Throws ScrobbleError. */
  private async submit(item: { service: ScrobbleServiceId; kind: 'scrobble' | 'love' | 'nowplaying'; meta: ScrobbleMeta; ts: number }): Promise<void> {
    const c = this.creds();
    const { service, kind, meta, ts } = item;
    switch (service) {
      case 'listenbrainz': {
        const lb = c.listenbrainz;
        if (!lb?.token) throw new ScrobbleError('ListenBrainz is not connected', false);
        if (kind === 'love') return listenBrainzLove(lb, meta);
        return listenBrainzSubmit(lb, kind === 'scrobble' ? 'single' : 'playing_now', meta, ts);
      }
      case 'maloja': {
        const m = c.maloja;
        if (!m?.url || !m.key) throw new ScrobbleError('Maloja is not connected', false);
        if (kind === 'scrobble') return malojaScrobble(m, meta, ts);
        return;
      }
      case 'librefm':
      case 'lastfm': {
        const session = service === 'librefm' ? c.librefm?.session : c.lastfm?.session;
        if (!session) throw new ScrobbleError(`${SCROBBLE_SERVICE_NAMES[service]} is not connected`, false);
        return audioscrobblerSubmit(service, session, kind, meta, ts);
      }
    }
  }

  // ── results and the retry queue ──────────────────────────────────────────

  private noteSuccess(id: ScrobbleServiceId): void {
    this.clearError(id);
    if (this.queue().length) void this.flush();
  }

  private noteFailure(id: ScrobbleServiceId, e: unknown): void {
    const msg = e instanceof Error ? e.message : 'failed';
    const first = !this.errors()[id];
    this.errors.update((m) => ({ ...m, [id]: msg }));
    if (first) this.toast.show({ message: `${SCROBBLE_SERVICE_NAMES[id]}: ${msg}`, tone: 'warn' });
  }

  private clearError(id: ScrobbleServiceId): void {
    if (!this.errors()[id]) return;
    this.errors.update((m) => {
      const next = { ...m };
      delete next[id];
      return next;
    });
  }

  private fail(item: ScrobbleQueueItem, e: unknown): void {
    this.noteFailure(item.service, e);
    if (e instanceof ScrobbleError && e.retryable) this.queue.update((q) => enqueue(q, item));
  }

  /** Retries queued submissions in order; stops at the first one that still cannot get through. */
  async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      for (const item of [...this.queue()]) {
        if (!this.isReady(item.service)) continue;
        try {
          await this.submit(item);
          this.queue.update((q) => q.filter((i) => i.id !== item.id));
          this.clearError(item.service);
        } catch (e) {
          const retry = e instanceof ScrobbleError && e.retryable && item.tries + 1 < MAX_TRIES;
          this.queue.update((q) => (retry ? q.map((i) => (i.id === item.id ? { ...i, tries: i.tries + 1 } : i)) : q.filter((i) => i.id !== item.id)));
          this.noteFailure(item.service, e);
          if (retry) return; // offline: wait for the next success or online event
        }
      }
    } finally {
      this.flushing = false;
    }
  }
}
