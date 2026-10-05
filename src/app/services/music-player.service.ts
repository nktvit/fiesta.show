import { HttpErrorResponse } from '@angular/common/http';
import {
  computed, effect, inject, Injectable, InjectionToken, Injector, signal, untracked,
} from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { tidalImage } from '../utils/music-format';
import {
  addToQueue, clearUpcoming, cycleRepeatMode, emptyQueue, insertNext, moveItem, nextIndex, playOrder, prevIndex,
  QueueState, removeAt, shuffleQueue, unshuffleQueue,
} from '../utils/music-queue';
import { effectiveVolume, getReplayGainScale } from '../utils/music-replay-gain';
import { musicStorage } from '../utils/music-storage';
import { crossfade, supportsElementVolume } from './music-crossfade';
import { canPlayManifest, MusicDeck, UnsupportedError } from './music-deck';
import { minifyTrack, MusicLibraryService } from './music-library.service';
import { MusicRecommenderService, RadioSeed } from './music-recommender.service';
import { MusicRepeatMode, MusicSettingsService } from './music-settings.service';
import { MusicToastService } from './music-toast.service';
import { MusicWaveformService } from './music-waveform.service';
import { MusicManifest, MusicQuality, MusicService, MusicTrack } from './music.service';

export type { RadioSeed } from './music-recommender.service';

/** Why playback stopped working, in words the bar can show. */
export type MusicError = 'session_expired' | 'unavailable' | 'unsupported' | 'network';

/** Where the current queue came from (for "Playing from ..." and radio). */
export interface MusicQueueContext {
  type: 'album' | 'artist' | 'playlist' | 'userPlaylist' | 'mix' | 'search' | 'library' | 'radio' | 'queue';
  id?: string | number;
  label: string;
}

export interface MusicPlayOptions {
  context?: MusicQueueContext | null;
  /** Shuffle the new queue (current track first). Default: keep the current shuffle state. */
  shuffle?: boolean;
}

export interface MusicSleepState {
  /** Epoch ms when the timer pauses playback, or null. */
  endsAt: number | null;
  /** Pause when the current track ends instead of advancing. */
  endOfTrack: boolean;
}

/** Payloads of player.on(type, cb). */
export interface MusicPlayerEvents {
  trackstart: { track: MusicTrack };
  /** `completed`: it played to the end (not skipped, stopped or replaced). */
  trackend: { track: MusicTrack; playedSeconds: number; completed: boolean };
  /** The user moved on (next/prev/playAt/new queue) before the track ended. */
  skip: { track: MusicTrack; at: number };
  seek: { from: number; to: number };
  play: { track: MusicTrack };
  pause: { track: MusicTrack };
  queuechange: { queue: MusicTrack[]; index: number };
  error: { track: MusicTrack; error: MusicError };
}

export type MusicPlayerEventType = keyof MusicPlayerEvents;

/** Snapshot for e2e scripts and debugging (`__music.player.debugState()`). */
export interface MusicPlayerDebugState {
  generation: number;
  activeDeck: 0 | 1;
  activeTrackId: number | null;
  standbyTrackId: number | null;
  standbyReady: boolean;
  crossfading: boolean;
  failures: number;
  autoplayBlocked: boolean;
  needsLoad: boolean;
  fadeGain: number;
  elementVolume: number;
  playbackRate: number;
}

/** Creates the audio elements (tests provide fakes). */
export const MUSIC_AUDIO_FACTORY = new InjectionToken<() => HTMLAudioElement | null>('MUSIC_AUDIO_FACTORY', {
  providedIn: 'root',
  factory: () => () => (typeof Audio !== 'undefined' ? new Audio() : null),
});

const QUALITY_LADDER: MusicQuality[] = ['HI_RES_LOSSLESS', 'LOSSLESS', 'HIGH', 'LOW'];
const PRELOAD_LEAD = 45;
const HISTORY_AFTER = 10;
const SAVE_EVERY = 10000;
const SLEEP_FADE = 10;
const STORAGE_KEY = 'player';

interface PersistedPlayer {
  v: 1;
  original: MusicTrack[];
  order: number[] | null;
  index: number;
  position: number;
  context: MusicQueueContext | null;
}

/** Book-keeping for the track currently on the active deck. */
interface Run {
  track: MusicTrack;
  played: number;
  lastTime: number;
  logged: boolean;
  ended: boolean;
}

/**
 * App-wide music player. Lives in the root injector so playback survives route
 * changes; the mini player bar and the pages only read its signals and call
 * its methods. Other features observe it through `on(...)`.
 *
 * Two decks (music-deck.ts): the active one plays, the standby one preloads the
 * next track 45 s before the end so gapless and crossfade switches are instant.
 * The queue math is in utils/music-queue.ts, the volume pipeline in
 * utils/music-replay-gain.ts.
 */
@Injectable({ providedIn: 'root' })
export class MusicPlayerService {
  private music = inject(MusicService);
  private settings = inject(MusicSettingsService);
  private library = inject(MusicLibraryService);
  private toast = inject(MusicToastService);
  private injector = inject(Injector);
  private makeAudio = inject(MUSIC_AUDIO_FACTORY);

  private decks: [MusicDeck, MusicDeck] | null = null;
  private activeIdx = signal<0 | 1>(0);
  private readonly state = signal<QueueState<MusicTrack>>(emptyQueue());

