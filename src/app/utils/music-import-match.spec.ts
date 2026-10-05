import { MusicTrack } from '../services/music.service';
import { findBestMatch, isIsrcMatch, MATCH_THRESHOLD, normalizeIsrc, scoreTrack, splitArtists, stringSimilarity } from './music-import-match';

const t = (id: number, title: string, artist: string, extra: Partial<MusicTrack> = {}): MusicTrack => ({
  id, title, artist, artistId: null, album: '', albumId: null, cover: '', duration: 200, explicit: false, trackNumber: 1, quality: '', ...extra,
});

describe('music-import-match', () => {
  it('normalizes and compares ISRCs', () => {
    expect(normalizeIsrc('us-abc-12-34567')).toBe('USABC1234567');
    expect(isIsrcMatch('USABC1234567', 'us-abc-12-34567')).toBeTrue();
    expect(isIsrcMatch('', '')).toBeFalse();
  });

  it('stringSimilarity', () => {
    expect(stringSimilarity('Hello World', 'hello, world!')).toBe(1);
    expect(stringSimilarity('Hello', 'Hello (Remastered)')).toBe(0.85);
    expect(stringSimilarity('a b c d', 'a b x y')).toBe(0.5);
    expect(stringSimilarity('', 'x')).toBe(0);
  });

  it('splitArtists', () => {
    expect(splitArtists('A, B & C feat. D')).toEqual(['A', 'B', 'C', 'D']);
  });

  it('ISRC equality scores 1 and wins over a better-looking title', () => {
    const items = [t(1, 'One More Time', 'Daft Punk'), t(2, 'Totally Different', 'Other', { isrc: 'GBDUW0000059' })];
    const m = findBestMatch(items, { title: 'One More Time', artist: 'Daft Punk', isrc: 'gb-duw-00-00059' });
    expect(m?.track.id).toBe(2);
    expect(m?.score).toBe(1);
    expect(m?.by).toBe('isrc');
  });

  it('fuzzy title/artist match at or above the threshold', () => {
    const items = [t(1, 'One More Time', 'Daft Punk'), t(2, 'One More Night', 'Maroon 5')];
    const m = findBestMatch(items, { title: 'one more time', artist: 'daft punk' });
    expect(m?.track.id).toBe(1);
    expect(m!.score).toBeGreaterThanOrEqual(MATCH_THRESHOLD);
    expect(m?.by).toBe('fuzzy');
  });

  it('uses credited artists array', () => {
    const items = [t(1, 'Song', 'Wrong Name', { artists: [{ id: 1, name: 'Real Artist' }] })];
    expect(findBestMatch(items, { title: 'Song', artist: 'Real Artist' })?.track.id).toBe(1);
  });

  it('rejects below-threshold candidates', () => {
    const items = [t(1, 'Completely Other Song', 'Nobody')];
    expect(findBestMatch(items, { title: 'One More Time', artist: 'Daft Punk' })).toBeNull();
    expect(findBestMatch([], { title: 'x' })).toBeNull();
    // right title, wrong artist: 0.5 < 0.6
    expect(findBestMatch([t(1, 'One More Time', 'Someone Else')], { title: 'One More Time', artist: 'Daft Punk' })).toBeNull();
  });

  it('scoreTrack weights title 50 / artist 40 / album 10', () => {
    const s = scoreTrack(t(1, 'A', 'B', { album: 'C' }), 'A', 'B', 'C');
    expect(s.score).toBeCloseTo(1, 5);
    expect(scoreTrack(t(1, 'A', 'B'), 'A', 'B').score).toBeCloseTo(0.9, 5);
  });
});
