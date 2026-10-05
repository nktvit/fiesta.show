import { TestBed } from '@angular/core/testing';
import { musicStorage } from '../utils/music-storage';
import { MusicListeningTrackerService } from './music-listening-tracker.service';
import { MusicPlayerEvents, MusicPlayerService } from './music-player.service';
import { MusicTrack } from './music.service';

const track = (id: number, artistId = 10): MusicTrack => ({
  id, title: 'T' + id, artist: 'A' + artistId, artistId, album: 'Al', albumId: 20, cover: '', duration: 200,
  explicit: false, trackNumber: 1, quality: 'LOSSLESS',
});

/** The slice of the player the tracker uses: on(). */
class FakePlayer {
  handlers = new Map<string, ((e: never) => void)[]>();
  on<K extends keyof MusicPlayerEvents>(type: K, cb: (e: MusicPlayerEvents[K]) => void): () => void {
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), cb as (e: never) => void]);
    return () => undefined;
  }
  emit<K extends keyof MusicPlayerEvents>(type: K, e: MusicPlayerEvents[K]): void {
    (this.handlers.get(type) ?? []).forEach((h) => (h as (x: MusicPlayerEvents[K]) => void)(e));
  }
}

describe('MusicListeningTrackerService', () => {
  const clean = () => musicStorage.keys().forEach((k) => musicStorage.remove(k));
  let svc: MusicListeningTrackerService;
  let player: FakePlayer;

  beforeEach(() => {
    clean();
    TestBed.resetTestingModule();
    player = new FakePlayer();
    TestBed.configureTestingModule({ providers: [{ provide: MusicPlayerService, useValue: player }] });
    svc = TestBed.inject(MusicListeningTrackerService);
  });
  afterEach(clean);

  it('records a completion when a track ends with >= 30 % played', () => {
    svc.start();
    player.emit('trackend', { track: track(1), playedSeconds: 90, completed: false });
    expect(svc.data().tracks['1'].completionCount).toBe(1);
    expect(svc.stats()).toEqual({ tracks: 1, artists: 1 });
  });

  it('records a skip (skip event then trackend) and a quick abandon under 5 s', () => {
    svc.start();
    player.emit('skip', { track: track(1), at: 40 });
    player.emit('trackend', { track: track(1), playedSeconds: 40, completed: false });
    player.emit('trackend', { track: track(2), playedSeconds: 3, completed: false });
    expect(svc.data().tracks['1'].skipCount).toBe(1);
    expect(svc.data().tracks['1'].playCount).toBe(1); // one play, not two
    expect(svc.data().tracks['2'].skipCount).toBe(1);
  });

  it('a skip flag does not leak onto the next track', () => {
    svc.start();
    player.emit('skip', { track: track(1), at: 40 });
    player.emit('trackend', { track: track(1), playedSeconds: 40, completed: false });
    player.emit('trackend', { track: track(2), playedSeconds: 120, completed: false });
    expect(svc.data().tracks['2'].skipCount).toBe(0);
    expect(svc.data().tracks['2'].completionCount).toBe(1);
  });

  it('ignores a track that never played', () => {
    expect(svc.record(track(1), 0, false, false)).toBeNull();
    expect(svc.stats().tracks).toBe(0);
  });

  it('ranks artists that were played to the end above skipped ones', () => {
    for (let i = 0; i < 3; i++) svc.record(track(100 + i, 1), 200, true, false);
    for (let i = 0; i < 3; i++) svc.record(track(200 + i, 2), 1, false, true);
    expect(svc.topArtists().map((a) => a.id)).toEqual([1, 2]);
    expect(svc.knownBadTrackIds().size).toBe(0); // each skipped track was played once only
  });

  it('persists under fiesta:music:listening and reloads', () => {
    svc.record(track(1), 200, true, false);
    svc.flush();
    expect(musicStorage.keys()).toContain('listening');
    TestBed.resetTestingModule();
    const again = TestBed.inject(MusicListeningTrackerService);
    expect(again.data().tracks['1'].completionCount).toBe(1);
  });

  it('reset forgets everything', () => {
    svc.record(track(1), 200, true, false);
    svc.reset();
    expect(svc.stats()).toEqual({ tracks: 0, artists: 0 });
    expect(musicStorage.read<{ tracks: object }>('listening', { tracks: { x: 1 } }).tracks).toEqual({});
  });

  it('start() is idempotent', () => {
    svc.start();
    svc.start();
    expect(player.handlers.get('trackend')?.length).toBe(1);
  });
});