  /** Entries in play order (shuffled order while shuffle is on). */
  readonly queue = computed(() => playOrder(this.state()));
  readonly index = computed(() => this.state().index);
  readonly track = computed(() => this.queue()[this.index()] ?? null);
  readonly playing = signal(false);
  readonly loading = signal(false);
  readonly error = signal<MusicError | null>(null);
  readonly position = signal(0);
  readonly duration = signal(0);
  /** FULL or PREVIEW for the current track once its manifest is in. */
  readonly presentation = signal<MusicManifest['presentation'] | null>(null);
  /** The tier TIDAL served (LOW/HIGH/LOSSLESS/HI_RES_LOSSLESS), '' before. */
  readonly quality = signal('');
  /** The tier the browser couldn't decode and we stepped down from, or null. */
  readonly qualityFallback = signal<string | null>(null);
  readonly volume = this.settings.volume.asReadonly();
  readonly muted = this.settings.muted.asReadonly();
  readonly playbackRate = this.settings.playbackRate.asReadonly();
  readonly preservesPitch = this.settings.preservesPitch.asReadonly();
  readonly shuffle = computed(() => this.state().order !== null);
  readonly repeat = this.settings.repeat.asReadonly();
  readonly context = signal<MusicQueueContext | null>(null);
  readonly radio = signal<RadioSeed | null>(null);
  /** The browser refused to start audio without a gesture; the next tap/key resumes. */
  readonly autoplayBlocked = signal(false);
  readonly sleep = signal<MusicSleepState>({ endsAt: null, endOfTrack: false });
  /** Seconds left on the sleep timer (ticks once a second only while armed), or null. */
  readonly sleepRemaining = signal<number | null>(null);
  readonly activeElement = signal<HTMLAudioElement | null>(null);

  readonly canNext = computed(() => {
    const len = this.queue().length;
    if (!len || this.index() < 0) return false;
    return this.index() < len - 1 || this.repeat() !== 'off' || !!this.radio() || this.settings.autoplay();
  });
  readonly canPrev = computed(() => this.index() > 0 || (this.repeat() === 'all' && this.queue().length > 1));
  /** Aliases kept for the player bar. */
  readonly hasNext = this.canNext;
  readonly hasPrev = this.canPrev;
  /** The next 50 entries after the current one. */
  readonly upNext = computed(() => this.queue().slice(this.index() + 1, this.index() + 51));

  /** Bumped on every track change; stale async work compares against it and bows out. */
  private generation = 0;
  private standbySeq = 0;
  private standbyWanted: number | null = null;
  private run: Run | null = null;
  /** Restored from storage (or after a removal): the element is empty until the first play. */
  private needsLoad = false;
  private failures = 0;
  private retriedLower = false;
  private crossfading: AbortController | null = null;
  private deckGain = new Map<HTMLAudioElement, number>();
  private fadeGain = 1;
  private sleepTimer: ReturnType<typeof setInterval> | null = null;
  private lastSave = 0;
  private gestureResumeAt = 0;
  private resumeArmed = false;
  private refilling = false;
  private listeners = new Map<MusicPlayerEventType, Set<(e: never) => void>>();

  constructor() {
    const a = this.makeAudio();
    const b = this.makeAudio();
    if (!a || !b) return;
    this.decks = [new MusicDeck(a), new MusicDeck(b)];
    this.activeElement.set(a);
    for (const deck of this.decks) this.bindDeck(deck);
    this.restore();
    this.applyRate();
    this.applyVolume();
    this.bindMediaSession();

    // Settings changed elsewhere (settings page, another tab): re-apply.
    effect(() => {
      this.settings.volume();
      this.settings.muted();
      this.settings.exponentialVolume();
      this.settings.replayGainMode();
      this.settings.replayGainPreamp();
      untracked(() => this.applyVolume());
    });
    effect(() => {
      this.settings.playbackRate();
      this.settings.preservesPitch();
      untracked(() => this.applyRate());
    });

    if (typeof window !== 'undefined') window.addEventListener('pagehide', () => this.persist());
  }

  // ── Events ───────────────────────────────────────────────────────────────

  /** Subscribe to a player event; returns an unsubscribe function. */
  on<K extends MusicPlayerEventType>(type: K, cb: (e: MusicPlayerEvents[K]) => void): () => void {
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    set.add(cb as (e: never) => void);
    return () => set!.delete(cb as (e: never) => void);
  }

  private emit<K extends MusicPlayerEventType>(type: K, e: MusicPlayerEvents[K]): void {
    for (const cb of this.listeners.get(type) ?? []) {
      try {
        (cb as (e: MusicPlayerEvents[K]) => void)(e);
      } catch (err) {
        console.error('music player listener failed:', err);
      }
    }
  }

  // ── Playing ──────────────────────────────────────────────────────────────

  /** Play `track`, optionally as part of a list so next/previous work. */
  async play(track: MusicTrack, queue: MusicTrack[] = [track], opts: MusicPlayOptions = {}): Promise<void> {
    let i = queue.findIndex((t) => t.id === track.id);
    const list = i >= 0 ? queue : [track];
    if (i < 0) i = 0;
    await this.replaceQueue(list, i, opts);
  }

  /**
   * Replaces the queue with `tracks` and plays the one at `start`.
   * (Use addToQueue/playNext to keep the current queue.)
   */
  async setQueue(tracks: MusicTrack[], start = 0, context: MusicQueueContext | null = null): Promise<void> {
    if (!tracks.length) return this.stop();
    await this.replaceQueue(tracks, Math.min(Math.max(0, start), tracks.length - 1), { context });
  }

  playAt(i: number): void {
    if (i >= 0 && i < this.queue().length) void this.start(i, { reason: 'user' });
  }

