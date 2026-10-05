import { computed, Injectable, signal } from '@angular/core';
import { musicStorage, MUSIC_STORAGE_PREFIX } from '../utils/music-storage';
import {
  MusicAlbum, MusicArtist, MusicLibraryItem, MusicLibraryKind, MusicMix, MusicPlaylist, MusicTrack, UserPlaylist,
} from './music.service';

export type { MusicLibraryItem, MusicLibraryKind, UserPlaylist } from './music.service';

export type Liked<T> = T & { addedAt: number };

export interface MusicFavorites {
  tracks: Liked<MusicTrack>[];
  albums: Liked<MusicAlbum>[];
  artists: Liked<MusicArtist>[];
  playlists: Liked<MusicPlaylist>[];
  mixes: Liked<MusicMix>[];
}

export interface MusicFolder {
  id: string;
  name: string;
  createdAt: number;
}

export interface MusicHistoryEntry {
  track: MusicTrack;
  playedAt: number;
}

export interface MusicBlocked {
  tracks: { id: number; title: string; artist: string }[];
  albums: { id: number; title: string; artist: string }[];
  artists: { id: number; name: string }[];
}

/** Everything the library holds, for backups (P7). */
export interface MusicLibrarySnapshot {
  version: 1;
  favorites: MusicFavorites;
  playlists: UserPlaylist[];
  folders: MusicFolder[];
  pins: MusicLibraryItem[];
  history: MusicHistoryEntry[];
  activity: MusicLibraryItem[];
  searches: string[];
  blocked: MusicBlocked;
}

/** Kinds that can be liked; user playlists are owned, not liked. */
export type MusicFavoriteKind = Exclude<MusicLibraryKind, 'userPlaylist'>;

const KEYS = {
  library: 'library',
  history: 'history',
  searches: 'search-history',
  activity: 'activity',
  blocked: 'blocked',
} as const;

export const MUSIC_PIN_LIMIT = 3;
const HISTORY_CAP = 200;
const ACTIVITY_CAP = 12;
const SEARCH_CAP = 10;

const FAVORITE_LIST: Record<MusicFavoriteKind, keyof MusicFavorites> = {
  track: 'tracks',
  album: 'albums',
  artist: 'artists',
  playlist: 'playlists',
  mix: 'mixes',
};

const emptyFavorites = (): MusicFavorites => ({ tracks: [], albums: [], artists: [], playlists: [], mixes: [] });
const emptyBlocked = (): MusicBlocked => ({ tracks: [], albums: [], artists: [] });

/** Stable id of any library item ("track:123", "playlist:<uuid>"). */
export function musicItemKey(item: MusicLibraryItem): string {
  return `${item.kind}:${musicItemId(item)}`;
}

export function musicItemId(item: MusicLibraryItem): string | number {
  switch (item.kind) {
    case 'playlist': return item.data.uuid;
    default: return item.data.id;
  }
}

function newId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch {
    // insecure context: fall through
  }
  return 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

/** Only the MusicTrack fields, no blobs or UI extras, for storage. */
export function minifyTrack(t: MusicTrack): MusicTrack {
  const out: MusicTrack = {
    id: t.id, title: t.title, artist: t.artist, artistId: t.artistId ?? null, album: t.album, albumId: t.albumId ?? null,
    cover: t.cover && !t.cover.startsWith('data:') ? t.cover : '', duration: t.duration || 0, explicit: !!t.explicit,
    trackNumber: t.trackNumber || 0, quality: t.quality || '',
  };
  if (t.isrc) out.isrc = t.isrc;
  if (t.artists?.length) out.artists = t.artists.map((a) => ({ id: a.id, name: a.name }));
  if (t.version) out.version = t.version;
  if (t.releaseDate) out.releaseDate = t.releaseDate;
  if (typeof t.replayGain === 'number') out.replayGain = t.replayGain;
  if (typeof t.peak === 'number') out.peak = t.peak;
  return out;
}

export function minifyAlbum(a: MusicAlbum): MusicAlbum {
  const out: MusicAlbum = {
    id: a.id, title: a.title, artist: a.artist, cover: a.cover, year: a.year || '', tracks: a.tracks || 0,
    duration: a.duration || 0, quality: a.quality || '',
  };
  if (a.artistId) out.artistId = a.artistId;
  if (a.artists?.length) out.artists = a.artists.map((x) => ({ id: x.id, name: x.name }));
  if (a.type) out.type = a.type;
  if (a.releaseDate) out.releaseDate = a.releaseDate;
  if (a.explicit) out.explicit = true;
  return out;
}

