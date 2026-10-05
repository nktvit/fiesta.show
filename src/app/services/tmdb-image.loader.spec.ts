import { tmdbImageLoader } from './tmdb-image.loader';

const POSTER = 'https://image.tmdb.org/t/p/w342/abc123.jpg';
const BACKDROP = 'https://image.tmdb.org/t/p/w1280/bd456.jpg';

describe('tmdbImageLoader', () => {
  describe('poster tiers', () => {
    // width requested -> folder served (posters may be up to ~30% soft, see POSTER_SOFTNESS)
    const cases: [number, string][] = [
      [92, 'w92'], [100, 'w92'], [154, 'w154'], [185, 'w154'], [342, 'w342'], [360, 'w342'],
      [500, 'w342'], [780, 'w780'],
      // posters stop at w780: no w1280 and never "original"
      [1280, 'w780'], [3840, 'w780'],
    ];
    for (const [width, tier] of cases) {
      it(`maps width ${width} to ${tier}`, () => {
        expect(tmdbImageLoader({ src: POSTER, width })).toBe(`https://image.tmdb.org/t/p/${tier}/abc123.jpg`);
      });
    }

    it('defaults to w342 when no width is given', () => {
      expect(tmdbImageLoader({ src: POSTER })).toContain('/w342/');
    });
  });

  describe('backdrop tiers', () => {
    const cases: [number, string][] = [[92, 'w780'], [300, 'w780'], [342, 'w780'], [780, 'w780'], [1280, 'w1280'], [3840, 'w1280']];
    for (const [width, tier] of cases) {
      it(`maps width ${width} to ${tier}`, () => {
        expect(tmdbImageLoader({ src: BACKDROP, width, loaderParams: { kind: 'backdrop' } }))
          .toBe(`https://image.tmdb.org/t/p/${tier}/bd456.jpg`);
      });
    }
  });

  it('keeps the file extension (TMDB 404s on rewritten .webp paths)', () => {
    const result = tmdbImageLoader({ src: POSTER, width: 185 });
    expect(result).toBe('https://image.tmdb.org/t/p/w185/abc123.jpg');
    expect(result).not.toContain('.webp');
  });

  describe('non-TMDB URLs', () => {
    it('passes Amazon OMDB URLs through unchanged', () => {
      const amazonUrl = 'https://m.media-amazon.com/images/M/MV5BMjE.jpg';
      expect(tmdbImageLoader({ src: amazonUrl, width: 200 })).toBe(amazonUrl);
    });

    it('passes arbitrary URLs through unchanged', () => {
      const url = 'https://example.com/poster.jpg';
      expect(tmdbImageLoader({ src: url, width: 300 })).toBe(url);
    });
  });
});