  /** Play/pause. Reloads the track instead when nothing is loaded or it errored. */
  toggle(): void {
    if (!this.decks || !this.track()) return;
    const el = this.active().el;
    const hasSrc = !!(el.getAttribute?.('src') || el.src);
    if (this.needsLoad || this.error() || !hasSrc) {
      void this.start(this.index(), { startAt: this.position(), reason: 'resume' });
      return;
    }
    if (el.paused) this.resume();
    // The first gesture after a blocked autoplay already resumed; don't pause it again.
    else if (performance.now() - this.gestureResumeAt > 600) this.pause();
  }

  pause(): void {
    if (this.decks) this.active().el.pause();
  }

  resume(): void {
    if (!this.decks || !this.track()) return;
    if (this.needsLoad || this.error()) {
      void this.start(this.index(), { startAt: this.position(), reason: 'resume' });
      return;
    }
    void this.safePlay(this.active().el);
  }

  next(): void {
    const len = this.queue().length;
    if (!len) return;
    const n = this.index() + 1 < len ? this.index() + 1 : this.repeat() !== 'off' ? 0 : -1;
    if (n >= 0) {
      void this.start(n, { reason: 'user' });
      return;
    }
    if (this.radio() || this.settings.autoplay()) {
      void this.refill(this.radio() ? 'radio' : 'autoplay').then((added) => {
        if (added) void this.start(this.index() + 1, { reason: 'user' });
      });
    }
  }

  prev(): void {
    // Like every player: restart the track first, go back only near its start.
    const p = prevIndex(this.queue().length, this.index(), this.repeat());
    if (this.position() > 3 || p < 0) this.seek(0);
    else void this.start(p, { reason: 'user' });
  }

  /** Seeks to `seconds`, clamped to [0, duration - 0.25]. */
  seek(seconds: number): void {
    if (!this.decks || !this.track()) return;
    const dur = this.duration() || this.track()!.duration || 0;
    const to = Math.max(0, Math.min(seconds, Math.max(0, dur - 0.25)));
    const from = this.position();
    this.position.set(to);
    if (!this.needsLoad) {
      try {
        this.active().el.currentTime = to;
      } catch {
        // not seekable yet
      }
    }
    this.emit('seek', { from, to });
    this.updatePositionState();
  }

  /** Relative seek (shortcuts, Media Session ±10 s). */
  seekBy(delta: number): void {
    this.seek(this.position() + delta);
  }

  /** Stops playback and clears the queue. */
  stop(): void {
    this.endRun(false, 'none');
    this.generation++;
    this.cancelCrossfade();
    this.decks?.forEach((d) => d.dispose());
    this.state.set(emptyQueue());
    this.needsLoad = false;
    this.context.set(null);
    this.radio.set(null);
    this.playing.set(false);
    this.loading.set(false);
    this.error.set(null);
    this.position.set(0);
    this.duration.set(0);
    this.presentation.set(null);
    this.qualityFallback.set(null);
    this.standbyWanted = null;
    this.queueChanged();
    musicStorage.remove(STORAGE_KEY);
    if (typeof navigator !== 'undefined' && 'mediaSession' in navigator) {
      navigator.mediaSession.metadata = null;
      navigator.mediaSession.playbackState = 'none';
    }
  }

  // ── Volume, speed ────────────────────────────────────────────────────────

  setVolume(v: number): void {
    this.settings.volume.set(Math.min(1, Math.max(0, v)));
    if (v > 0 && this.settings.muted()) this.settings.muted.set(false);
    this.applyVolume();
  }

  toggleMute(): void {
    this.settings.muted.set(!this.settings.muted());
    this.applyVolume();
  }

  /** 0.25..4. */
  setPlaybackRate(r: number): void {
    this.settings.playbackRate.set(Math.min(4, Math.max(0.25, r)));
    this.applyRate();
    this.updatePositionState();
  }

  setPreservesPitch(b: boolean): void {
    this.settings.preservesPitch.set(b);
    this.applyRate();
  }

  // ── Shuffle, repeat ──────────────────────────────────────────────────────

  toggleShuffle(): void {
    this.setShuffle(!this.shuffle());
  }

  setShuffle(on: boolean): void {
    this.settings.shuffle.set(on);
    if (on === this.shuffle()) return;
    this.state.set(on ? shuffleQueue(this.state()) : unshuffleQueue(this.state()));
    this.queueChanged();
  }

  cycleRepeat(): void {
    this.setRepeat(cycleRepeatMode(this.repeat()));
  }

  setRepeat(mode: MusicRepeatMode): void {
    this.settings.repeat.set(mode);
    this.syncStandby();
  }

  // ── Queue editing ────────────────────────────────────────────────────────

  /** Appends; plays the first one if nothing is queued. */
  addToQueue(tracks: MusicTrack[]): void {
    if (!tracks.length) return;
    if (!this.queue().length) {
      void this.replaceQueue(tracks, 0, { context: { type: 'queue', label: 'Queue' } });
      return;
    }
    this.state.set(addToQueue(this.state(), tracks));
    this.queueChanged();
  }

  /** Inserts right after the current track; plays it if nothing is queued. */
  playNext(tracks: MusicTrack[]): void {
    if (!tracks.length) return;
    if (!this.queue().length) {
      void this.replaceQueue(tracks, 0, { context: { type: 'queue', label: 'Queue' } });
      return;
    }
    this.state.set(insertNext(this.state(), tracks));
    this.queueChanged();
  }

  /** Removes the entry at play position `i`. Removing the current one moves on to the next. */
  removeAt(i: number): void {
    const { state, removedCurrent } = removeAt(this.state(), i);
    if (state === this.state()) return;
    if (!state.original.length) {
      this.stop();
      return;
    }
    const wasPlaying = this.playing();
    if (removedCurrent) {
      this.endRun(false, 'user');
      const idx = Math.min(state.index, state.original.length - 1);
      this.state.set({ ...state, index: idx });
      this.queueChanged();
      if (wasPlaying) void this.start(idx, { reason: 'auto' });
      else this.showPaused(idx);
      return;
    }
    this.state.set(state);
    this.queueChanged();
  }