function minifyArtist(a: MusicArtist): MusicArtist {
  return { id: a.id, name: a.name, picture: a.picture || '' };
}

function minifyPlaylist(p: MusicPlaylist): MusicPlaylist {
  return {
    uuid: p.uuid, title: p.title, description: (p.description || '').slice(0, 500), cover: p.cover || '',
    creator: p.creator || '', tracks: p.tracks || 0, duration: p.duration || 0, lastUpdated: p.lastUpdated || '',
  };
}

function minifyMix(m: MusicMix): MusicMix {
  return { id: m.id, title: m.title, subTitle: m.subTitle || '', cover: m.cover || '', type: m.type || '' };
}

/** A storage-safe copy of an item (user playlists keep only their header). */
export function minifyItem(item: MusicLibraryItem): MusicLibraryItem {
  switch (item.kind) {
    case 'track': return { kind: 'track', data: minifyTrack(item.data) };
    case 'album': return { kind: 'album', data: minifyAlbum(item.data) };
    case 'artist': return { kind: 'artist', data: minifyArtist(item.data) };
    case 'playlist': return { kind: 'playlist', data: minifyPlaylist(item.data) };
    case 'mix': return { kind: 'mix', data: minifyMix(item.data) };
    case 'userPlaylist': {
      const p = item.data;
      return {
        kind: 'userPlaylist',
        data: {
          id: p.id, name: p.name, description: p.description, cover: p.cover, tracks: [], createdAt: p.createdAt,
          updatedAt: p.updatedAt, folderId: p.folderId ?? null,
        },
      };
    }
  }
}

interface LibraryFile {
  favorites: MusicFavorites;
  playlists: UserPlaylist[];
  folders: MusicFolder[];
  pins: MusicLibraryItem[];
}

/**
 * The visitor's music library, kept in their browser: likes, playlists and
 * folders, pins, listening history, recent activity, search history and
 * blocked content. Signals for reading; every mutation persists at once.
 * Another tab's changes arrive through the `storage` event.
 */
@Injectable({ providedIn: 'root' })
export class MusicLibraryService {
  private readonly _favorites = signal<MusicFavorites>(emptyFavorites());
  private readonly _playlists = signal<UserPlaylist[]>([]);
  private readonly _folders = signal<MusicFolder[]>([]);
  private readonly _pins = signal<MusicLibraryItem[]>([]);
  private readonly _history = signal<MusicHistoryEntry[]>([]);
  private readonly _activity = signal<MusicLibraryItem[]>([]);
  private readonly _searches = signal<string[]>([]);
  private readonly _blocked = signal<MusicBlocked>(emptyBlocked());
  private favoriteListeners = new Set<(item: MusicLibraryItem, liked: boolean) => void>();

  /** Liked items per kind, newest first, each with `addedAt`. */
  readonly favorites = this._favorites.asReadonly();
  readonly playlists = this._playlists.asReadonly();
  readonly folders = this._folders.asReadonly();
  /** Up to MUSIC_PIN_LIMIT pinned items, in pin order. */
  readonly pins = this._pins.asReadonly();
  /** Played tracks, newest first (cap 200). */
  readonly history = this._history.asReadonly();
  /** Albums/artists/playlists/mixes visited, newest first (cap 12). */
  readonly activity = this._activity.asReadonly();
  /** Recent searches, newest first (cap 10). */
  readonly searches = this._searches.asReadonly();
  readonly blocked = this._blocked.asReadonly();

  private readonly favoriteKeys = computed(() => {
    const f = this._favorites();
    const s = new Set<string>();
    f.tracks.forEach((x) => s.add('track:' + x.id));
    f.albums.forEach((x) => s.add('album:' + x.id));
    f.artists.forEach((x) => s.add('artist:' + x.id));
    f.playlists.forEach((x) => s.add('playlist:' + x.uuid));
    f.mixes.forEach((x) => s.add('mix:' + x.id));
    return s;
  });
  private readonly pinKeys = computed(() => new Set(this._pins().map(musicItemKey)));
  private readonly blockedKeys = computed(() => {
    const b = this._blocked();
    const s = new Set<string>();
    b.tracks.forEach((x) => s.add('track:' + x.id));
    b.albums.forEach((x) => s.add('album:' + x.id));
    b.artists.forEach((x) => s.add('artist:' + x.id));
    return s;
  });

