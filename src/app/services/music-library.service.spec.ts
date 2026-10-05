import { TestBed } from '@angular/core/testing';
import { musicStorage } from '../utils/music-storage';
import { MUSIC_PIN_LIMIT, MusicLibraryService } from './music-library.service';
import { MusicAlbum, MusicLibraryItem, MusicTrack } from './music.service';

const track = (id: number, extra: Partial<MusicTrack> = {}): MusicTrack => ({
  id, title: 'T' + id, artist: 'A', artistId: 10, album: 'Al', albumId: 20, cover: '', duration: 100,
  explicit: false, trackNumber: 1, quality: 'LOSSLESS', ...extra,
});
const album = (id: number): MusicAlbum => ({
  id, title: 'Album' + id, artist: 'A', cover: '', year: '2001', tracks: 10, duration: 1000, quality: '',
});
const t = (id: number, extra: Partial<MusicTrack> = {}): MusicLibraryItem => ({ kind: 'track', data: track(id, extra) });

describe('MusicLibraryService', () => {
  const clean = () => musicStorage.keys().forEach((k) => musicStorage.remove(k));
  let lib: MusicLibraryService;
  beforeEach(() => {
    clean();
    TestBed.resetTestingModule();
    lib = TestBed.inject(MusicLibraryService);
  });
  afterEach(clean);

  it('toggleFavorite persists and isFavorite is reactive', () => {
    expect(lib.isFavorite(t(1))).toBeFalse();
    const seen: boolean[] = [];
    const off = lib.onFavoriteChange((_, liked) => seen.push(liked));
    expect(lib.toggleFavorite(t(1))).toBeTrue();
    expect(lib.isFavorite(t(1))).toBeTrue();
    expect(lib.favorites().tracks[0].id).toBe(1);
    expect(lib.favorites().tracks[0].addedAt).toBeGreaterThan(0);
    const stored = musicStorage.read<{ favorites: { tracks: { id: number }[] } }>('library', { favorites: { tracks: [] } });
    expect(stored.favorites.tracks.map((x) => x.id)).toEqual([1]);
    expect(lib.toggleFavorite(t(1))).toBeFalse();
    expect(lib.isFavorite(t(1))).toBeFalse();
    expect(seen).toEqual([true, false]);
    off();
  });

  it('likes albums too, newest first; addFavorites is add-only', () => {
    lib.toggleFavorite({ kind: 'album', data: album(5) });
    expect(lib.addFavorites([t(1), t(2), { kind: 'album', data: album(5) }])).toBe(2);
    expect(lib.favorites().tracks.map((x) => x.id)).toEqual([1, 2]);
    expect(lib.favorites().albums.length).toBe(1);
  });

  it('stores minified copies', () => {
    lib.toggleFavorite(t(3, { cover: 'data:image/png;base64,AAAA' }));
    const fav = lib.favorites().tracks[0] as unknown as Record<string, unknown>;
    expect(fav['cover']).toBe('');
  });

  it('playlists: create, add (skipping duplicates), move, remove, delete', () => {
    const p = lib.createPlaylist('Mine', [track(1)]);
    expect(lib.playlists()[0].id).toBe(p.id);
    expect(lib.addToPlaylist(p.id, [track(1), track(2), track(3)])).toBe(2);
    lib.movePlaylistTrack(p.id, 2, 0);
    expect(lib.playlist(p.id)!.tracks.map((x) => x.id)).toEqual([3, 1, 2]);
    lib.removeFromPlaylist(p.id, 1);
    expect(lib.playlist(p.id)!.tracks.map((x) => x.id)).toEqual([3, 2]);
    lib.updatePlaylist(p.id, { name: 'Renamed' });
    expect(lib.playlist(p.id)!.name).toBe('Renamed');
    lib.deletePlaylist(p.id);
    expect(lib.playlists().length).toBe(0);
  });

  it('folders: deleting one moves its playlists to the root', () => {
    const p = lib.createPlaylist('P');
    const f = lib.createFolder('F');
    lib.movePlaylistToFolder(p.id, f.id);
    expect(lib.playlist(p.id)!.folderId).toBe(f.id);
    lib.renameFolder(f.id, 'G');
    expect(lib.folders()[0].name).toBe('G');
    lib.deleteFolder(f.id);
    expect(lib.playlist(p.id)!.folderId).toBeNull();
  });

  it('pins: max 3', () => {
    for (let i = 1; i <= MUSIC_PIN_LIMIT; i++) expect(lib.togglePin(t(i))).toBeTrue();
    expect(lib.togglePin(t(99))).toBeFalse();
    expect(lib.pins().length).toBe(3);
    expect(lib.isPinned(t(2))).toBeTrue();
    expect(lib.togglePin(t(2))).toBeFalse();
    expect(lib.isPinned(t(2))).toBeFalse();
  });

  it('history: newest first, strictly increasing, capped at 200', () => {
    for (let i = 0; i < 205; i++) lib.addHistory(track(i));
    const h = lib.history();
    expect(h.length).toBe(200);
    expect(h[0].track.id).toBe(204);
    expect(h[0].playedAt).toBeGreaterThan(h[1].playedAt);
    lib.clearHistory();
    expect(lib.history().length).toBe(0);
  });

  it('activity dedupes (cap 12); searches dedupe case-insensitively (cap 10)', () => {
    lib.recordActivity({ kind: 'album', data: album(1) });
    lib.recordActivity({ kind: 'album', data: album(2) });
    lib.recordActivity({ kind: 'album', data: album(1) });
    expect(lib.activity().map((x) => (x.data as MusicAlbum).id)).toEqual([1, 2]);
    for (let i = 0; i < 12; i++) lib.addSearch('q' + i);
    lib.addSearch('Q11');
    expect(lib.searches().length).toBe(10);
    expect(lib.searches()[0]).toBe('Q11');
    lib.removeSearch('Q11');
    expect(lib.searches()[0]).toBe('q10');
  });

  it('blocking: a track is blocked by its id, album or artist', () => {
    expect(lib.isBlocked(track(1))).toBeFalse();
    lib.block({ kind: 'artist', data: { id: 10, name: 'A', picture: '' } });
    expect(lib.isBlocked(track(1))).toBeTrue();
    expect(lib.isBlocked(t(1))).toBeTrue();
    lib.unblock('artist', 10);
    expect(lib.isBlocked(track(1))).toBeFalse();
    lib.block({ kind: 'album', data: album(20) });
    expect(lib.isBlocked(track(2))).toBeTrue();
    lib.unblock('album', 20);
    lib.block(t(7));
    expect(lib.isBlocked(track(7))).toBeTrue();
    expect(lib.isBlocked(track(8))).toBeFalse();
  });

  it('snapshot/restore: replace and merge', () => {
    lib.toggleFavorite(t(1));
    const snap = lib.snapshot();
    lib.toggleFavorite(t(1));
    lib.toggleFavorite(t(2));
    lib.restore(snap, 'merge');
    expect(lib.favorites().tracks.map((x) => x.id).sort()).toEqual([1, 2]);
    lib.restore(snap, 'replace');
    expect(lib.favorites().tracks.map((x) => x.id)).toEqual([1]);
  });

  it('reloads from storage (another tab)', () => {
    lib.toggleFavorite(t(1));
    const other = new MusicLibraryService();
    expect(other.isFavorite(t(1))).toBeTrue();
  });
});
