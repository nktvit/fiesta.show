import { Injectable, signal, WritableSignal } from '@angular/core';
import { musicStorage, MUSIC_STORAGE_PREFIX } from '../utils/music-storage';
import { MusicQuality } from './music.service';

export type MusicQualitySetting = 'auto' | MusicQuality;
export type MusicRepeatMode = 'off' | 'all' | 'one';
export type MusicReplayGainMode = 'off' | 'track' | 'album';
export type MusicCoverClickAction = 'nowPlaying' | 'album';
export type MusicSettingsTab =
  | 'playback' | 'audio' | 'lyrics' | 'interface' | 'shortcuts' | 'downloads' | 'scrobbling' | 'data' | 'system';

export interface MusicHomeSections {
  jumpBackIn: boolean;
  recent: boolean;
  mixes: boolean;
  forYou: boolean;
  playlists: boolean;
  picks: boolean;
}

/** Every typed music setting. Persisted together under `fiesta:music:settings`. */
export interface MusicSettings {
  volume: number;
  muted: boolean;
  playbackRate: number;
  preservesPitch: boolean;
  shuffle: boolean;
  repeat: MusicRepeatMode;
  quality: MusicQualitySetting;
  gapless: boolean;
  crossfadeSeconds: number;
  autoplay: boolean;
  skipUnavailable: boolean;
  replayGainMode: MusicReplayGainMode;
  /** dB, -15..+15. */
  replayGainPreamp: number;
  exponentialVolume: boolean;
  removeSilence: boolean;
  waveformSeekbar: boolean;
  sleepFadeOut: boolean;
  coverClickAction: MusicCoverClickAction;
  closeOverlaysOnNavigate: boolean;
  backClosesOverlays: boolean;
  reduceBlur: boolean;
  dynamicColor: boolean;
  albumBackground: boolean;
  compactGrids: boolean;
  haptics: boolean;
  coverTilt: boolean;
  coverRound: boolean;
  nowPlayingLyrics: boolean;
  homeSections: MusicHomeSections;
  visualizerEnabled: boolean;
  visualizerPreset: string;
  /** Percent of a track before it scrobbles. */
  scrobblePercent: number;
  lastSettingsTab: MusicSettingsTab;
  /** Side panel width in px (320..640). */
  panelWidth: number;
}

export const MUSIC_SETTINGS_DEFAULTS: Readonly<MusicSettings> = Object.freeze({
  volume: 1,
  muted: false,
  playbackRate: 1,
  preservesPitch: true,
  shuffle: false,
  repeat: 'off',
  quality: 'auto',
  gapless: true,
  crossfadeSeconds: 0,
  autoplay: false,
  skipUnavailable: true,
  replayGainMode: 'off',
  replayGainPreamp: 0,
  exponentialVolume: false,
  removeSilence: false,
  waveformSeekbar: false,
  sleepFadeOut: true,
  coverClickAction: 'nowPlaying',
  closeOverlaysOnNavigate: true,
  backClosesOverlays: true,
  reduceBlur: false,
  dynamicColor: true,
  albumBackground: true,
  compactGrids: false,
  haptics: true,
  coverTilt: false,
  coverRound: true,
  nowPlayingLyrics: true,
  homeSections: { jumpBackIn: true, recent: true, mixes: true, forYou: true, playlists: true, picks: true },
  visualizerEnabled: false,
  visualizerPreset: 'particles',
  scrobblePercent: 50,
  lastSettingsTab: 'playback',
  panelWidth: 380,
} satisfies MusicSettings);

/** Allowed values for the enum-like keys; anything else stored is ignored. */
const ENUMS: Partial<Record<keyof MusicSettings, readonly string[]>> = {
  repeat: ['off', 'all', 'one'],
  quality: ['auto', 'LOW', 'HIGH', 'LOSSLESS', 'HI_RES_LOSSLESS'],
  replayGainMode: ['off', 'track', 'album'],
  coverClickAction: ['nowPlaying', 'album'],
  lastSettingsTab: ['playback', 'audio', 'lyrics', 'interface', 'shortcuts', 'downloads', 'scrobbling', 'data', 'system'],
};

