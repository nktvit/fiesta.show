import { lyricsCacheClear, lyricsCacheGet, lyricsCachePut, MUSIC_LYRICS_DB, MUSIC_LYRICS_TTL_MS } from './music-lyrics-cache';

describe('music-lyrics-cache', () => {
  beforeEach(async () => lyricsCacheClear());
  afterAll(async () => lyricsCacheClear());

  it('stores values in the fiesta-music-lyrics database', async () => {
    expect(MUSIC_LYRICS_DB).toBe('fiesta-music-lyrics');
    await lyricsCachePut('k1', { a: 1 });
    expect(await lyricsCacheGet('k1')).toEqual({ a: 1 });
    expect(await lyricsCacheGet('missing')).toBeUndefined();
  });

  it('expires entries after 7 days', async () => {
    const t0 = 1_000_000;
    await lyricsCachePut('k2', 'v', t0);
    expect(await lyricsCacheGet('k2', t0 + MUSIC_LYRICS_TTL_MS - 1)).toBe('v');
    expect(await lyricsCacheGet('k2', t0 + MUSIC_LYRICS_TTL_MS + 1)).toBeUndefined();
  });
});