  /** Moves the entry at play position `from` to `to`. */
  move(from: number, to: number): void {
    const next = moveItem(this.state(), from, to);
    if (next === this.state()) return;
    this.state.set(next);
    this.queueChanged();
  }

  /** Drops everything after the current track. */
  clearUpcoming(): void {
    const next = clearUpcoming(this.state());
    if (next === this.state()) return;
    this.state.set(next);
    this.queueChanged();
  }

  // ── Radio ────────────────────────────────────────────────────────────────

  /** Replaces the queue with a radio station from `seed`; refills as it runs low. */
  async startRadio(seed: RadioSeed): Promise<void> {
    const rec = this.injector.get(MusicRecommenderService);
    let tracks: MusicTrack[] = [];
    try {
      tracks = (await rec.radioTracks(seed)).filter((t) => !this.library.isBlocked(t));
    } catch {
      tracks = [];
    }
    if (!tracks.length) {
      this.toast.show({ message: `Couldn't start radio for ${seed.label}`, tone: 'warn' });
      return;
    }
    this.radio.set(seed);
    // Callers pass the bare title; the queue context reads "Radio: <title>" everywhere (idempotent).
    const label = /^Radio: /.test(seed.label) ? seed.label : `Radio: ${seed.label}`;
    await this.replaceQueue(tracks, 0, { context: { type: 'radio', id: seed.id, label }, shuffle: false });
  }

  stopRadio(): void {
    this.radio.set(null);
  }

  // ── Sleep timer ──────────────────────────────────────────────────────────

  /** Pauses after `minutes`, at the end of the current track, or cancels (null). */
  setSleepTimer(minutes: number | 'end-of-track' | null): void {
    if (this.sleepTimer) clearInterval(this.sleepTimer);
    this.sleepTimer = null;
    this.setFade(1);
    if (minutes === null) {
      this.sleep.set({ endsAt: null, endOfTrack: false });
      this.sleepRemaining.set(null);
      return;
    }
    if (minutes === 'end-of-track') {
      this.sleep.set({ endsAt: null, endOfTrack: true });
      this.sleepRemaining.set(Math.max(0, Math.ceil(this.duration() - this.position())));
      return;
    }
    const endsAt = Date.now() + Math.max(0, minutes) * 60000;
    this.sleep.set({ endsAt, endOfTrack: false });
    const tick = () => {
      const left = (endsAt - Date.now()) / 1000;
      const secs = Math.max(0, Math.ceil(left));
      if (this.sleepRemaining() !== secs) this.sleepRemaining.set(secs);
      if (this.settings.sleepFadeOut() && left <= SLEEP_FADE) this.setFade(Math.max(0, left / SLEEP_FADE));
      if (left <= 0) {
        this.pause();
        this.setSleepTimer(null);
      }
    };
    tick();
    this.sleepTimer = setInterval(tick, 250);
  }

  // ── Misc ─────────────────────────────────────────────────────────────────

  /** Both deck elements (the audio graph taps each). */
  elements(): HTMLAudioElement[] {
    return this.decks ? this.decks.map((d) => d.el) : [];
  }

  debugState(): MusicPlayerDebugState {
    const d = this.decks;
    const act = this.activeIdx();
    return {
      generation: this.generation,
      activeDeck: act,
      activeTrackId: d ? d[act].trackId : null,
      standbyTrackId: d ? d[1 - act].trackId : null,
      standbyReady: d ? d[1 - act].ready : false,
      crossfading: !!this.crossfading,
      failures: this.failures,
      autoplayBlocked: this.autoplayBlocked(),
      needsLoad: this.needsLoad,
      fadeGain: this.fadeGain,
      elementVolume: d ? d[act].el.volume : 0,
      playbackRate: d ? d[act].el.playbackRate : 0,
    };
  }

  // ── internals: track changes ─────────────────────────────────────────────

  private active(): MusicDeck {
    return this.decks![this.activeIdx()];
  }

  private standby(): MusicDeck {
    return this.decks![1 - this.activeIdx()];
  }

  private async replaceQueue(tracks: MusicTrack[], i: number, opts: MusicPlayOptions): Promise<void> {
    this.endRun(false, 'user');
    let st: QueueState<MusicTrack> = { original: tracks.slice(), order: null, index: i };
    if (opts.shuffle ?? this.shuffle()) st = shuffleQueue(st);
    this.settings.shuffle.set(st.order !== null);
    this.state.set(st);
    this.context.set(opts.context ?? null);
    if (opts.context?.type !== 'radio') this.radio.set(null);
    this.failures = 0;
    this.disposeStandby();
    this.queueChanged();
    await this.start(st.index, { reason: 'user' });
  }

