// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
// Derived from @uimaxbai/am-lyrics src/AmLyrics.ts - adapted for Fiesta.
import { Injectable, inject } from '@angular/core';
import { lyricsCacheGet, lyricsCachePut } from '../utils/music-lyrics-cache';
import { defaultLyricsLanguage } from '../utils/music-lyrics-languages';
import { isSynced, isWordSynced, toLRC, toPlain, toTTML } from '../utils/music-lyrics-lrc';
import { lyricsQueryFor } from '../utils/music-lyrics-meta';
import {
  createLyricsCtx,
  fetchLyricsCascade,
  MUSIC_LYRICS_PROVIDERS,
  MusicLyricsProviderId,
  MusicLyricsSourceResult,
} from '../utils/music-lyrics-providers';
import type { MusicLrcMeta, MusicLyrics } from '../utils/music-lyrics-types';
import { MusicSettingsService } from './music-settings.service';
import { MusicTrack } from './music.service';

export type { MusicLyricLine, MusicLyricSyllable, MusicLyrics } from '../utils/music-lyrics-types';

/** Lyrics preferences, persisted at `fiesta:music:lyrics`. */
export interface MusicLyricsPrefs {
  /** Per provider; the owner's own files are always checked first. */
  providers: Record<Exclude<MusicLyricsProviderId, 'owner'>, boolean>;
  romanize: boolean;
  translate: boolean;
  targetLang: string;
  blur: boolean;
  hidePlayed: boolean;
  karaoke: boolean;
}

export function defaultLyricsPrefs(): MusicLyricsPrefs {
  return {
    providers: { lrcred: true, bini: true, unison: true, lyricsplus: true, lrclib: true, genius: true },
    romanize: false,
    translate: false,
    targetLang: defaultLyricsLanguage(),
    blur: true,
    hidePlayed: false,
    karaoke: true,
  };
}

/** Stored values merged over the defaults; anything of the wrong type is ignored. */
export function sanitizeLyricsPrefs(raw: unknown): MusicLyricsPrefs {
  const base = defaultLyricsPrefs();
  if (typeof raw !== 'object' || raw === null) return base;
  const r = raw as Record<string, unknown>;
  const providers = typeof r['providers'] === 'object' && r['providers'] !== null ? (r['providers'] as Record<string, unknown>) : {};
  for (const p of MUSIC_LYRICS_PROVIDERS) {
    const v = providers[p.id];
    if (typeof v === 'boolean') base.providers[p.id as keyof MusicLyricsPrefs['providers']] = v;
  }
  for (const k of ['romanize', 'translate', 'blur', 'hidePlayed', 'karaoke'] as const) {
    if (typeof r[k] === 'boolean') base[k] = r[k] as boolean;
  }
  if (typeof r['targetLang'] === 'string' && /^[A-Za-z]{2,3}(-[A-Za-z]{2,4})?$/.test(r['targetLang'])) base.targetLang = r['targetLang'];
  return base;
}

/** What a lookup produced, with what the footer needs. */
export interface MusicLyricsLookup {
  lyrics: MusicLyrics | null;
  /** Source names available to cycle through, best first. */
  sources: string[];
  /** Index of `lyrics` in `sources`. */
  sourceIndex: number;
  /** Every provider was asked; no more sources will appear. */
  complete: boolean;
  /** Providers that were asked (for the "No lyrics found" note). */
  tried: string[];
  /** No provider could be reached at all. */
  failed: boolean;
}

interface CachedIndex {
  labels: string[];
  complete: boolean;
  tried: string[];
}

const EMPTY: MusicLyricsLookup = { lyrics: null, sources: [], sourceIndex: 0, complete: false, tried: [], failed: false };

/** Lyrics provider cascade, cache and export. Owned by package P3. */
@Injectable({ providedIn: 'root' })
export class MusicLyricsService {
  private readonly settings = inject(MusicSettingsService);

  /** Persisted preferences (one signal; use `setPrefs` to change part of it). */
  readonly prefs = this.settings.scoped<MusicLyricsPrefs>('lyrics', defaultLyricsPrefs());

