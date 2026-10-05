import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { findBestMatch } from '../utils/music-import-match';
import { ImportRow, ParsedImport, parseImportText } from '../utils/music-import-parse';
import { MusicLibraryService } from './music-library.service';
import { MusicAlbum, MusicArtist, MusicLibraryItem, MusicSearchResult, MusicService, MusicTrack } from './music.service';

export const IMPORT_CONCURRENCY = 4;
export const IMPORT_SPACING_MS = 150;
const MAX_FILE_BYTES = 8 * 1024 * 1024;

export interface ImportProgress {
  done: number;
  total: number;
  current: string;
}

export interface ImportMatchResult {
  /** Matched tracks in source order. */
  tracks: MusicTrack[];
  albums: MusicAlbum[];
  artists: MusicArtist[];
  /** Source rows with no acceptable match (or a failed search). */
  missing: ImportRow[];
  cancelled: boolean;
}

export interface ImportCommitResult {
  playlistId: string | null;
  playlistName: string;
  tracksAdded: number;
  favoritesAdded: number;
}

export type ImportMode = 'playlist' | 'library';

const abortError = () => new DOMException('Cancelled', 'AbortError');

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError());
    const t = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(abortError()); };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** An observable as a promise that rejects with AbortError (and unsubscribes) when `signal` aborts. */
function firstValue<T>(source: Observable<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) return reject(abortError());
    const sub = source.subscribe({
      next: (v) => { signal.removeEventListener('abort', onAbort); resolve(v); },
      error: (e) => { signal.removeEventListener('abort', onAbort); reject(e); },
    });
    const onAbort = () => { sub.unsubscribe(); reject(abortError()); };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Reads import files and matches their rows to TIDAL through /api/music?action=search. */
@Injectable({ providedIn: 'root' })
export class MusicImportService {
  private music = inject(MusicService);
  private library = inject(MusicLibraryService);

  /** Reads and parses a picked file. Throws an Error with a user-facing message. */
  async readFile(file: File): Promise<ParsedImport> {
    if (file.size > MAX_FILE_BYTES) throw new Error('That file is too large (8 MB max).');
    const text = await file.text();
    return parseImportText(file.name, text);
  }

  /**
   * Searches the catalogue for every row (4 at a time, 150 ms apart).
   * Rows keep their order. `signal` aborts in-flight searches.
   */
  async match(
    parsed: ParsedImport,
    mode: ImportMode,
    signal: AbortSignal,
    onProgress: (p: ImportProgress) => void,
  ): Promise<ImportMatchResult> {
    const rows = mode === 'playlist' ? parsed.rows.filter((r) => r.type === 'track') : parsed.rows;
    const slots: ({ kind: 'track'; v: MusicTrack } | { kind: 'album'; v: MusicAlbum } | { kind: 'artist'; v: MusicArtist } | null)[] =
      rows.map(() => null);
    let next = 0;
    let done = 0;
    let nextSlot = Date.now();
    const total = rows.length;
    onProgress({ done: 0, total, current: '' });

    const search = (q: string): Promise<MusicSearchResult> => firstValue(this.music.search(q), signal);

    const matchRow = async (row: ImportRow): Promise<(typeof slots)[number]> => {
      if (row.type === 'artist') {
        const r = await search(row.artist);
        const hit = r.artists.find((a) => a.name.toLowerCase() === row.artist.toLowerCase()) ?? r.artists[0];
        return hit ? { kind: 'artist', v: hit } : null;
      }
      if (row.type === 'album') {
        const r = await search(`${row.title} ${row.artist}`.trim());
        const m = findBestAlbum(r.albums, row);
        return m ? { kind: 'album', v: m } : null;
      }
      const q = `${row.title} ${row.artist}`.trim();
      const r = await search(q);
      let m = findBestMatch(r.tracks, row);
      if (!m && row.isrc) {
        const byIsrc = await search(row.isrc);
        m = findBestMatch(byIsrc.tracks, row);
      }
      return m ? { kind: 'track', v: m.track } : null;
    };

    const worker = async () => {
      while (!signal.aborted) {
        const i = next++;
        if (i >= total) return;
        const wait = nextSlot - Date.now();
        nextSlot = Math.max(nextSlot, Date.now()) + IMPORT_SPACING_MS;
        if (wait > 0) await sleep(wait, signal);
        const row = rows[i];
        onProgress({ done, total, current: row.title || row.artist });
        try {
          slots[i] = await matchRow(row);
        } catch (e) {
          if (signal.aborted || (e instanceof DOMException && e.name === 'AbortError')) return;
          slots[i] = null;
        }
        done++;
        onProgress({ done, total, current: row.title || row.artist });
      }
    };

    try {
      await Promise.all(Array.from({ length: Math.min(IMPORT_CONCURRENCY, Math.max(total, 1)) }, worker));
    } catch {
      // aborts surface as `cancelled` below
    }

    const out: ImportMatchResult = { tracks: [], albums: [], artists: [], missing: [], cancelled: signal.aborted };
    const seen = new Set<string>();
    rows.forEach((row, i) => {
      const s = slots[i];
      if (!s) {
        if (!signal.aborted || i < next) out.missing.push(row);
        return;
      }
      const key = s.kind + ':' + s.v.id;
      if (seen.has(key) && mode === 'library') return;
      seen.add(key);
      if (s.kind === 'track') out.tracks.push(s.v);
      else if (s.kind === 'album') out.albums.push(s.v);
      else out.artists.push(s.v);
    });
    return out;
  }

  /** Saves a match result: a new playlist, or add-only favourites. */
  commit(parsed: ParsedImport, name: string, mode: ImportMode, result: ImportMatchResult): ImportCommitResult {
    if (mode === 'playlist') {
      const title = name.trim() || parsed.name || 'Imported playlist';
      const p = this.library.createPlaylist(title, dedupeTracks(result.tracks), parsed.description);
      return { playlistId: p.id, playlistName: p.name, tracksAdded: p.tracks.length, favoritesAdded: 0 };
    }
    const items: MusicLibraryItem[] = [
      ...result.tracks.map((data): MusicLibraryItem => ({ kind: 'track', data })),
      ...result.albums.map((data): MusicLibraryItem => ({ kind: 'album', data })),
      ...result.artists.map((data): MusicLibraryItem => ({ kind: 'artist', data })),
    ];
    return { playlistId: null, playlistName: '', tracksAdded: 0, favoritesAdded: this.library.addFavorites(items) };
  }
}

function dedupeTracks(tracks: MusicTrack[]): MusicTrack[] {
  const seen = new Set<number>();
  return tracks.filter((t) => !seen.has(t.id) && (seen.add(t.id), true));
}

function findBestAlbum(albums: MusicAlbum[], row: ImportRow): MusicAlbum | null {
  const want = row.title.toLowerCase();
  const exact = albums.find((a) => a.title.toLowerCase() === want && (!row.artist || a.artist.toLowerCase().includes(row.artist.toLowerCase().split(/[,&]/)[0].trim())));
  return exact ?? albums[0] ?? null;
}