  private async start(
    i: number,
    opts: { startAt?: number; reason?: 'user' | 'auto' | 'resume'; tierCap?: MusicQuality } = {},
  ): Promise<void> {
    if (!this.decks) return;
    const track = this.queue()[i];
    if (!track) return;
    if (this.library.isBlocked(track)) {
      this.skipFailed(i, track, null);
      return;
    }
    const reason = opts.reason ?? 'auto';
    if (reason !== 'resume') this.endRun(false, reason === 'user' ? 'user' : 'none');
    const gen = ++this.generation;
    const startAt = opts.startAt ?? 0;
    if (!opts.tierCap) this.retriedLower = false;
    this.cancelCrossfade();
    this.needsLoad = false;
    this.state.update((s) => ({ ...s, index: i }));
    this.error.set(null);
    this.loading.set(true);
    this.playing.set(false);
    this.position.set(startAt);
    this.duration.set(track.duration);
    this.presentation.set(null);
    this.updateMediaSession(track);

    // The standby deck already holds this track: switch instantly.
    const sb = this.standby();
    if (!startAt && !opts.tierCap && sb.trackId === track.id && sb.ready) {
      this.promoteStandby(track, gen);
      return;
    }

    this.active().el.pause();
    this.disposeStandby();
    try {
      const { manifest, fellBackFrom } = await this.fetchPlayable(track, gen, opts.tierCap);
      if (gen !== this.generation) return;
      this.presentation.set(manifest.presentation);
      this.quality.set(manifest.quality);
      this.qualityFallback.set(fellBackFrom);
      const deck = this.active();
      await deck.load(manifest, track.id, () => gen === this.generation, { startAt });
      if (gen !== this.generation) return;
      const total = (manifest.durations ?? []).reduce((s, d) => s + d, 0);
      if (total) this.duration.set(total);
      this.applyRate();
      this.applyVolume();
      this.beginRun(track, startAt);
      await this.safePlay(deck.el);
    } catch (e) {
      if (gen !== this.generation || e instanceof StaleError) return;
      this.handleFailure(e, track, i);
    }
  }

  /** Swaps decks so the prepared standby plays now. */
  private promoteStandby(track: MusicTrack, gen: number, viaCrossfade = false): void {
    const out = this.active();
    const inc = this.standby();
    this.activeIdx.set((1 - this.activeIdx()) as 0 | 1);
    this.activeElement.set(inc.el);
    inc.promote();
    const m = inc.manifest;
    if (m) {
      this.presentation.set(m.presentation);
      this.quality.set(m.quality);
      const total = (m.durations ?? []).reduce((s, d) => s + d, 0);
      this.duration.set(total || track.duration);
    }
    this.qualityFallback.set(null);
    this.standbyWanted = null;
    this.applyRate();
    if (viaCrossfade) {
      const ac = new AbortController();
      this.crossfading = ac;
      this.deckGain.set(inc.el, 0);
      this.applyVolume();
      this.beginRun(track, 0);
      void this.safePlay(inc.el);
      crossfade(out.el, inc.el, this.settings.crossfadeSeconds(), (el, g) => {
        this.deckGain.set(el, Math.min(1, Math.max(0, g)));
        this.applyVolume();
      }, ac.signal)
        .catch(() => undefined)
        .finally(() => {
          if (this.crossfading === ac) this.crossfading = null;
          this.deckGain.delete(inc.el);
          this.deckGain.delete(out.el);
          if (out !== this.active()) out.dispose();
          this.applyVolume();
        });
      return;
    }
    out.dispose();
    this.deckGain.delete(inc.el);
    this.applyVolume();
    if (gen !== this.generation) return;
    this.beginRun(track, 0);
    void this.safePlay(inc.el);
  }

  /** The manifest to play, stepping down the quality ladder while MSE can't decode it. */
  private async fetchPlayable(
    track: MusicTrack, gen: number, cap?: MusicQuality,
  ): Promise<{ manifest: MusicManifest; fellBackFrom: string | null }> {
    const wanted = this.wantedQuality();
    let from = QUALITY_LADDER.indexOf(wanted);
    if (cap) from = Math.max(from, QUALITY_LADDER.indexOf(cap));
    for (let k = from; k < QUALITY_LADDER.length; k++) {
      const tier = QUALITY_LADDER[k];
      const m = await firstValueFrom(this.music.manifest(track.id, tier));
      if (gen !== this.generation) throw new StaleError();
      if (canPlayManifest(m)) return { manifest: m, fellBackFrom: k > QUALITY_LADDER.indexOf(wanted) ? wanted : null };
    }
    throw new UnsupportedError();
  }

  /** settings.quality, with 'auto' = FLAC where MSE decodes it, else AAC 320. */
  private wantedQuality(): MusicQuality {
    const q = this.settings.quality();
    if (q !== 'auto') return q;
    return canPlayManifest({ kind: 'segments', codec: 'flac' } as MusicManifest) ? 'LOSSLESS' : 'HIGH';
  }

  private handleFailure(e: unknown, track: MusicTrack, i: number): void {
    const kind = this.classify(e);
    this.emit('error', { track, error: kind });
    if (kind === 'unavailable' && this.settings.skipUnavailable() && this.queue().length > 1) {
      this.skipFailed(i, track, kind);
      return;
    }
    if (kind === 'unavailable') this.toast.show({ message: `Couldn't play ${track.title}`, tone: 'warn' });
    this.fail(kind);
  }

  /** Auto-advances past an unplayable/blocked track; stops after one full pass of failures. */
  private skipFailed(i: number, track: MusicTrack, kind: MusicError | null): void {
    const len = this.queue().length;
    this.failures++;
    if (this.failures >= len) {
      this.failures = 0;
      this.state.update((s) => ({ ...s, index: i }));
      this.toast.show({ message: "Couldn't play any track in this queue", tone: 'warn' });
      this.fail(kind ?? 'unavailable');
      return;
    }
    if (kind) this.toast.show({ message: `Couldn't play ${track.title}, skipping`, tone: 'warn' });
    const n = nextIndex(len, i, this.repeat() === 'off' ? 'off' : 'all');
    if (n < 0) {
      this.state.update((s) => ({ ...s, index: i }));
      this.fail(kind ?? 'unavailable');
      return;
    }
    void this.start(n, { reason: 'auto' });
  }