  constructor() {
    this.load();
    if (typeof window !== 'undefined') {
      window.addEventListener('storage', (e) => {
        if (!e.key || e.key.startsWith(MUSIC_STORAGE_PREFIX)) this.load();
      });
    }
  }

  // ── Favourites ────────────────────────────────────────────────────────────

  /** Reactive: reads a computed id set, so templates update on toggles. */
  isFavorite(item: MusicLibraryItem): boolean {
    return item.kind !== 'userPlaylist' && this.favoriteKeys().has(musicItemKey(item));
  }

  /** Likes or unlikes; returns the new state. User playlists can't be liked (returns false). */
  toggleFavorite(item: MusicLibraryItem): boolean {
    if (item.kind === 'userPlaylist') return false;
    const liked = !this.isFavorite(item);
    const list = FAVORITE_LIST[item.kind];
    const key = musicItemKey(item);
    this._favorites.update((f) => {
      const next = { ...f };
      const current = f[list] as { addedAt: number }[];
      if (liked) {
        const entry = { ...(minifyItem(item).data as object), addedAt: Date.now() };
        (next[list] as unknown) = [entry, ...current];
      } else {
        (next[list] as unknown) = current.filter((x) => musicItemKey({ kind: item.kind, data: x } as unknown as MusicLibraryItem) !== key);
      }
      return next;
    });
    this.saveLibrary();
    for (const cb of this.favoriteListeners) {
      try {
        cb(item, liked);
      } catch {
        // a listener's failure must not break the like
      }
    }
    return liked;
  }

  /** Bulk add (imports); never removes. Returns how many were new. */
  addFavorites(items: MusicLibraryItem[]): number {
    let added = 0;
    const now = Date.now();
    const seen = new Set(this.favoriteKeys());
    this._favorites.update((f) => {
      const next: MusicFavorites = { ...f };
      // Walk backwards so items[0] ends up first (newest), as given.
      [...items].reverse().forEach((item, i) => {
        if (item.kind === 'userPlaylist') return;
        const key = musicItemKey(item);
        if (seen.has(key)) return;
        seen.add(key);
        const list = FAVORITE_LIST[item.kind];
        (next[list] as unknown) = [{ ...(minifyItem(item).data as object), addedAt: now + i }, ...(next[list] as object[])];
        added++;
      });
      return next;
    });
    if (added) this.saveLibrary();
    return added;
  }

  /** Called after every like/unlike (scrobblers love-on-like). Returns an unsubscribe. */
  onFavoriteChange(cb: (item: MusicLibraryItem, liked: boolean) => void): () => void {
    this.favoriteListeners.add(cb);
    return () => this.favoriteListeners.delete(cb);
  }

  // ── User playlists and folders ───────────────────────────────────────────

  createPlaylist(name: string, tracks: MusicTrack[] = [], description = ''): UserPlaylist {
    const now = Date.now();
    const p: UserPlaylist = {
      id: newId(),
      name: name.trim() || 'New playlist',
      description,
      tracks: tracks.map((t, i) => ({ ...minifyTrack(t), addedAt: now + i })),
      createdAt: now,
      updatedAt: now,
      folderId: null,
    };
    this._playlists.update((list) => [p, ...list]);
    this.saveLibrary();
    return p;
  }

  playlist(id: string): UserPlaylist | null {
    return this._playlists().find((p) => p.id === id) ?? null;
  }

  updatePlaylist(id: string, patch: Partial<Pick<UserPlaylist, 'name' | 'description' | 'cover' | 'folderId'>>): void {
    this.patchPlaylist(id, (p) => ({ ...p, ...patch }));
  }

  deletePlaylist(id: string): void {
    this._playlists.update((list) => list.filter((p) => p.id !== id));
    this._pins.update((pins) => pins.filter((x) => !(x.kind === 'userPlaylist' && x.data.id === id)));
    this.saveLibrary();
  }

  /** Appends tracks, skipping ones already in the playlist. Returns how many were added. */
  addToPlaylist(id: string, tracks: MusicTrack[]): number {
    let added = 0;
    this.patchPlaylist(id, (p) => {
      const have = new Set(p.tracks.map((t) => t.id));
      const now = Date.now();
      const fresh = tracks.filter((t) => !have.has(t.id) && (have.add(t.id), true));
      added = fresh.length;
      return { ...p, tracks: [...p.tracks, ...fresh.map((t, i) => ({ ...minifyTrack(t), addedAt: now + i }))] };
    });
    return added;
  }

