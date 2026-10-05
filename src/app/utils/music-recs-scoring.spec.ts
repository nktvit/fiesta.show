import type { MusicTrack } from '../services/music.service';
import {
  adaptiveSeeds, artistWeight, completionRatio, dislikedArtists, emptyListening, filterRecommendations, frequentlySkippedTrackIds,
  isSkip, pruneListening, rankRecommendations, recordPlay, sanitizeListening, scoreRecommendation, shuffled, smartSeeds, topArtists,
  topTracks, trackArtists, trackScore, MAX_ARTISTS, MAX_TRACKS,
} from './music-recs-scoring';

function track(id: number, artistId: number, extra: Partial<MusicTrack> = {}): MusicTrack {
  return {
    id, title: 't' + id, artist: 'Artist ' + artistId, artistId, album: 'a', albumId: 1, cover: '', duration: 200, explicit: false,
    trackNumber: 1, quality: 'LOSSLESS', ...extra,
  };
}
const play = (data: ReturnType<typeof emptyListening>, t: MusicTrack, played: number, opts: { completed?: boolean; skipped?: boolean } = {}) =>
  recordPlay(data, t, { playedSeconds: played, durationSeconds: t.duration, completed: !!opts.completed, skipped: !!opts.skipped });

describe('music-recs-scoring', () => {
  it('records a completion once 30 % or more was played', () => {
    const d = emptyListening();
    expect(play(d, track(1, 10), 70)).toBe('completion'); // 35 %
    expect(d.tracks['1'].completionCount).toBe(1);
    expect(d.tracks['1'].skipCount).toBe(0);
  });

  it('records a skip when the track is left under 5 s, or skipped explicitly', () => {
    const d = emptyListening();
    expect(play(d, track(1, 10), 3)).toBe('skip');
    expect(play(d, track(2, 10), 60, { skipped: true })).toBe('skip');
    expect(d.tracks['1'].skipCount).toBe(1);
    expect(d.tracks['2'].skipCount).toBe(1);
    expect(d.tracks['2'].completionCount).toBe(0);
  });

  it('is neither skip nor completion between 5 s and 30 %', () => {
    const d = emptyListening();
    expect(play(d, track(1, 10), 20)).toBe('partial'); // 10 %
    expect(d.tracks['1'].skipCount + d.tracks['1'].completionCount).toBe(0);
  });

  it('counts a natural end as fully listened (a preview is the whole track available)', () => {
    const t = track(1, 10);
    expect(completionRatio({ playedSeconds: 30, durationSeconds: t.duration, completed: true, skipped: false })).toBe(1);
    expect(isSkip({ playedSeconds: 2, durationSeconds: 200, completed: true, skipped: false })).toBe(false);
    const d = emptyListening();
    expect(play(d, t, 30, { completed: true })).toBe('completion');
  });

  it('smooths the average completion ratio', () => {
    const d = emptyListening();
    const t = track(1, 10);
    play(d, t, 200, { completed: true });
    play(d, t, 20);
    expect(d.tracks['1'].avgCompletionRatio).toBeCloseTo(1 * 0.8 + 0.1 * 0.2, 5);
    expect(d.tracks['1'].playCount).toBe(2);
  });

  it('artist affinity favours completed artists over skipped ones', () => {
    const d = emptyListening();
    for (let i = 0; i < 3; i++) play(d, track(100 + i, 1), 200, { completed: true });
    for (let i = 0; i < 3; i++) play(d, track(200 + i, 2), 2, { skipped: true });
    const top = topArtists(d);
    expect(top[0].id).toBe(1);
    expect(top.find((a) => a.id === 2)?.affinity).toBeLessThan(0);
    expect(dislikedArtists(d).map((a) => a.id)).toEqual([2]);
    expect(artistWeight(0.9, false)).toBe(1);
    expect(artistWeight(0.6, false)).toBe(0.5);
    expect(artistWeight(0.4, false)).toBe(0.2);
    expect(artistWeight(0.1, false)).toBe(-0.2);
    expect(artistWeight(1, true)).toBe(-0.5);
  });

  it('credits every artist on a track once', () => {
    const t = track(1, 10, { artists: [{ id: 10, name: 'A' }, { id: 11, name: 'B' }] });
    expect(trackArtists(t).map((a) => a.id)).toEqual([10, 11]);
    const d = emptyListening();
    play(d, t, 200, { completed: true });
    expect(Object.keys(d.artists).sort()).toEqual(['10', '11']);
  });

  it('scores completed tracks above skipped ones', () => {
    const d = emptyListening();
    play(d, track(1, 10), 200, { completed: true });
    play(d, track(2, 10), 1, { skipped: true });
    expect(trackScore(d, 1)).toBeGreaterThan(trackScore(d, 2));
    expect(trackScore(d, 999)).toBe(0);
  });

  it('smart seeds weigh favourites over history and drop disliked artists and abandoned tracks', () => {
    const d = emptyListening();
    for (let i = 0; i < 3; i++) play(d, track(900 + i, 2), 2, { skipped: true }); // artist 2 disliked
    const fav = track(1, 1);
    const hist = track(2, 1);
    const bad = track(3, 2);
    const seeds = smartSeeds(d, { favorites: [fav], playlists: [], history: [hist, bad] }, 10);
    expect(seeds.map((t) => t.id)).toEqual([1, 2]);
  });

  it('filters frequently skipped tracks and ranks top artists first', () => {
    const d = emptyListening();
    const skipped = track(7, 5);
    play(d, skipped, 1, { skipped: true });
    play(d, skipped, 1, { skipped: true });
    expect(frequentlySkippedTrackIds(d).has(7)).toBeTrue();
    for (let i = 0; i < 3; i++) play(d, track(300 + i, 1), 200, { completed: true });
    const recs = [track(7, 5), track(8, 6), track(9, 1)];
    const kept = filterRecommendations(d, recs);
    expect(kept.map((t) => t.id)).toEqual([8, 9]);
    expect(rankRecommendations(d, kept).map((t) => t.id)).toEqual([9, 8]);
    expect(scoreRecommendation(d, track(9, 1))).toBeGreaterThan(scoreRecommendation(d, track(8, 6)));
    expect(scoreRecommendation(d, skipped)).toBeLessThan(0);
  });

  it('lists highly played tracks', () => {
    const d = emptyListening();
    const t = track(1, 1);
    play(d, t, 200, { completed: true });
    play(d, t, 200, { completed: true });
    expect(topTracks(d).map((x) => x.id)).toEqual([1]);
  });

  it('adaptive seeds prefer well-heard queue tracks, avoid recent ones, then pad', () => {
    const d = emptyListening();
    const a = track(1, 1);
    const b = track(2, 1);
    const c = track(3, 1);
    play(d, a, 200, { completed: true });
    play(d, b, 40);
    const extra = [track(10, 2), track(11, 2)];
    const seeds = adaptiveSeeds(d, [a, b, c], new Set([3]), extra, 4);
    expect(seeds.map((t) => t.id)).toEqual([1, 2, 10, 11]);
  });

  it('prunes to the caps and sanitises stored junk', () => {
    const d = emptyListening();
    for (let i = 0; i < MAX_TRACKS + 5; i++) {
      d.tracks[String(i)] = { playCount: 1, skipCount: 0, completionCount: 0, totalPlayTime: 0, lastPlayed: i, avgCompletionRatio: 1 };
    }
    for (let i = 0; i < MAX_ARTISTS + 5; i++) d.artists[String(i)] = { name: 'x', affinity: i, playCount: 2, skipCount: 0, totalPlayTime: 0 };
    pruneListening(d);
    expect(Object.keys(d.tracks).length).toBe(MAX_TRACKS);
    expect(d.tracks['0']).toBeUndefined();
    expect(Object.keys(d.artists).length).toBe(MAX_ARTISTS);
    expect(d.artists['0']).toBeUndefined();
    expect(sanitizeListening('nope')).toEqual(emptyListening());
    expect(sanitizeListening({ tracks: { 1: { playCount: 'x' } }, artists: null }).tracks['1'].playCount).toBe(0);
  });

  it('shuffles without losing items and honours the injected random source', () => {
    const items = [1, 2, 3, 4, 5];
    expect([...shuffled(items)].sort()).toEqual(items);
    expect(shuffled(items, () => 0)).toEqual([2, 3, 4, 5, 1]);
  });
});