  private fail(e: MusicError): void {
    this.error.set(e);
    this.loading.set(false);
    this.playing.set(false);
  }

  private classify(e: unknown): MusicError {
    if (e instanceof UnsupportedError) return 'unsupported';
    if (e instanceof HttpErrorResponse) {
      if (e.status === 401) return 'session_expired';
      if (e.status === 0) return 'network';
    }
    if (e instanceof TypeError) return 'network'; // fetch() of a segment failed outright
    return 'unavailable';
  }

  /** The track shows (paused, not loaded) without playing - after a restore or removal. */
  private showPaused(i: number): void {
    this.generation++;
    this.active().dispose();
    this.disposeStandby();
    this.needsLoad = true;
    const t = this.queue()[i];
    this.position.set(0);
    this.duration.set(t?.duration ?? 0);
    this.presentation.set(null);
    this.playing.set(false);
    this.loading.set(false);
    if (t) this.updateMediaSession(t);
  }

  // ── internals: element events ────────────────────────────────────────────

  private bindDeck(deck: MusicDeck): void {
    const a = deck.el;
    const isActive = () => this.decks !== null && this.active() === deck;
    deck.onError = (e) => {
      if (!isActive() || !this.track()) return;
      this.handleFailure(e, this.track()!, this.index());
    };
    a.addEventListener('playing', () => {
      if (!isActive()) return;
      this.playing.set(true);
      this.loading.set(false);
      this.autoplayBlocked.set(false);
      this.setPlaybackState('playing');
      if (this.track()) this.emit('play', { track: this.track()! });
    });
    a.addEventListener('pause', () => {
      if (!isActive()) return;
      this.playing.set(false);
      this.setPlaybackState('paused');
      if (this.track() && this.run) this.emit('pause', { track: this.track()! });
      this.persist();
    });
    a.addEventListener('waiting', () => { if (isActive() && !a.paused) this.loading.set(true); });
    a.addEventListener('timeupdate', () => { if (isActive()) this.onTime(a); });
    a.addEventListener('durationchange', () => {
      if (isActive() && Number.isFinite(a.duration) && a.duration > 0) this.duration.set(a.duration);
      if (isActive()) this.updatePositionState();
    });
    a.addEventListener('ratechange', () => { if (isActive()) this.updatePositionState(); });
    a.addEventListener('ended', () => { if (isActive()) void this.onEnded(); });
    a.addEventListener('error', () => {
      if (!isActive() || !a.getAttribute?.('src')) return;
      const code = a.error?.code ?? 0;
      const track = this.track();
      if (!track) return;
      // Decode/format errors: retry once a quality tier lower (PB06).
      if ((code === 3 || code === 4) && !this.retriedLower) {
        const tier = QUALITY_LADDER.indexOf((this.active().manifest?.quality ?? '') as MusicQuality);
        if (tier >= 0 && tier < QUALITY_LADDER.length - 1) {
          this.retriedLower = true;
          void this.start(this.index(), { startAt: this.position(), reason: 'resume', tierCap: QUALITY_LADDER[tier + 1] });
          return;
        }
      }
      const err = code === 2 ? new TypeError('network') : code === 3 || code === 4 ? new UnsupportedError() : new Error('media');
      this.handleFailure(err, track, this.index());
    });
  }

  private onTime(a: HTMLAudioElement): void {
    if (this.needsLoad) return;
    const t = a.currentTime;
    this.position.set(t);
    const run = this.run;
    if (run && !a.paused) {
      const delta = t - run.lastTime;
      if (delta > 0 && delta < 2) run.played += delta;
      if (!run.logged && run.played >= HISTORY_AFTER) {
        run.logged = true;
        this.library.addHistory(run.track);
      }
    }
    if (run) run.lastTime = t;

    const dur = this.duration();
    const sleep = this.sleep();
    if (sleep.endOfTrack && dur > 0) {
      const left = Math.max(0, dur - t);
      this.sleepRemaining.set(Math.ceil(left));
      if (this.settings.sleepFadeOut() && left <= SLEEP_FADE) this.setFade(Math.max(0, left / SLEEP_FADE));
    }

    if (dur > 0 && t >= dur - PRELOAD_LEAD) this.preloadNext();

    const track = this.track();
    if (track && dur > 0 && !this.crossfading && !sleep.endOfTrack) {
      const bounds = this.settings.removeSilence() ? this.waveform().bounds(track.id) : null;
      const end = bounds && bounds.end > 0 && bounds.end < dur ? bounds.end : dur;
      const cf = this.settings.crossfadeSeconds();
      if (cf > 0 && this.repeat() !== 'one' && supportsElementVolume() && t >= end - cf) {
        const n = nextIndex(this.queue().length, this.index(), this.repeat());
        const next = n >= 0 ? this.queue()[n] : null;
        const sb = this.standby();
        if (next && sb.trackId === next.id && sb.ready) {
          this.endRun(true, 'none');
          const gen = ++this.generation;
          this.state.update((s) => ({ ...s, index: n }));
          this.updateMediaSession(next);
          this.promoteStandby(next, gen, true);
          return;
        }
      }
      // Trailing silence: move on early.
      if (bounds && end < dur - 0.5 && t >= end) {
        void this.onEnded();
      }
    }

    if (!a.paused && Date.now() - this.lastSave > SAVE_EVERY) this.persist();
  }