/** Numeric ranges; out-of-range stored values are clamped. */
const RANGES: Partial<Record<keyof MusicSettings, [number, number]>> = {
  volume: [0, 1],
  playbackRate: [0.25, 4],
  crossfadeSeconds: [0, 12],
  replayGainPreamp: [-15, 15],
  scrobblePercent: [1, 100],
  panelWidth: [320, 640],
};

const STORAGE_KEY = 'settings';
const WRITE_DELAY = 250;

/** Validates one stored value against its default; undefined means "use the default". */
function sanitize<K extends keyof MusicSettings>(key: K, value: unknown): MusicSettings[K] | undefined {
  const def = MUSIC_SETTINGS_DEFAULTS[key];
  if (value === null || value === undefined) return undefined;
  if (typeof def !== typeof value) return undefined;
  if (typeof def === 'number') {
    if (!Number.isFinite(value as number)) return undefined;
    const r = RANGES[key];
    return (r ? Math.min(r[1], Math.max(r[0], value as number)) : value) as MusicSettings[K];
  }
  const allowed = ENUMS[key];
  if (allowed && !allowed.includes(value as string)) return undefined;
  if (key === 'homeSections') {
    const v = value as Partial<MusicHomeSections>;
    const out = { ...MUSIC_SETTINGS_DEFAULTS.homeSections };
    for (const k of Object.keys(out) as (keyof MusicHomeSections)[]) {
      if (typeof v[k] === 'boolean') out[k] = v[k] as boolean;
    }
    return out as MusicSettings[K];
  }
  return value as MusicSettings[K];
}

/**
 * Music preferences as signals. Each typed key is a WritableSignal: `.set()` /
 * `.update()` persist (debounced) under `fiesta:music:settings`. Packages that
 * need their own persisted state use `scoped(name, default)`.
 */
@Injectable({ providedIn: 'root' })
export class MusicSettingsService {
  private stored = musicStorage.read<Partial<Record<keyof MusicSettings, unknown>>>(STORAGE_KEY, {});
  /** The un-persisting setters, for applying values that came from storage. */
  private raw = new Map<keyof MusicSettings, (v: never) => void>();
  private writeTimer: ReturnType<typeof setTimeout> | null = null;
  private scopes = new Map<string, WritableSignal<unknown>>();

  readonly volume = this.make('volume');
  readonly muted = this.make('muted');
  readonly playbackRate = this.make('playbackRate');
  readonly preservesPitch = this.make('preservesPitch');
  readonly shuffle = this.make('shuffle');
  readonly repeat = this.make('repeat');
  readonly quality = this.make('quality');
  readonly gapless = this.make('gapless');
  readonly crossfadeSeconds = this.make('crossfadeSeconds');
  readonly autoplay = this.make('autoplay');
  readonly skipUnavailable = this.make('skipUnavailable');
  readonly replayGainMode = this.make('replayGainMode');
  readonly replayGainPreamp = this.make('replayGainPreamp');
  readonly exponentialVolume = this.make('exponentialVolume');
  readonly removeSilence = this.make('removeSilence');
  readonly waveformSeekbar = this.make('waveformSeekbar');
  readonly sleepFadeOut = this.make('sleepFadeOut');
  readonly coverClickAction = this.make('coverClickAction');
  readonly closeOverlaysOnNavigate = this.make('closeOverlaysOnNavigate');
  readonly backClosesOverlays = this.make('backClosesOverlays');
  readonly reduceBlur = this.make('reduceBlur');
  readonly dynamicColor = this.make('dynamicColor');
  readonly albumBackground = this.make('albumBackground');
  readonly compactGrids = this.make('compactGrids');
  readonly haptics = this.make('haptics');
  readonly coverTilt = this.make('coverTilt');
  readonly coverRound = this.make('coverRound');
  readonly nowPlayingLyrics = this.make('nowPlayingLyrics');
  readonly homeSections = this.make('homeSections');
  readonly visualizerEnabled = this.make('visualizerEnabled');
  readonly visualizerPreset = this.make('visualizerPreset');
  readonly scrobblePercent = this.make('scrobblePercent');
  readonly lastSettingsTab = this.make('lastSettingsTab');
  readonly panelWidth = this.make('panelWidth');

