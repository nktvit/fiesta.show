// Ported from Monochrome (Apache-2.0), js/ui.js sortTracks - adapted for Fiesta.
import { MusicHistoryEntry } from '../services/music-library.service';
import { MusicTrack } from '../services/music.service';

export type MusicTrackSort = 'added' | 'title' | 'artist' | 'album' | 'duration' | 'custom';

export const MUSIC_TRACK_SORTS: { value: MusicTrackSort; label: string }[] = [
  { value: 'added', label: 'Recently added' },
  { value: 'title', label: 'Title' },
  { value: 'artist', label: 'Artist' },
  { value: 'album', label: 'Album' },
  { value: 'duration', label: 'Duration' },
];

type Sortable = MusicTrack & { addedAt?: number };

const collator = typeof Intl !== 'undefined' ? new Intl.Collator(undefined, { sensitivity: 'base', numeric: true }) : null;
const cmp = (a: string, b: string): number => (collator ? collator.compare(a ?? '', b ?? '') : (a ?? '').localeCompare(b ?? ''));

/**
 * A sorted copy. 'added' is newest first (needs addedAt; stable on ties),
 * 'custom' keeps the given order, text sorts are case/locale-insensitive,
 * 'duration' is shortest first. Never mutates the input.
 */
export function sortTracks<T extends Sortable>(tracks: readonly T[], mode: MusicTrackSort): T[] {
  const list = [...tracks];
  switch (mode) {
    case 'added':
      return list
        .map((t, i) => ({ t, i }))
        .sort((a, b) => (b.t.addedAt ?? 0) - (a.t.addedAt ?? 0) || a.i - b.i)
        .map((x) => x.t);
    case 'title':
      return list.sort((a, b) => cmp(a.title, b.title));
    case 'artist':
      return list.sort((a, b) => cmp(a.artist, b.artist) || cmp(a.album, b.album) || cmp(a.title, b.title));
    case 'album':
      return list.sort((a, b) => cmp(a.album, b.album) || cmp(a.title, b.title));
    case 'duration':
      return list.sort((a, b) => (a.duration || 0) - (b.duration || 0));
    default:
      return list;
  }
}

/** Case-insensitive match on title, artist or album. Empty query returns the input. */
export function filterTracks<T extends MusicTrack>(tracks: readonly T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...tracks];
  return tracks.filter((t) => `${t.title} ${t.artist} ${t.album}`.toLowerCase().includes(q));
}

/** Case-insensitive name match for albums/artists/playlists/mixes. */
export function filterByName<T>(items: readonly T[], query: string, text: (x: T) => string): T[] {
  const q = query.trim().toLowerCase();
  return q ? items.filter((x) => text(x).toLowerCase().includes(q)) : [...items];
}

/** Up to `n` distinct, non-empty cover URLs in track order. */
export function distinctCovers(tracks: readonly { cover?: string }[], n = 4): string[] {
  const out: string[] = [];
  for (const t of tracks) {
    if (t.cover && !out.includes(t.cover)) out.push(t.cover);
    if (out.length >= n) break;
  }
  return out;
}

export interface HistoryGroup {
  label: 'Today' | 'Yesterday' | 'Earlier';
  entries: MusicHistoryEntry[];
}

const startOfDay = (ms: number): number => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** History (newest first) grouped Today / Yesterday / Earlier; empty groups are dropped. */
export function groupHistory(entries: readonly MusicHistoryEntry[], now: number = Date.now()): HistoryGroup[] {
  const today = startOfDay(now);
  const yesterday = startOfDay(today - 12 * 3600 * 1000);
  const groups: HistoryGroup[] = [
    { label: 'Today', entries: [] },
    { label: 'Yesterday', entries: [] },
    { label: 'Earlier', entries: [] },
  ];
  for (const e of entries) {
    const g = e.playedAt >= today ? 0 : e.playedAt >= yesterday ? 1 : 2;
    groups[g].entries.push(e);
  }
  return groups.filter((g) => g.entries.length);
}

/** Sum of durations in seconds. */
export function totalDuration(tracks: readonly { duration: number }[]): number {
  return tracks.reduce((s, t) => s + (Number.isFinite(t.duration) ? t.duration : 0), 0);
}