  private async onEnded(): Promise<void> {
    const track = this.track();
    if (!track) return;
    this.endRun(true, 'none');
    if (this.sleep().endOfTrack) {
      this.active().el.pause();
      this.playing.set(false);
      this.setSleepTimer(null);
      return;
    }
    if (this.repeat() === 'one') {
      const el = this.active().el;
      el.currentTime = 0;
      this.position.set(0);
      this.beginRun(track, 0);
      void this.safePlay(el);
      return;
    }
    const len = this.queue().length;
    let n = nextIndex(len, this.index(), this.repeat());
    if (n < 0 && (this.radio() || this.settings.autoplay())) {
      const added = await this.refill(this.radio() ? 'radio' : 'autoplay');
      if (added) n = this.index() + 1;
    }
    if (n < 0) {
      this.playing.set(false);
      this.persist();
      return;
    }
    // Without gapless the next track loads afresh (the preloaded deck is dropped).
    if (!this.settings.gapless()) this.disposeStandby();
    await this.start(n, { reason: 'auto' });
  }

  // ── internals: preload ───────────────────────────────────────────────────

  private preloadNext(): void {
    if (!this.decks || this.repeat() === 'one') return;
    const n = nextIndex(this.queue().length, this.index(), this.repeat());
    const next = n >= 0 ? this.queue()[n] : null;
    if (!next || next.id === this.active().trackId || this.library.isBlocked(next)) return;
    if (this.standbyWanted === next.id) return;
    this.standbyWanted = next.id;
    const seq = ++this.standbySeq;
    const deck = this.standby();
    const gen = this.generation;
    void (async () => {
      try {
        const { manifest } = await this.fetchPlayable(next, gen);
        if (seq !== this.standbySeq || deck !== this.standby()) return;
        await deck.prepare(manifest, next.id);
      } catch {
        if (seq === this.standbySeq && deck === this.standby()) {
          deck.dispose();
          this.standbyWanted = null;
        }
      }
    })();
  }

  private disposeStandby(): void {
    if (!this.decks) return;
    this.standbySeq++;
    this.standbyWanted = null;
    this.standby().dispose();
  }

  /** Drops the standby deck when the queue no longer has its track next. */
  private syncStandby(): void {
    if (!this.decks || this.crossfading) return;
    const n = nextIndex(this.queue().length, this.index(), this.repeat());
    const next = n >= 0 && this.repeat() !== 'one' ? this.queue()[n] : null;
    const sb = this.standby();
    const held = sb.trackId ?? this.standbyWanted;
    if (held !== null && held !== next?.id) this.disposeStandby();
    // Re-arm right away if we're already inside the preload window.
    const dur = this.duration();
    if (next && dur > 0 && this.position() >= dur - PRELOAD_LEAD && !this.needsLoad && this.run) this.preloadNext();
  }

  // ── internals: runs (history, events) ────────────────────────────────────

  private beginRun(track: MusicTrack, at: number): void {
    this.run = { track, played: 0, lastTime: at, logged: false, ended: false };
    this.failures = 0;
    this.emit('trackstart', { track });
    this.updatePositionState();
    if (this.settings.waveformSeekbar() || this.settings.removeSilence()) {
      const wf = this.waveform();
      wf.request(track);
      const b = this.settings.removeSilence() ? wf.bounds(track.id) : null;
      if (b && b.start > 0.5 && at < b.start) {
        try {
          this.active().el.currentTime = b.start;
        } catch {
          // not seekable yet
        }
      }
    }
    // Radio keeps a few tracks ahead.
    if (this.radio() && this.queue().length - this.index() - 1 <= 3) void this.refill('radio');
  }

  /** Closes the current run: trackend (+ skip when the user moved on early). */
  private endRun(completed: boolean, reason: 'user' | 'none'): void {
    const run = this.run;
    if (!run || run.ended) return;
    run.ended = true;
    this.run = null;
    if (!completed && reason === 'user') this.emit('skip', { track: run.track, at: this.position() });
    this.emit('trackend', { track: run.track, playedSeconds: Math.round(run.played * 10) / 10, completed });
  }

  private async refill(mode: 'radio' | 'autoplay'): Promise<number> {
    if (this.refilling) return 0;
    this.refilling = true;
    try {
      const rec = this.injector.get(MusicRecommenderService);
      const q = this.queue();
      const seeds = q.slice(Math.max(0, this.index() - 4), this.index() + 1);
      const exclude = new Set<number>([...q.map((t) => t.id), ...this.library.history().slice(0, 100).map((h) => h.track.id)]);
      const tracks = (await rec.refill(seeds, { mode, exclude, limit: 20 }))
        .filter((t) => !exclude.has(t.id) && !this.library.isBlocked(t));
      if (!tracks.length) return 0;
      this.state.set(addToQueue(this.state(), tracks));
      this.queueChanged();
      return tracks.length;
    } catch {
      return 0;
    } finally {
      this.refilling = false;
    }
  }

  private queueChanged(): void {
    this.emit('queuechange', { queue: this.queue(), index: this.index() });
    this.syncStandby();
    this.persist();
  }

  // ── internals: output ────────────────────────────────────────────────────

  private applyVolume(): void {
    if (!this.decks) return;
    const mode = this.settings.replayGainMode();
    for (const deck of this.decks) {
      const rg = getReplayGainScale(deck.manifest, { mode, preampDb: this.settings.replayGainPreamp() });
      try {
        deck.el.volume = effectiveVolume({
          volume: this.settings.volume(),
          muted: this.settings.muted(),
          exponential: this.settings.exponentialVolume(),
          replayGain: rg,
          fade: this.fadeGain,
          deck: this.deckGain.get(deck.el) ?? 1,
        });
        deck.el.muted = this.settings.muted();
      } catch {
        // read-only volume (iOS): the OS controls it
      }
    }
  }

