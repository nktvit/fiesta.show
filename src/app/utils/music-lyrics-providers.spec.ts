import {
  convertKPoeLyrics,
  createLyricsCtx,
  fetchLyricsCascade,
  fetchLyricsPlus,
  KPOE_SERVERS,
  mergeAndSort,
  MUSIC_LYRICS_TIMEOUT_MS,
  rankSource,
} from './music-lyrics-providers';
import type { MusicLyricsQuery } from './music-lyrics-meta';

const Q: MusicLyricsQuery = { trackId: 42, title: 'Song', artist: 'Artist', album: 'LP', durationSec: 200, isrc: 'USABC1234567' };

const LRC = '[00:01.00]one\n[00:05.00]two\n';
const TTML = `<tt xmlns="http://www.w3.org/ns/ttml"><body><div><p begin="1s" end="3s"><span begin="1s" end="2s">Word </span><span begin="2s" end="3s">synced</span></p></div></body></tt>`;

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response> | 'hang';
function mockFetch(routes: { match: RegExp; handle: Handler }[]) {
  const calls: string[] = [];
  const fn = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    const route = routes.find((r) => r.match.test(url));
    const out = route ? route.handle(url, init) : new Response('', { status: 404 });
    if (out === 'hang') {
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    }
    return Promise.resolve(out);
  }) as typeof fetch;
  return { fn, calls };
}
const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { 'content-type': 'application/json' } });
const text = (s: string) => new Response(s, { status: 200 });
const notFound = () => new Response('', { status: 404 });

