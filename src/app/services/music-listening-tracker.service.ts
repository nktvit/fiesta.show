import { computed, inject, Injectable, Injector, signal } from '@angular/core';
import { musicStorage } from '../utils/music-storage';
import {
  emptyListening, frequentlySkippedTrackIds, ListeningData, pruneListening, RankedArtist, RankedTrack, recordPlay, sanitizeListening,
  shortPlayTrackIds, topArtists as rankTopArtists, topTracks as rankTopTracks,
} from '../utils/music-recs-scoring';
import { MusicPlayerService } from './music-player.service';
import { MusicTrack } from './music.service';

const KEY = 'listening';
const SAVE_DELAY_MS = 2000;

/**
 * On-device listening stats (completion, skips, artist affinity), fed by the
 * player's `trackend` and `skip` events. Kept in localStorage `fiesta:music:listening`
 * and never sent anywhere. The maths lives in utils/music-recs-scoring.ts.
 * Owned by package P9.
 */
@Injectable({ providedIn: 'root' })
export class MusicListeningTrackerService {
  private injector = inject(Injector);
  private readonly _data = signal<ListeningData>(emptyListening());
  private started = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  /** Id of a track whose `skip` event just fired; its `trackend` follows straight after. */
  private skippedId: number | null = null;

  /** Everything recorded (replaced, never mutated, on every change). */
  readonly data = this._data.asReadonly();

  readonly stats = computed(() => ({ tracks: Object.keys(this._data().tracks).length, artists: Object.keys(this._data().artists).length }));

  /** Artists played at least twice, best affinity first. */
  readonly topArtists = computed<RankedArtist[]>(() => rankTopArtists(this._data(), 20));
  /** Tracks played at least twice and mostly to the end. */
  readonly topTracks = computed<RankedTrack[]>(() => rankTopTracks(this._data(), 50));
  /** Ids the listener keeps skipping or abandoning (for filtering recommendations). */
  readonly knownBadTrackIds = computed(
    () => new Set([...frequentlySkippedTrackIds(this._data(), 100), ...shortPlayTrackIds(this._data(), 100)]),
  );

  constructor() {
    this.load();
  }

  /** Subscribes to player.on(...) events. Called once by MusicStartupService. */
  start(): void {
    if (this.started || typeof window === 'undefined') return;
    this.started = true;
    this.load();
    const player = this.injector.get(MusicPlayerService);
    // The player emits `skip` and then `trackend` for one skipped track.
    player.on('skip', (e) => {
      this.skippedId = e.track.id;
    });
    player.on('trackend', (e) => {
      const skipped = this.skippedId === e.track.id;
      this.skippedId = null;
      this.record(e.track, e.playedSeconds, e.completed, skipped);
    });
    window.addEventListener('pagehide', () => this.flush());
    window.addEventListener('storage', (ev) => {
      if (ev.key === null || ev.key === 'fiesta:music:' + KEY) this.load();
    });
  }

  /** Records one finished play. Returns what it counted as, or null when nothing was heard. */
  record(track: MusicTrack, playedSeconds: number, completed: boolean, skipped: boolean): 'skip' | 'completion' | 'partial' | null {
    // A track that failed to play (nothing heard, not skipped by the listener) says nothing about taste.
    if (!completed && !skipped && playedSeconds <= 0) return null;
    const next = JSON.parse(JSON.stringify(this._data())) as ListeningData;
    const result = recordPlay(next, track, { playedSeconds, durationSeconds: track.duration, completed, skipped });
    pruneListening(next);
    this._data.set(next);
    this.scheduleSave();
    return result;
  }

  /** Forgets everything (Settings > Privacy). */
  reset(): void {
    this._data.set(emptyListening());
    this.flush();
  }

  /** Writes pending changes now. */
  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    musicStorage.write(KEY, this._data());
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      musicStorage.write(KEY, this._data());
    }, SAVE_DELAY_MS);
  }

  private load(): void {
    this._data.set(sanitizeListening(musicStorage.read<unknown>(KEY, null)));
  }
}