  private applyRate(): void {
    if (!this.decks) return;
    const rate = this.settings.playbackRate();
    const pitch = this.settings.preservesPitch();
    for (const deck of this.decks) {
      const el = deck.el as HTMLAudioElement & { webkitPreservesPitch?: boolean };
      el.defaultPlaybackRate = rate;
      el.playbackRate = rate;
      el.preservesPitch = pitch;
      if ('webkitPreservesPitch' in el) el.webkitPreservesPitch = pitch;
    }
  }

  private setFade(g: number): void {
    if (g === this.fadeGain) return;
    this.fadeGain = g;
    this.applyVolume();
  }

  private cancelCrossfade(): void {
    if (!this.crossfading) return;
    this.crossfading.abort();
    this.crossfading = null;
    this.deckGain.clear();
    this.applyVolume();
  }

  private waveform(): MusicWaveformService {
    return this.injector.get(MusicWaveformService);
  }

  /** el.play() that turns an autoplay refusal into `autoplayBlocked` and resumes on the next gesture. */
  private async safePlay(el: HTMLAudioElement): Promise<boolean> {
    try {
      await el.play();
      this.autoplayBlocked.set(false);
      return true;
    } catch (e) {
      const name = (e as { name?: string } | null)?.name;
      if (name === 'NotAllowedError') {
        this.autoplayBlocked.set(true);
        this.loading.set(false);
        this.playing.set(false);
        this.armGestureResume();
        return false;
      }
      // AbortError: a newer load or a pause interrupted play() - not a failure.
      if (name === 'AbortError') return false;
      throw e;
    }
  }

  private armGestureResume(): void {
    if (this.resumeArmed || typeof document === 'undefined') return;
    this.resumeArmed = true;
    const resume = (e: Event) => {
      if (e.type === 'visibilitychange' && document.visibilityState !== 'visible') return;
      document.removeEventListener('pointerdown', resume, true);
      document.removeEventListener('keydown', resume, true);
      document.removeEventListener('visibilitychange', resume);
      this.resumeArmed = false;
      if (!this.autoplayBlocked() || !this.track() || !this.decks) return;
      this.gestureResumeAt = performance.now();
      void this.safePlay(this.active().el);
    };
    document.addEventListener('pointerdown', resume, true);
    document.addEventListener('keydown', resume, true);
    document.addEventListener('visibilitychange', resume);
  }

  // ── internals: persistence ───────────────────────────────────────────────

  private persist(): void {
    this.lastSave = Date.now();
    const s = this.state();
    if (!s.original.length) return;
    const data: PersistedPlayer = {
      v: 1,
      original: s.original.map(minifyTrack),
      order: s.order,
      index: s.index,
      position: Math.floor(this.position()),
      context: this.context(),
    };
    musicStorage.write(STORAGE_KEY, data);
  }

  private restore(): void {
    const p = musicStorage.read<PersistedPlayer | null>(STORAGE_KEY, null);
    if (!p || p.v !== 1 || !Array.isArray(p.original) || !p.original.length) return;
    const len = p.original.length;
    const order = Array.isArray(p.order) && p.order.length === len && new Set(p.order).size === len
      && p.order.every((k) => Number.isInteger(k) && k >= 0 && k < len) ? p.order : null;
    const index = Number.isInteger(p.index) && p.index >= 0 && p.index < len ? p.index : 0;
    this.state.set({ original: p.original, order, index });
    this.settings.shuffle.set(order !== null);
    this.context.set(p.context ?? null);
    this.needsLoad = true;
    const t = this.queue()[index];
    this.duration.set(t?.duration ?? 0);
    this.position.set(Math.max(0, Math.min(p.position || 0, (t?.duration ?? 0) - 1)));
    if (t) this.updateMediaSession(t);
  }

  // ── Lock screen / media keys ──────────────────────────────────────────────

  private updateMediaSession(t: MusicTrack): void {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: t.title,
        artist: t.artist,
        album: t.album,
        artwork: t.cover
          ? [160, 320, 640].map((s) => ({ src: tidalImage(t.cover, s), sizes: `${s}x${s}`, type: 'image/jpeg' }))
          : [],
      });
    } catch {
      // MediaMetadata missing (old Safari)
    }
  }

  private updatePositionState(): void {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator) || !this.decks) return;
    const ms = navigator.mediaSession;
    const el = this.active().el;
    const duration = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : this.duration();
    if (!duration || !Number.isFinite(duration) || typeof ms.setPositionState !== 'function') return;
    try {
      ms.setPositionState({
        duration,
        playbackRate: el.playbackRate || 1,
        position: Math.min(Math.max(0, el.currentTime || this.position()), duration),
      });
    } catch {
      // position > duration while the duration is still settling
    }
  }

  private setPlaybackState(s: MediaSessionPlaybackState): void {
    if (typeof navigator !== 'undefined' && 'mediaSession' in navigator) navigator.mediaSession.playbackState = s;
  }

  private bindMediaSession(): void {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    const set = (action: MediaSessionAction, handler: MediaSessionActionHandler) => {
      try {
        ms.setActionHandler(action, handler);
      } catch {
        // action not supported by this browser
      }
    };
    set('play', () => this.resume());
    set('pause', () => this.pause());
    set('previoustrack', () => this.prev());
    set('nexttrack', () => this.next());
    set('seekto', (d) => { if (d.seekTime !== undefined) this.seek(d.seekTime); });
    set('seekforward', (d) => this.seekBy(d.seekOffset || 10));
    set('seekbackward', (d) => this.seekBy(-(d.seekOffset || 10)));
    set('stop', () => {
      this.pause();
      this.seek(0);
      this.setPlaybackState('paused');
    });
  }
}

/** A newer track change superseded this work. */
class StaleError extends Error {}