  /** Replaced in tests. */
  protected fetchFn: typeof fetch = (...a) => fetch(...a);

  /** Current preferences, validated. */
  currentPrefs(): MusicLyricsPrefs {
    return sanitizeLyricsPrefs(this.prefs());
  }

  /** Merge `patch` into the stored preferences. */
  setPrefs(patch: Partial<Omit<MusicLyricsPrefs, 'providers'>> & { providers?: Partial<MusicLyricsPrefs['providers']> }): void {
    const cur = this.currentPrefs();
    this.prefs.set({ ...cur, ...patch, providers: { ...cur.providers, ...patch.providers } });
  }

  /** Lyrics for `track` from the provider cascade (`sourceIndex` picks another result), or null. */
  async fetch(track: MusicTrack, opts?: { signal?: AbortSignal; sourceIndex?: number }): Promise<MusicLyrics | null> {
    return (await this.lookup(track, opts)).lyrics;
  }

  /**
   * Like `fetch`, plus the source list and failure info. Results are cached in
   * IndexedDB for 7 days. A `sourceIndex` above 0 asks every provider (once) so
   * "Switch source" has something to cycle through. Throws an AbortError when
   * `opts.signal` aborts.
   */
  async lookup(track: MusicTrack, opts?: { signal?: AbortSignal; sourceIndex?: number }): Promise<MusicLyricsLookup> {
    const signal = opts?.signal;
    const want = Math.max(0, opts?.sourceIndex ?? 0);
    const enabled = this.currentPrefs().providers;
    const sig = MUSIC_LYRICS_PROVIDERS.map((p) => (enabled[p.id as keyof typeof enabled] ? '1' : '0')).join('');
    const indexKey = `${track.id}:index:${sig}`;
    const entryKey = (label: string) => `${track.id}:${sig}:${label}`;

    const cachedIndex = await lyricsCacheGet<CachedIndex>(indexKey);
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    if (cachedIndex && cachedIndex.labels.length > 0 && (want === 0 || cachedIndex.complete)) {
      const idx = want % cachedIndex.labels.length;
      const hit = await lyricsCacheGet<MusicLyrics>(entryKey(cachedIndex.labels[idx]));
      if (hit) {
        return { lyrics: hit, sources: cachedIndex.labels, sourceIndex: idx, complete: cachedIndex.complete, tried: cachedIndex.tried, failed: false };
      }
    }

    const ctx = createLyricsCtx({ signal, fetchFn: (...a) => this.fetchFn(...a) });
    const cascade = await fetchLyricsCascade(lyricsQueryFor(track), ctx, { enabled, mode: want > 0 ? 'all' : 'first' });
    if (cascade.sources.length === 0) return { ...EMPTY, tried: cascade.tried, failed: cascade.failed, complete: cascade.complete };

    const all = cascade.sources.map((s) => this.toLyrics(track.id, s));
    const labels = all.map((l) => l.source);
    await Promise.all([
      ...all.map((l) => lyricsCachePut(entryKey(l.source), l)),
      lyricsCachePut(indexKey, { labels, complete: cascade.complete, tried: cascade.tried } satisfies CachedIndex),
    ]);
    const idx = want % all.length;
    return { lyrics: all[idx], sources: labels, sourceIndex: idx, complete: cascade.complete, tried: cascade.tried, failed: false };
  }

  private toLyrics(trackId: number, s: MusicLyricsSourceResult): MusicLyrics {
    return {
      trackId,
      source: s.source,
      synced: isSynced(s.lines),
      wordSynced: isWordSynced(s.lines),
      lines: s.lines,
      songwriters: s.songwriters,
    };
  }

  toLRC(l: MusicLyrics, meta?: MusicLrcMeta): string {
    return toLRC(l.lines, { re: l.source, ...meta });
  }

  toTTML(l: MusicLyrics): string {
    return toTTML(l.lines, { songwriters: l.songwriters });
  }

  toPlain(l: MusicLyrics): string {
    return toPlain(l.lines);
  }
}
