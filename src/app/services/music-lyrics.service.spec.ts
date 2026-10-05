import { TestBed } from '@angular/core/testing';
import { lyricsCacheClear } from '../utils/music-lyrics-cache';
import { sanitizeLyricsPrefs, MusicLyricsService } from './music-lyrics.service';
import type { MusicTrack } from './music.service';

const TRACK = { id: 777001, title: 'Spec Song (feat. X)', artist: 'Spec Artist', artistId: 1, album: 'Spec LP', albumId: 2, cover: '', duration: 180, explicit: false, trackNumber: 1, quality: 'HIGH' } as MusicTrack;
const LRC = '[00:01.00]alpha\n[00:05.00]beta\n';

describe('MusicLyricsService', () => {
  let svc: MusicLyricsService;
  let calls: string[];
  let withUnison = false;

  beforeEach(async () => {
    localStorage.removeItem('fiesta:music:lyrics');
    await lyricsCacheClear();
    calls = [];
    withUnison = false;
    spyOn(window, 'fetch').and.callFake((input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (withUnison && url.includes('unison.boidu.dev')) {
        return Promise.resolve(new Response(JSON.stringify({ success: true, data: { lyrics: LRC, format: 'lrc', syncType: 'linesync' } })));
      }
      if (url.includes('lrclib.net/api/search')) {
        return Promise.resolve(new Response(JSON.stringify([{ syncedLyrics: LRC }])));
      }
      return Promise.resolve(new Response('', { status: 404 }));
    });
    TestBed.configureTestingModule({});
    svc = TestBed.inject(MusicLyricsService);
  });
  afterEach(async () => {
    localStorage.removeItem('fiesta:music:lyrics');
    await lyricsCacheClear();
  });

  it('fetches through the cascade and caches the result for the next call', async () => {
    const first = await svc.fetch(TRACK);
    expect(first?.source).toBe('LRCLIB');
    expect(first?.synced).toBeTrue();
    expect(first?.wordSynced).toBeFalse();
    expect(first?.trackId).toBe(TRACK.id);
    expect(first?.lines.map((l) => l.text)).toEqual(['alpha', 'beta']);
    const used = calls.length;
    expect(calls.some((u) => u.includes('q=Spec+Artist+Spec+Song'))).toBeTrue(); // cleaned title, lead artist

    const second = await svc.fetch(TRACK);
    expect(second?.lines.length).toBe(2);
    expect(calls.length).toBe(used); // served from IndexedDB
  });

  it('returns null and explains what was tried when nothing is found', async () => {
    svc.setPrefs({ providers: { lrclib: false } });
    const none = await svc.lookup({ ...TRACK, id: 777003 });
    expect(none.lyrics).toBeNull();
    expect(none.tried).toContain('Unison');
    expect(none.tried).not.toContain('LRCLIB');
    expect(none.failed).toBeFalse();
  });

  it('asks every provider when another source is requested, then cycles', async () => {
    withUnison = true;
    const first = await svc.lookup(TRACK);
    expect(first.lyrics?.source).toBe('Unison');
    expect(first.complete).toBeFalse(); // LRCLIB was never asked
    const before = calls.length;

    const second = await svc.lookup(TRACK, { sourceIndex: 1 });
    expect(calls.length).toBeGreaterThan(before);
    expect(second.sources).toEqual(['Unison', 'LRCLIB']);
    expect(second.lyrics?.source).toBe('LRCLIB');
    expect(second.complete).toBeTrue();

    const used = calls.length;
    const third = await svc.lookup(TRACK, { sourceIndex: 2 });
    expect(calls.length).toBe(used); // full set is cached now
    expect(third.lyrics?.source).toBe('Unison'); // wraps around
  });

  it('exports LRC, TTML and plain text from the same lines', async () => {
    const l = (await svc.fetch(TRACK))!;
    expect(svc.toLRC(l)).toBe('[re:LRCLIB]\n[00:01.00]alpha\n[00:05.00]beta\n');
    expect(svc.toPlain(l)).toBe('alpha\nbeta');
    const ttml = svc.toTTML(l);
    expect(ttml).toContain('<span begin="00:00:01.000" end="00:00:05.000">alpha</span>');
  });

  it('persists preferences under fiesta:music:lyrics and ignores junk', () => {
    svc.setPrefs({ romanize: true, targetLang: 'fr', providers: { genius: false } });
    const stored = JSON.parse(localStorage.getItem('fiesta:music:lyrics') ?? '{}');
    expect(stored.romanize).toBeTrue();
    expect(stored.targetLang).toBe('fr');
    expect(stored.providers.genius).toBeFalse();
    expect(stored.providers.lrclib).toBeTrue();

    const clean = sanitizeLyricsPrefs({ romanize: 'yes', targetLang: '<script>', providers: { lrclib: 3 }, blur: false });
    expect(clean.romanize).toBeFalse();
    expect(clean.targetLang).not.toBe('<script>');
    expect(clean.providers.lrclib).toBeTrue();
    expect(clean.blur).toBeFalse();
  });
});