  constructor() {
    if (typeof window === 'undefined') return;
    // Don't lose the last change to the debounce when the tab goes away.
    window.addEventListener('pagehide', () => this.flush());
    // Another tab changed settings: take its values (without writing back).
    window.addEventListener('storage', (e) => {
      if (e.key === MUSIC_STORAGE_PREFIX + STORAGE_KEY) this.applyStored(musicStorage.read(STORAGE_KEY, {}));
      else if (e.key?.startsWith(MUSIC_STORAGE_PREFIX)) {
        const name = e.key.slice(MUSIC_STORAGE_PREFIX.length);
        const s = this.scopes.get(name) as (WritableSignal<unknown> & { rawSet?: (v: unknown) => void }) | undefined;
        if (s?.rawSet) s.rawSet(musicStorage.read(name, s()));
      }
    });
  }

  /** Every typed setting's current value. */
  snapshot(): MusicSettings {
    const out = {} as Record<keyof MusicSettings, unknown>;
    for (const key of Object.keys(MUSIC_SETTINGS_DEFAULTS) as (keyof MusicSettings)[]) {
      out[key] = (this[key] as WritableSignal<unknown>)();
    }
    return out as unknown as MusicSettings;
  }

  /** Applies (validated) values, e.g. from a settings backup, and persists them. */
  restore(values: Partial<Record<keyof MusicSettings, unknown>>): void {
    this.applyStored(values);
    this.schedule();
  }

  /** Every typed setting back to its default (scoped values are untouched). */
  reset(): void {
    for (const key of Object.keys(MUSIC_SETTINGS_DEFAULTS) as (keyof MusicSettings)[]) {
      this.raw.get(key)?.(structuredCloneSafe(MUSIC_SETTINGS_DEFAULTS[key]) as never);
    }
    this.schedule();
  }

  /**
   * A signal persisted on its own at `fiesta:music:<name>` (written on every
   * set). The same name always returns the same signal. Use `secret:<name>` for
   * credentials (excluded from backups).
   */
  scoped<T>(name: string, fallback: T): WritableSignal<T> {
    const existing = this.scopes.get(name);
    if (existing) return existing as WritableSignal<T>;
    const s = signal<T>(musicStorage.read<T>(name, fallback));
    const rawSet = s.set.bind(s);
    const set = (v: T) => {
      rawSet(v);
      musicStorage.write(name, v);
    };
    Object.assign(s, { set, update: (fn: (v: T) => T) => set(fn(s())), rawSet });
    this.scopes.set(name, s as WritableSignal<unknown>);
    return s;
  }

  /** Writes any pending change now. */
  flush(): void {
    if (this.writeTimer) clearTimeout(this.writeTimer);
    this.writeTimer = null;
    musicStorage.write(STORAGE_KEY, this.snapshot());
  }

  private make<K extends keyof MusicSettings>(key: K): WritableSignal<MusicSettings[K]> {
    const initial = sanitize(key, this.stored[key]) ?? structuredCloneSafe(MUSIC_SETTINGS_DEFAULTS[key]);
    const s = signal<MusicSettings[K]>(initial);
    const rawSet = s.set.bind(s);
    this.raw.set(key, rawSet as (v: never) => void);
    const set = (v: MusicSettings[K]) => {
      const clean = sanitize(key, v);
      if (clean === undefined) return;
      rawSet(clean);
      this.schedule();
    };
    Object.assign(s, { set, update: (fn: (v: MusicSettings[K]) => MusicSettings[K]) => set(fn(s())) });
    return s;
  }

  private applyStored(values: Partial<Record<keyof MusicSettings, unknown>>): void {
    for (const key of Object.keys(MUSIC_SETTINGS_DEFAULTS) as (keyof MusicSettings)[]) {
      if (!(key in values)) continue;
      const v = sanitize(key, values[key]);
      if (v !== undefined) this.raw.get(key)?.(v as never);
    }
  }

  private schedule(): void {
    if (this.writeTimer) clearTimeout(this.writeTimer);
    this.writeTimer = setTimeout(() => this.flush(), WRITE_DELAY);
  }
}

function structuredCloneSafe<T>(v: T): T {
  return v && typeof v === 'object' ? (JSON.parse(JSON.stringify(v)) as T) : v;
}