  removeFromPlaylist(id: string, index: number): void {
    this.patchPlaylist(id, (p) => ({ ...p, tracks: p.tracks.filter((_, i) => i !== index) }));
  }

  movePlaylistTrack(id: string, from: number, to: number): void {
    this.patchPlaylist(id, (p) => {
      if (from < 0 || from >= p.tracks.length || to < 0 || to >= p.tracks.length || from === to) return p;
      const tracks = [...p.tracks];
      const [t] = tracks.splice(from, 1);
      tracks.splice(to, 0, t);
      return { ...p, tracks };
    });
  }

  createFolder(name: string): MusicFolder {
    const f: MusicFolder = { id: newId(), name: name.trim() || 'New folder', createdAt: Date.now() };
    this._folders.update((list) => [...list, f]);
    this.saveLibrary();
    return f;
  }

  renameFolder(id: string, name: string): void {
    this._folders.update((list) => list.map((f) => (f.id === id ? { ...f, name: name.trim() || f.name } : f)));
    this.saveLibrary();
  }

  /** Deletes the folder; its playlists move back to the root. */
  deleteFolder(id: string): void {
    this._folders.update((list) => list.filter((f) => f.id !== id));
    this._playlists.update((list) => list.map((p) => (p.folderId === id ? { ...p, folderId: null } : p)));
    this.saveLibrary();
  }

  movePlaylistToFolder(playlistId: string, folderId: string | null): void {
    if (folderId && !this._folders().some((f) => f.id === folderId)) return;
    this.patchPlaylist(playlistId, (p) => ({ ...p, folderId }));
  }

  // ── Pins ─────────────────────────────────────────────────────────────────

  isPinned(item: MusicLibraryItem): boolean {
    return this.pinKeys().has(musicItemKey(item));
  }

  /**
   * Pins or unpins; returns the new state. When MUSIC_PIN_LIMIT items are
   * already pinned, pinning another does nothing and returns false.
   */
  togglePin(item: MusicLibraryItem): boolean {
    const key = musicItemKey(item);
    if (this.isPinned(item)) {
      this._pins.update((p) => p.filter((x) => musicItemKey(x) !== key));
      this.saveLibrary();
      return false;
    }
    if (this._pins().length >= MUSIC_PIN_LIMIT) return false;
    this._pins.update((p) => [...p, minifyItem(item)]);
    this.saveLibrary();
    return true;
  }

  // ── History ──────────────────────────────────────────────────────────────

  addHistory(track: MusicTrack): void {
    this._history.update((h) => {
      const last = h[0]?.playedAt ?? 0;
      // Strictly increasing, so two plays in the same millisecond still sort.
      const playedAt = Math.max(Date.now(), last + 1);
      return [{ track: minifyTrack(track), playedAt }, ...h].slice(0, HISTORY_CAP);
    });
    musicStorage.write(KEYS.history, this._history());
  }

  clearHistory(): void {
    this._history.set([]);
    musicStorage.write(KEYS.history, []);
  }

  // ── Recent activity ("Jump back in") ─────────────────────────────────────

  recordActivity(item: MusicLibraryItem): void {
    const key = musicItemKey(item);
    this._activity.update((a) => [minifyItem(item), ...a.filter((x) => musicItemKey(x) !== key)].slice(0, ACTIVITY_CAP));
    musicStorage.write(KEYS.activity, this._activity());
  }

  // ── Search history ───────────────────────────────────────────────────────

  addSearch(q: string): void {
    const text = q.trim().slice(0, 200);
    if (!text) return;
    const low = text.toLowerCase();
    this._searches.update((s) => [text, ...s.filter((x) => x.toLowerCase() !== low)].slice(0, SEARCH_CAP));
    musicStorage.write(KEYS.searches, this._searches());
  }

  removeSearch(q: string): void {
    this._searches.update((s) => s.filter((x) => x !== q));
    musicStorage.write(KEYS.searches, this._searches());
  }

  clearSearches(): void {
    this._searches.set([]);
    musicStorage.write(KEYS.searches, []);
  }

  // ── Blocking ─────────────────────────────────────────────────────────────

