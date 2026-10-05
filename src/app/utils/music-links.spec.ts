import { musicUrl, parseMusicLink, shareMusicLink } from './music-links';

describe('parseMusicLink', () => {
  it('parses tidal.com browse links of every kind', () => {
    expect(parseMusicLink('https://tidal.com/browse/album/123')?.route).toBe('/music/album/123');
    expect(parseMusicLink('https://tidal.com/browse/track/456')?.route).toBe('/music/track/456');
    expect(parseMusicLink('https://tidal.com/browse/artist/8847')?.route).toBe('/music/artist/8847');
    expect(parseMusicLink('https://tidal.com/browse/playlist/0DFC3B10-FBDB-4419-BF54-11B90051FA6C')?.route)
      .toBe('/music/playlist/0dfc3b10-fbdb-4419-bf54-11b90051fa6c');
    expect(parseMusicLink('https://tidal.com/browse/mix/0123456789abcdef0123456789abcd')?.route)
      .toBe('/music/mix/0123456789abcdef0123456789abcd');
  });

  it('accepts listen.tidal.com, links without /browse, locales and tracking params', () => {
    expect(parseMusicLink('https://listen.tidal.com/album/123')?.route).toBe('/music/album/123');
    expect(parseMusicLink('https://tidal.com/album/123?u')?.route).toBe('/music/album/123');
    expect(parseMusicLink('https://tidal.com/de/browse/album/123/')?.route).toBe('/music/album/123');
    expect(parseMusicLink('https://tidal.com/browse/album/123/track/9')?.route).toBe('/music/album/123');
    expect(parseMusicLink('  https://www.tidal.com/browse/track/7#x  ')?.route).toBe('/music/track/7');
  });

  it('accepts monochrome.tf variants', () => {
    expect(parseMusicLink('https://monochrome.tf/album/123')?.route).toBe('/music/album/123');
    expect(parseMusicLink('https://monochrome.tf/#/artist/55')?.route).toBe('/music/artist/55');
    expect(parseMusicLink('monochrome.tf/track/9')?.route).toBe('/music/track/9');
    expect(parseMusicLink('https://monochrome.tf/playlist/0dfc3b10-fbdb-4419-bf54-11b90051fa6c')?.kind).toBe('playlist');
  });

  it('returns kind and id', () => {
    expect(parseMusicLink('https://tidal.com/browse/album/123')).toEqual({ kind: 'album', id: '123', route: '/music/album/123' });
  });

  it('rejects other hosts, bad ids and plain text', () => {
    expect(parseMusicLink('https://example.com/browse/album/123')).toBeNull();
    expect(parseMusicLink('https://tidal.com.evil.com/browse/album/123')).toBeNull();
    expect(parseMusicLink('https://tidal.com/browse/album/abc')).toBeNull();
    expect(parseMusicLink('https://tidal.com/browse/playlist/123')).toBeNull();
    expect(parseMusicLink('https://tidal.com/browse')).toBeNull();
    expect(parseMusicLink('javascript:alert(1)')).toBeNull();
    expect(parseMusicLink('daft punk')).toBeNull();
    expect(parseMusicLink('')).toBeNull();
    expect(parseMusicLink('album 123')).toBeNull();
  });
});

describe('musicUrl and shareMusicLink', () => {
  it('builds absolute urls', () => {
    expect(musicUrl('/music/album/1', 'https://fiesta.show')).toBe('https://fiesta.show/music/album/1');
  });

  it('falls back to copying the link when Web Share is missing', async () => {
    const nav = navigator as unknown as { share?: unknown; clipboard: { writeText: (s: string) => Promise<void> } };
    const hadShare = 'share' in nav;
    const oldShare = nav.share;
    const copied: string[] = [];
    const oldClip = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'share', { value: undefined, configurable: true });
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (s: string) => { copied.push(s); } }, configurable: true });
    try {
      const r = await shareMusicLink({ title: 'x', path: '/music/track/5' });
      expect(r).toBe('copied');
      expect(copied[0]).toBe(location.origin + '/music/track/5');
    } finally {
      if (hadShare) Object.defineProperty(navigator, 'share', { value: oldShare, configurable: true });
      else delete nav.share;
      if (oldClip) Object.defineProperty(navigator, 'clipboard', oldClip);
    }
  });

  it('treats a dismissed share sheet as done', async () => {
    Object.defineProperty(navigator, 'share', {
      value: () => Promise.reject(Object.assign(new Error('x'), { name: 'AbortError' })),
      configurable: true,
    });
    try {
      expect(await shareMusicLink({ title: 'x', path: '/music/track/5' })).toBe('shared');
    } finally {
      delete (navigator as unknown as { share?: unknown }).share;
    }
  });
});
