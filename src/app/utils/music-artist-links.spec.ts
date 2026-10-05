import { artistLinkViews } from './music-artist-links';

describe('artistLinkViews', () => {
  it('drops stores, dedupes per service and groups', () => {
    const v = artistLinkViews([
      { type: 'social network', url: 'https://twitter.com/daftpunk' },
      { type: 'social network', url: 'https://x.com/daftpunk' },
      { type: 'purchase for download', url: 'https://www.amazon.com/dp/1' },
      { type: 'streaming', url: 'https://open.spotify.com/artist/1' },
      { type: 'streaming', url: 'https://music.apple.com/artist/2' },
      { type: 'discogs', url: 'https://www.discogs.com/artist/3' },
      { type: 'discogs', url: 'https://www.discogs.com/artist/3-dup' },
      { type: 'official homepage', url: 'https://www.daftpunk.com/' },
      { type: 'musicbrainz', url: 'https://musicbrainz.org/artist/abc' },
    ]);
    expect(v.map((x) => x.label)).toEqual(['daftpunk.com', 'Spotify', 'Apple Music', 'X', 'Discogs', 'MusicBrainz']);
    expect(v.find((x) => x.label === 'X')?.path).toContain('M14.234');
    expect(v.find((x) => x.label === 'daftpunk.com')?.path).toBeNull();
  });

  it('ignores non-http links and buy types', () => {
    expect(artistLinkViews([{ type: 'streaming', url: 'javascript:alert(1)' }, { type: 'purchase for download', url: 'https://shop.example.com/' }])).toEqual([]);
  });
});