  /** Hides a track, album or artist everywhere (other kinds are ignored). */
  block(item: MusicLibraryItem): void {
    if (this.blockedKeys().has(musicItemKey(item))) return;
    this._blocked.update((b) => {
      switch (item.kind) {
        case 'track':
          return { ...b, tracks: [{ id: item.data.id, title: item.data.title, artist: item.data.artist }, ...b.tracks] };
        case 'album':
          return { ...b, albums: [{ id: item.data.id, title: item.data.title, artist: item.data.artist }, ...b.albums] };
        case 'artist':
          return { ...b, artists: [{ id: item.data.id, name: item.data.name }, ...b.artists] };
        default:
          return b;
      }
    });
    musicStorage.write(KEYS.blocked, this._blocked());
  }

  unblock(kind: 'track' | 'album' | 'artist', id: number): void {
    this._blocked.update((b) => ({
      tracks: kind === 'track' ? b.tracks.filter((x) => x.id !== id) : b.tracks,
      albums: kind === 'album' ? b.albums.filter((x) => x.id !== id) : b.albums,
      artists: kind === 'artist' ? b.artists.filter((x) => x.id !== id) : b.artists,
    }));
    musicStorage.write(KEYS.blocked, this._blocked());
  }

  /**
   * Reactive. A track is blocked when it, its album or any of its artists is;
   * an album when it or its artist is. Accepts a bare MusicTrack too.
   */
  isBlocked(itemOrTrack: MusicLibraryItem | MusicTrack): boolean {
    const keys = this.blockedKeys();
    if (!keys.size) return false;
    const item: MusicLibraryItem = 'kind' in itemOrTrack ? itemOrTrack : { kind: 'track', data: itemOrTrack };
    switch (item.kind) {
      case 'track': {
        const t = item.data;
        return keys.has('track:' + t.id) || (t.albumId !== null && keys.has('album:' + t.albumId))
          || (t.artistId !== null && keys.has('artist:' + t.artistId)) || !!t.artists?.some((a) => keys.has('artist:' + a.id));
      }
      case 'album': {
        const a = item.data;
        return keys.has('album:' + a.id) || (!!a.artistId && keys.has('artist:' + a.artistId))
          || !!a.artists?.some((x) => keys.has('artist:' + x.id));
      }
      case 'artist':
        return keys.has('artist:' + item.data.id);
      default:
        return false;
    }
  }

  // ── Backup ───────────────────────────────────────────────────────────────

  snapshot(): MusicLibrarySnapshot {
    return JSON.parse(JSON.stringify({
      version: 1,
      favorites: this._favorites(),
      playlists: this._playlists(),
      folders: this._folders(),
      pins: this._pins(),
      history: this._history(),
      activity: this._activity(),
      searches: this._searches(),
      blocked: this._blocked(),
    })) as MusicLibrarySnapshot;
  }

