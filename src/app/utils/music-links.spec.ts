import { musicUrl, shareMusicLink } from './music-links';

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
