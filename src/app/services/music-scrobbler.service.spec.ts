import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MusicLibraryService } from './music-library.service';
import { MusicPlayerEvents, MusicPlayerService } from './music-player.service';
import { MusicScrobblerService } from './music-scrobbler.service';
import { MusicSettingsService } from './music-settings.service';
import { MusicTrack } from './music.service';

const track = (id: number, over: Partial<MusicTrack> = {}): MusicTrack => ({
  id, title: 'Song ' + id, artist: 'Ann', artistId: 1, album: 'Alb', albumId: 2, cover: '', duration: 200,
  explicit: false, trackNumber: 1, quality: 'LOSSLESS', ...over,
});

describe('MusicScrobblerService', () => {
  type Handler = (e: never) => void;
  let handlers: Map<string, Handler[]>;
  let favoriteCb: ((item: { kind: string; data: MusicTrack }, liked: boolean) => void) | null;
  let requests: { url: string; body: string }[];
  let online: boolean;
  let svc: MusicScrobblerService;
  let realFetch: typeof fetch;

  const emit = <K extends keyof MusicPlayerEvents>(type: K, e: MusicPlayerEvents[K]) => (handlers.get(type) ?? []).forEach((h) => h(e as never));

  beforeEach(() => {
    try { localStorage.clear(); } catch { /* none */ }
    handlers = new Map();
    favoriteCb = null;
    requests = [];
    online = true;
    realFetch = window.fetch;
    window.fetch = (async (url: string, init?: RequestInit) => {
      requests.push({ url: String(url), body: String(init?.body ?? '') });
      if (!online) throw new TypeError('offline');
      return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
    }) as typeof fetch;
    TestBed.configureTestingModule({
      providers: [
        {
          provide: MusicPlayerService,
          useValue: {
            playing: signal(false),
            on: (type: string, cb: Handler) => { handlers.set(type, [...(handlers.get(type) ?? []), cb]); return () => undefined; },
          },
        },
        { provide: MusicLibraryService, useValue: { onFavoriteChange: (cb: typeof favoriteCb) => { favoriteCb = cb; return () => undefined; } } },
      ],
    });
    svc = TestBed.inject(MusicScrobblerService);
  });
  afterEach(() => { window.fetch = realFetch; });

  const enableLb = () => {
    svc.setCreds('listenbrainz', { token: 'tok' });
    svc.setEnabled('listenbrainz', true);
    svc.start();
  };
  const types = () => requests.filter((r) => r.url.includes('submit-listens')).map((r) => JSON.parse(r.body).listen_type as string);
  const settle = () => new Promise((r) => setTimeout(r, 20));

  it('does nothing and sends nothing when no service is enabled', async () => {
    svc.start();
    emit('trackstart', { track: track(1) });
    emit('trackend', { track: track(1), playedSeconds: 190, completed: true });
    await settle();
    expect(requests.length).toBe(0);
    expect(svc.anyReady()).toBeFalse();
  });

  it('sends playing_now at start and exactly one single past the threshold', async () => {
    enableLb();
    emit('trackstart', { track: track(1) });
    await settle();
    expect(types()).toEqual(['playing_now']);
    emit('trackend', { track: track(1), playedSeconds: 120, completed: true });
    await settle();
    expect(types()).toEqual(['playing_now', 'single']);
    emit('trackend', { track: track(1), playedSeconds: 130, completed: true });
    await settle();
    expect(types().filter((t) => t === 'single').length).toBe(1);
  });

  it('does not scrobble a track played less than the threshold or shorter than 30 s', async () => {
    enableLb();
    emit('trackstart', { track: track(1) });
    emit('trackend', { track: track(1), playedSeconds: 40, completed: false });
    emit('trackstart', { track: track(2, { duration: 20 }) });
    emit('trackend', { track: track(2, { duration: 20 }), playedSeconds: 20, completed: true });
    await settle();
    expect(types()).toEqual(['playing_now', 'playing_now']);
  });

  it('queues failures under the secret key and retries when back online', async () => {
    enableLb();
    online = false;
    emit('trackstart', { track: track(1) });
    emit('trackend', { track: track(1), playedSeconds: 150, completed: true });
    await settle();
    expect(svc.queue().length).toBe(1);
    expect(localStorage.getItem('fiesta:music:secret:scrobble-queue')).toContain('Song 1');
    online = true;
    window.dispatchEvent(new Event('online'));
    await settle();
    expect(svc.queue().length).toBe(0);
    expect(types().filter((t) => t === 'single').length).toBe(2); // one failed attempt, one retry
  });

  it('loves once per enabled service on like, only when love-on-like is on', async () => {
    enableLb();
    const meta = { kind: 'track', data: track(5) };
    favoriteCb?.(meta, true);
    await settle();
    expect(requests.some((r) => r.url.includes('recording-feedback'))).toBeFalse();
    svc.setLoveOnLike(true);
    window.fetch = (async (url: string, init?: RequestInit) => {
      requests.push({ url: String(url), body: String(init?.body ?? '') });
      return new Response(JSON.stringify({ recording_mbid: 'm1' }), { status: 200 });
    }) as typeof fetch;
    favoriteCb?.(meta, true);
    await settle();
    expect(requests.filter((r) => r.url.includes('recording-feedback')).length).toBe(1);
    favoriteCb?.(meta, false);
    await settle();
    expect(requests.filter((r) => r.url.includes('recording-feedback')).length).toBe(1);
  });

  it('keeps credentials only under the secret prefix', () => {
    svc.setCreds('maloja', { url: 'https://m.test', key: 'SECRETKEY' });
    const leaked = Object.keys(localStorage).filter((k) => k.startsWith('fiesta:music:') && !k.includes(':secret:') && (localStorage.getItem(k) ?? '').includes('SECRETKEY'));
    expect(leaked).toEqual([]);
    expect(localStorage.getItem('fiesta:music:secret:scrobble-creds')).toContain('SECRETKEY');
    svc.disconnect('maloja');
    expect(svc.hasCreds('maloja')).toBeFalse();
  });

  it('settings stay injectable', () => {
    expect(TestBed.inject(MusicSettingsService).scrobblePercent()).toBe(50);
  });
});