  /**
   * Loads a snapshot. 'replace' swaps everything; 'merge' (the default for
   * backups) unions by id, keeping the newer copy of a playlist.
   */
  restore(snap: Partial<MusicLibrarySnapshot>, mode: 'merge' | 'replace'): void {
    const fav = { ...emptyFavorites(), ...(snap.favorites ?? {}) } as MusicFavorites;
    const blocked = { ...emptyBlocked(), ...(snap.blocked ?? {}) } as MusicBlocked;
    if (mode === 'replace') {
      this._favorites.set(fav);
      this._playlists.set(snap.playlists ?? []);
      this._folders.set(snap.folders ?? []);
      this._pins.set((snap.pins ?? []).slice(0, MUSIC_PIN_LIMIT));
      this._history.set((snap.history ?? []).slice(0, HISTORY_CAP));
      this._activity.set((snap.activity ?? []).slice(0, ACTIVITY_CAP));
      this._searches.set((snap.searches ?? []).slice(0, SEARCH_CAP));
      this._blocked.set(blocked);
    } else {
      const byKey = <T>(a: T[], b: T[], key: (x: T) => string) => {
        const seen = new Set(a.map(key));
        return [...a, ...b.filter((x) => !seen.has(key(x)) && (seen.add(key(x)), true))];
      };
      const cur = this._favorites();
      this._favorites.set({
        tracks: byKey(cur.tracks, fav.tracks, (x) => String(x.id)).sort((a, b) => b.addedAt - a.addedAt),
        albums: byKey(cur.albums, fav.albums, (x) => String(x.id)).sort((a, b) => b.addedAt - a.addedAt),
        artists: byKey(cur.artists, fav.artists, (x) => String(x.id)).sort((a, b) => b.addedAt - a.addedAt),
        playlists: byKey(cur.playlists, fav.playlists, (x) => x.uuid).sort((a, b) => b.addedAt - a.addedAt),
        mixes: byKey(cur.mixes, fav.mixes, (x) => x.id).sort((a, b) => b.addedAt - a.addedAt),
      });
      const playlists = new Map(this._playlists().map((p) => [p.id, p]));
      for (const p of snap.playlists ?? []) {
        const have = playlists.get(p.id);
        if (!have || (p.updatedAt ?? 0) > (have.updatedAt ?? 0)) playlists.set(p.id, p);
      }
      this._playlists.set([...playlists.values()].sort((a, b) => b.createdAt - a.createdAt));
      this._folders.set(byKey(this._folders(), snap.folders ?? [], (f) => f.id));
      this._pins.set(byKey(this._pins(), snap.pins ?? [], musicItemKey).slice(0, MUSIC_PIN_LIMIT));
      this._history.set(
        byKey(this._history(), snap.history ?? [], (h) => h.track.id + '@' + h.playedAt)
          .sort((a, b) => b.playedAt - a.playedAt).slice(0, HISTORY_CAP),
      );
      this._activity.set(byKey(this._activity(), snap.activity ?? [], musicItemKey).slice(0, ACTIVITY_CAP));
      this._searches.set(byKey(this._searches(), snap.searches ?? [], (s) => s.toLowerCase()).slice(0, SEARCH_CAP));
      const b = this._blocked();
      this._blocked.set({
        tracks: byKey(b.tracks, blocked.tracks, (x) => String(x.id)),
        albums: byKey(b.albums, blocked.albums, (x) => String(x.id)),
        artists: byKey(b.artists, blocked.artists, (x) => String(x.id)),
      });
    }
    this.saveAll();
  }

  /** Re-reads everything from storage (another tab changed it, or a reset). */
  load(): void {
    const lib = musicStorage.read<Partial<LibraryFile>>(KEYS.library, {});
    const fav = lib.favorites ?? emptyFavorites();
    this._favorites.set({
      tracks: arr(fav.tracks), albums: arr(fav.albums), artists: arr(fav.artists),
      playlists: arr(fav.playlists), mixes: arr(fav.mixes),
    });
    this._playlists.set(arr(lib.playlists));
    this._folders.set(arr(lib.folders));
    this._pins.set(arr(lib.pins).slice(0, MUSIC_PIN_LIMIT));
    this._history.set(arr(musicStorage.read<MusicHistoryEntry[]>(KEYS.history, [])));
    this._activity.set(arr(musicStorage.read<MusicLibraryItem[]>(KEYS.activity, [])));
    this._searches.set(arr(musicStorage.read<string[]>(KEYS.searches, [])).filter((s) => typeof s === 'string'));
    const b = musicStorage.read<Partial<MusicBlocked>>(KEYS.blocked, {});
    this._blocked.set({ tracks: arr(b.tracks), albums: arr(b.albums), artists: arr(b.artists) });
  }

  private patchPlaylist(id: string, fn: (p: UserPlaylist) => UserPlaylist): void {
    let changed = false;
    this._playlists.update((list) =>
      list.map((p) => {
        if (p.id !== id) return p;
        const next = fn(p);
        if (next === p) return p;
        changed = true;
        return { ...next, updatedAt: Math.max(Date.now(), p.updatedAt + 1) };
      }),
    );
    if (changed) this.saveLibrary();
  }

  private saveLibrary(): void {
    const file: LibraryFile = {
      favorites: this._favorites(),
      playlists: this._playlists(),
      folders: this._folders(),
      pins: this._pins(),
    };
    musicStorage.write(KEYS.library, file);
  }

  private saveAll(): void {
    this.saveLibrary();
    musicStorage.write(KEYS.history, this._history());
    musicStorage.write(KEYS.activity, this._activity());
    musicStorage.write(KEYS.searches, this._searches());
    musicStorage.write(KEYS.blocked, this._blocked());
  }
}

function arr<T>(v: T[] | undefined | null): T[] {
  return Array.isArray(v) ? v : [];
}

/** Helper for templates/menus: the favourites list a kind lives in. */
export function favoriteListFor(kind: MusicFavoriteKind): keyof MusicFavorites {
  return FAVORITE_LIST[kind];
}