describe('music-lyrics-providers cascade', () => {
  it('uses an 8 second timeout by default', () => {
    expect(MUSIC_LYRICS_TIMEOUT_MS).toBe(8000);
    expect(createLyricsCtx().timeoutMs).toBe(8000);
  });

  it('owner file wins and nothing else is asked', async () => {
    const { fn, calls } = mockFetch([{ match: /\/assets\/music\/lyrics\/42\.lrc$/, handle: () => text(LRC) }]);
    const r = await fetchLyricsCascade(Q, createLyricsCtx({ fetchFn: fn }));
    expect(r.sources.length).toBe(1);
    expect(r.sources[0].source).toBe('Fiesta');
    expect(r.sources[0].lines.map((l) => l.text)).toEqual(['one', 'two']);
    expect(calls.some((u) => u.includes('lrc.red') || u.includes('lrclib'))).toBeFalse();
    expect(calls[0]).toBe('/assets/music/lyrics/42.ttml');
  });

  it('ignores an HTML fallback page served for a missing owner file', async () => {
    const { fn } = mockFetch([
      { match: /\/assets\/music\/lyrics\//, handle: () => text('<!doctype html><html><body>app</body></html>') },
      { match: /lrc\.red\/s\/USABC1234567\.ttml/, handle: () => text(TTML) },
    ]);
    const r = await fetchLyricsCascade(Q, createLyricsCtx({ fetchFn: fn }));
    expect(r.sources[0].source).toBe('lrc.red');
    expect(r.sources[0].lines[0].syllables?.length).toBe(2);
  });

  it('lrc.red comes before every other provider', async () => {
    const { fn, calls } = mockFetch([
      { match: /lrc\.red\/s\//, handle: () => text(TTML) },
      { match: /lrclib/, handle: () => json([{ syncedLyrics: LRC }]) },
    ]);
    const r = await fetchLyricsCascade(Q, createLyricsCtx({ fetchFn: fn }));
    expect(r.sources[0].source).toBe('lrc.red');
    expect(calls.some((u) => u.includes('lrclib') || u.includes('binimum') || u.includes('unison'))).toBeFalse();
  });

  it('falls through on a timeout and on 404 to the next provider; LRCLIB is the fallback', async () => {
    const { fn, calls } = mockFetch([
      { match: /lrc\.red/, handle: () => 'hang' },
      { match: /lyrics-api\.binimum\.org/, handle: notFound },
      { match: /unison\.boidu\.dev/, handle: notFound },
      { match: /lyricsplus|lyrics-plus-backend/, handle: notFound },
      { match: /lrclib\.net\/api\/search/, handle: () => json([{ plainLyrics: 'x' }, { syncedLyrics: LRC, plainLyrics: 'p' }]) },
    ]);
    const t0 = Date.now();
    const r = await fetchLyricsCascade(Q, createLyricsCtx({ fetchFn: fn, timeoutMs: 40 }));
    expect(Date.now() - t0).toBeLessThan(4000);
    expect(r.sources.length).toBe(1);
    expect(r.sources[0].source).toBe('LRCLIB');
    expect(r.sources[0].lines.map((l) => l.text)).toEqual(['one', 'two']);
    expect(r.failed).toBeFalse();
    // lrc.red timed out (twice: ISRC then match), the rest answered 404
    expect(calls.filter((u) => u.includes('lrc.red')).length).toBeGreaterThanOrEqual(1);
    expect(calls.some((u) => u.includes('unison.boidu.dev'))).toBeTrue();
    expect(r.tried).toEqual(['Fiesta', 'lrc.red', 'BiniLyrics', 'Unison', 'LyricsPlus', 'LRCLIB']);
  });

  it('passes the abort signal to every request', async () => {
    const seen: AbortSignal[] = [];
    const fn = ((_: RequestInfo | URL, init?: RequestInit) => {
      if (init?.signal) seen.push(init.signal);
      return Promise.resolve(notFound());
    }) as typeof fetch;
    await fetchLyricsCascade(Q, createLyricsCtx({ fetchFn: fn }));
    expect(seen.length).toBeGreaterThan(5);
  });

  it('stops with an AbortError when the caller aborts', async () => {
    const controller = new AbortController();
    const { fn } = mockFetch([{ match: /.*/, handle: () => 'hang' }]);
    const p = fetchLyricsCascade(Q, createLyricsCtx({ fetchFn: fn, signal: controller.signal }));
    setTimeout(() => controller.abort(), 20);
    await expectAsync(p).toBeRejectedWithError(/abort/i);
  });

  it('reports "no lyrics" (not a failure) when every provider answers 404', async () => {
    const { fn } = mockFetch([]);
    const r = await fetchLyricsCascade(Q, createLyricsCtx({ fetchFn: fn }));
    expect(r.sources).toEqual([]);
    expect(r.failed).toBeFalse();
    expect(r.tried).toContain('LRCLIB');
  });

  it('reports a failure when the network is down', async () => {
    const fn = (() => Promise.reject(new TypeError('Failed to fetch'))) as typeof fetch;
    const r = await fetchLyricsCascade(Q, createLyricsCtx({ fetchFn: fn }));
    expect(r.sources).toEqual([]);
    expect(r.failed).toBeTrue();
  });

  it('skips providers the user turned off', async () => {
    const { fn, calls } = mockFetch([{ match: /lrclib/, handle: () => json([{ syncedLyrics: LRC }]) }]);
    const r = await fetchLyricsCascade(Q, createLyricsCtx({ fetchFn: fn }), { enabled: { lrcred: false, bini: false, unison: false, lyricsplus: false, genius: false } });
    expect(r.sources[0].source).toBe('LRCLIB');
    expect(calls.some((u) => u.includes('lrc.red') || u.includes('unison'))).toBeFalse();
  });

  it('plain LRCLIB text is labelled unsynced', async () => {
    const { fn } = mockFetch([{ match: /lrclib/, handle: () => json([{ plainLyrics: 'a\nb' }]) }]);
    const r = await fetchLyricsCascade(Q, createLyricsCtx({ fetchFn: fn }));
    expect(r.sources[0].source).toBe('LRCLIB (unsynced)');
    expect(r.sources[0].lines.every((l) => l.start === 0 && l.end === 0)).toBeTrue();
  });

  it('asks Genius only when nothing else produced lyrics', async () => {
    const { fn } = mockFetch([{ match: /fetch-genius/, handle: () => json({ lyrics: '[Verse 1]\nline a\nline b' }) }]);
    const r = await fetchLyricsCascade(Q, createLyricsCtx({ fetchFn: fn }));
    expect(r.sources[0].source).toBe('Genius');
    expect(r.sources[0].lines.map((l) => l.text)).toEqual(['line a', 'line b']);
  });

  it('"all" mode collects every source, ranked', async () => {
    const { fn } = mockFetch([
      { match: /unison\.boidu\.dev/, handle: () => json({ success: true, data: { lyrics: LRC, format: 'lrc', syncType: 'linesync' } }) },
      { match: /lrclib/, handle: () => json([{ syncedLyrics: LRC }]) },
      { match: /lyrics-api\.binimum\.org\/\?isrc/, handle: () => json({ results: [{ lyricsUrl: 'https://cdn.example/x.ttml' }] }) },
      { match: /cdn\.example/, handle: () => text(TTML) },
    ]);
    const r = await fetchLyricsCascade(Q, createLyricsCtx({ fetchFn: fn }), { mode: 'all' });
    expect(r.complete).toBeTrue();
    expect(r.sources.map((s) => s.source)).toEqual(['BiniLyrics', 'Unison', 'LRCLIB']);
  });

  it('does not follow a non-https lyricsUrl from BiniLyrics', async () => {
    const { fn, calls } = mockFetch([
      { match: /lyrics-api\.binimum\.org/, handle: () => json({ results: [{ lyricsUrl: 'http://evil.example/x.ttml' }] }) },
    ]);
    await fetchLyricsCascade(Q, createLyricsCtx({ fetchFn: fn }));
    expect(calls.some((u) => u.includes('evil.example'))).toBeFalse();
  });
});

describe('music-lyrics-providers LyricsPlus', () => {
  const payload = {
    type: 'Syllable',
    metadata: { source: 'Apple', agents: { v1: { type: 'person' } } },
    lyrics: [
      { time: 1000, duration: 2000, text: 'Hey you', element: { singer: 'v1' }, syllabus: [{ time: 1000, duration: 800, text: 'Hey ' }, { time: 1800, duration: 1200, text: 'you' }, { time: 2500, duration: 400, text: 'ah', isBackground: true }] },
    ],
  };

  it('converts word timing and background syllables', () => {
    const lines = convertKPoeLyrics(payload)!;
    expect(lines.length).toBe(2);
    expect(lines[0].text).toBe('Hey you');
    expect(lines[0].syllables?.[1]).toEqual({ start: 1.8, end: 3, text: 'you' });
    expect(lines[1].background).toBeTrue();
    expect(lines[1].text).toBe('ah');
    expect(convertKPoeLyrics({})).toBeNull();
  });

  it('tries three random mirrors then forces binimum when nothing is word-synced', async () => {
    const { fn, calls } = mockFetch([]);
    await fetchLyricsPlus(Q, createLyricsCtx({ fetchFn: fn, random: () => 0.5 }));
    const hosts = calls.map((u) => new URL(u).origin);
    expect(hosts.length).toBe(4);
    expect(new Set(hosts.slice(0, 3)).size).toBe(3);
    expect(hosts[3]).toBe(KPOE_SERVERS[0]);
    expect(calls[0]).toContain('source=apple');
  });

  it('stops early on an Apple word-synced hit', async () => {
    const { fn, calls } = mockFetch([{ match: /v2\/lyrics\/get/, handle: () => json(payload) }]);
    const r = await fetchLyricsPlus(Q, createLyricsCtx({ fetchFn: fn }));
    expect(calls.length).toBe(1);
    expect(r[0].source).toBe('Apple');
  });
});

describe('music-lyrics-providers ranking', () => {
  const word = [{ start: 1, end: 2, text: 'a', syllables: [{ start: 1, end: 1.5, text: 'a' }, { start: 1.5, end: 2, text: 'b' }] }];
  const line = [{ start: 1, end: 2, text: 'a' }];
  const plain = [{ start: 0, end: 0, text: 'a' }];
  it('prefers word sync over line sync over plain, Genius last', () => {
    expect(rankSource('lrc.red', word)).toBeLessThan(rankSource('Apple', word));
    expect(rankSource('Apple', word)).toBeLessThan(rankSource('Unison', line));
    expect(rankSource('Unison', line)).toBeLessThan(rankSource('LRCLIB', line));
    expect(rankSource('LRCLIB', line)).toBeLessThan(rankSource('LRCLIB (unsynced)', plain));
    expect(rankSource('Genius', plain)).toBeGreaterThan(rankSource('LRCLIB (unsynced)', plain));
    expect(mergeAndSort([{ provider: 'lrclib', source: 'LRCLIB', lines: line, songwriters: [] }, { provider: 'lrcred', source: 'lrc.red', lines: word, songwriters: [] }]).map((s) => s.source)).toEqual(['lrc.red', 'LRCLIB']);
  });
});
