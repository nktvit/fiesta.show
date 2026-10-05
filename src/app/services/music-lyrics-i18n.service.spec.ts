import { Injectable } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { hasKana, isPurelyLatin, MusicLyricsI18nService } from './music-lyrics-i18n.service';

@Injectable()
class TestI18n extends MusicLyricsI18nService {
  calls: string[] = [];
  handler: (url: URL) => Response | Promise<Response> = () => new Response('[]');
  constructor() {
    super();
    this.fetchFn = ((input: RequestInfo | URL) => {
      const url = new URL(String(input));
      this.calls.push(url.search);
      return Promise.resolve(this.handler(url));
    }) as typeof fetch;
  }
}

const j = (v: unknown) => new Response(JSON.stringify(v));

describe('MusicLyricsI18nService', () => {
  let svc: TestI18n;
  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [{ provide: MusicLyricsI18nService, useClass: TestI18n }] });
    svc = TestBed.inject(MusicLyricsI18nService) as TestI18n;
  });

  it('detects scripts', () => {
    expect(isPurelyLatin('Café déjà vu')).toBeTrue();
    expect(isPurelyLatin('こんにちは')).toBeFalse();
    expect(hasKana('今日はいい天気')).toBeTrue();
    expect(hasKana('今日')).toBeFalse();
  });

  it('translates in one batch and keeps blank lines blank', async () => {
    svc.handler = (url) => {
      const q = url.searchParams.get('q') ?? '';
      expect(url.searchParams.get('tl')).toBe('es');
      expect(url.searchParams.get('dt')).toBe('t');
      const rows = q.split('\n');
      // Google keeps the newline at the end of each segment
      return j([rows.map((l, i) => [`ES:${l}${i < rows.length - 1 ? '\n' : ''}`, l])]);
    };
    const out = await svc.translate(['hello', '', 'world', 'hello'], 'es');
    expect(out).toEqual(['ES:hello', '', 'ES:world', 'ES:hello']);
    expect(svc.calls.length).toBe(1);
    // cached
    await svc.translate(['hello'], 'es');
    expect(svc.calls.length).toBe(1);
  });

  it('falls back to line by line when Google merges lines', async () => {
    svc.handler = (url) => {
      const q = url.searchParams.get('q') ?? '';
      return q.includes('\n') ? j([[['ES:merged', q]]]) : j([[[`ES:${q}`, q]]]);
    };
    expect(await svc.translate(['a', 'b'], 'es')).toEqual(['ES:a', 'ES:b']);
  });

  it('rejects when the network keeps failing', async () => {
    svc.handler = () => new Response('', { status: 500 });
    await expectAsync(svc.translate(['x'], 'es')).toBeRejected();
  });

  it('romanizes non-Latin lines through dt=rm and leaves Latin ones alone', async () => {
    svc.handler = (url) => {
      expect(url.searchParams.get('dt')).toBe('rm');
      const q = url.searchParams.get('q') ?? '';
      return j([q.split('\n').map((l) => [null, null, null, `rom:${l}`])]);
    };
    const out = await svc.romanize(['hello', 'привет', 'мир']);
    expect(out).toEqual(['hello', 'rom:привет', 'rom:мир']);
  });

  it('honours an aborted signal', async () => {
    const c = new AbortController();
    c.abort();
    await expectAsync(svc.translate(['x'], 'es', c.signal)).toBeRejected();
  });
});
