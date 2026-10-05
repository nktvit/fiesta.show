import { TestBed } from '@angular/core/testing';
import { Observable, of } from 'rxjs';
import { musicStorage } from '../utils/music-storage';
import { MusicDiscoveryService } from './music-discovery.service';
import { MusicLibraryService } from './music-library.service';
import { interleave, MusicRecommenderService, RADIO_MIN, uniqueTracks } from './music-recommender.service';
import { MusicService, MusicTrack } from './music.service';

const track = (id: number, artistId = 10, extra: Partial<MusicTrack> = {}): MusicTrack => ({
  id, title: 'T' + id, artist: 'A' + artistId, artistId, album: 'Al', albumId: 20, cover: '', duration: 200,
  explicit: false, trackNumber: 1, quality: 'LOSSLESS', ...extra,
});
const range = (from: number, to: number, artistId = 10) => Array.from({ length: to - from + 1 }, (_, i) => track(from + i, artistId));

describe('MusicRecommenderService', () => {
  const clean = () => musicStorage.keys().forEach((k) => musicStorage.remove(k));
  let rec: MusicRecommenderService;
  let library: MusicLibraryService;
  let trackMixCalls: number[];
  let artistMixCalls: number[];
  let mixes: Record<number, MusicTrack[]>;
  let artistMixes: Record<number, MusicTrack[]>;

  beforeEach(() => {
    clean();
    trackMixCalls = [];
    artistMixCalls = [];
    mixes = {};
    artistMixes = {};
    const discovery: Partial<MusicDiscoveryService> = {
      trackMix: (id: number | string): Observable<{ mixId: string; tracks: MusicTrack[] }> => {
        trackMixCalls.push(Number(id));
        return of({ mixId: 'm', tracks: mixes[Number(id)] ?? [] });
      },
      artistMix: (id: number | string): Observable<{ mixId: string; tracks: MusicTrack[] }> => {
        artistMixCalls.push(Number(id));
        return of({ mixId: 'a', tracks: artistMixes[Number(id)] ?? [] });
      },
    };
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: MusicDiscoveryService, useValue: discovery },
        { provide: MusicService, useValue: {} },
      ],
    });
    rec = TestBed.inject(MusicRecommenderService);
    library = TestBed.inject(MusicLibraryService);
  });
  afterEach(clean);

  it('interleave and uniqueTracks', () => {
    expect(interleave([[1, 2, 3], [10, 20]])).toEqual([1, 10, 2, 20, 3]);
    expect(uniqueTracks([track(1), track(2), track(1), track(3)], [3]).map((t) => t.id)).toEqual([1, 2]);
  });

  it('track radio: >= 10 tracks, never the seed or the last 100 played, never blocked', async () => {
    mixes[1] = [track(1), ...range(100, 150)];
    [101, 102, 103].forEach((id) => library.addHistory(track(id)));
    library.block({ kind: 'track', data: track(104) });
    const out = await rec.radioTracks({ kind: 'track', id: 1, label: 'Radio: T1' });
    expect(out.length).toBeGreaterThanOrEqual(RADIO_MIN);
    const ids = out.map((t) => t.id);
    expect(ids).not.toContain(1);
    expect(ids).not.toContain(101);
    expect(ids).not.toContain(102);
    expect(ids).not.toContain(103);
    expect(ids).not.toContain(104);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('track radio: the 100-track ring gives way only when it would leave under 10 tracks', async () => {
    mixes[1] = range(100, 111); // 12 tracks
    range(100, 106).forEach((t) => library.addHistory(t)); // 7 of them were just played
    const out = await rec.radioTracks({ kind: 'track', id: 1, label: 'r' });
    expect(out.length).toBe(RADIO_MIN);
    expect(out.slice(0, 5).every((t) => t.id >= 107)).toBeTrue(); // unplayed ones come first
  });

  it('track radio with no mix falls back to the artist mix', async () => {
    artistMixes[10] = range(200, 215);
    const out = await rec.radioTracks({ kind: 'track', id: 1, label: 'r', tracks: [track(1, 10)] });
    expect(out.length).toBeGreaterThanOrEqual(RADIO_MIN);
    expect(artistMixCalls).toEqual([10]);
  });

  it('artist radio uses the artist mix', async () => {
    artistMixes[7] = range(300, 330, 7);
    const out = await rec.radioTracks({ kind: 'artist', id: 7, label: 'Radio: A7' });
    expect(artistMixCalls).toEqual([7]);
    expect(out.length).toBeGreaterThanOrEqual(RADIO_MIN);
  });

  it('album radio seeds two track mixes from the album and excludes its own tracks', async () => {
    const album = range(1, 6);
    album.forEach((t) => (mixes[t.id] = [...range(400, 420), ...album]));
    const out = await rec.radioTracks({ kind: 'album', id: 5, label: 'Radio: Al', tracks: album });
    expect(trackMixCalls.length).toBe(2);
    expect(out.every((t) => t.id >= 400)).toBeTrue();
    expect(out.length).toBeGreaterThanOrEqual(RADIO_MIN);
  });

  it('refill returns fresh tracks only, honours exclude and limit, in both modes', async () => {
    const seeds = range(1, 3);
    seeds.forEach((t) => (mixes[t.id] = range(500, 540)));
    const exclude = new Set<number>([500, 501, 502]);
    for (const mode of ['radio', 'autoplay'] as const) {
      const out = await rec.refill(seeds, { mode, exclude, limit: 20 });
      expect(out.length).toBe(20);
      expect(out.some((t) => exclude.has(t.id))).toBeFalse();
      expect(out.some((t) => seeds.some((s) => s.id === t.id))).toBeFalse();
    }
  });

  it('refill with nothing to go on returns an empty list (the player then stops)', async () => {
    expect(await rec.refill([], { mode: 'autoplay', exclude: new Set(), limit: 20 })).toEqual([]);
  });

  it('forPlaylist recommends tracks that are not in the playlist', async () => {
    const own = range(1, 4);
    own.forEach((t) => (mixes[t.id] = [...own, ...range(600, 620)]));
    const out = await rec.forPlaylist(own, 10);
    expect(out.length).toBe(10);
    expect(out.every((t) => t.id >= 600)).toBeTrue();
    expect(await rec.forPlaylist([], 10)).toEqual([]);
  });

  it('seeds() are built from favourites, playlists and history, minus blocked', () => {
    library.toggleFavorite({ kind: 'track', data: track(1) });
    library.addHistory(track(2));
    library.addHistory(track(3));
    library.block({ kind: 'track', data: track(3) });
    const ids = rec.seeds().map((t) => t.id);
    expect(ids[0]).toBe(1);
    expect(ids).toContain(2);
    expect(ids).not.toContain(3);
  });
});
