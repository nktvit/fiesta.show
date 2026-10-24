import { MusicManifest } from './music.service';
import { MusicDeck } from './music-deck';

/** Just enough MediaSource for the deck's feeding loop. */
class FakeSourceBuffer {
  appended = 0;
  private cbs: (() => void)[] = [];
  addEventListener(_: string, cb: () => void) { this.cbs.push(cb); }
  appendBuffer(_: ArrayBuffer) { this.appended++; const c = this.cbs.splice(0); setTimeout(() => c.forEach((f) => f())); }
  remove() { const c = this.cbs.splice(0); setTimeout(() => c.forEach((f) => f())); }
}
class FakeMediaSource {
  static isTypeSupported() { return true; }
  readyState = 'open';
  duration = 0;
  sb = new FakeSourceBuffer();
  addEventListener(_: string, cb: () => void) { setTimeout(cb); }
  addSourceBuffer() { return this.sb; }
  endOfStream() { this.readyState = 'ended'; }
}

describe('MusicDeck segment batching', () => {
  let win: { MediaSource?: unknown };
  let saved: unknown;
  let urls: string[];
  let fetchSpy: jasmine.Spy;

  beforeEach(() => {
    win = window as unknown as { MediaSource?: unknown };
    saved = win.MediaSource;
    win.MediaSource = FakeMediaSource;
    spyOn(URL, 'createObjectURL').and.returnValue('blob:x');
    urls = [];
    fetchSpy = spyOn(window, 'fetch').and.callFake(((u: string) => {
      urls.push(u);
      return Promise.resolve({ ok: true, status: 200, arrayBuffer: () => Promise.resolve(new ArrayBuffer(1)) });
    }) as unknown as typeof fetch);
  });
  afterEach(() => { win.MediaSource = saved; });

  const el = () => ({
    preload: '', src: '', currentTime: 0, paused: true, buffered: { length: 0, start: () => 0, end: () => 0 },
    addEventListener() {}, removeEventListener() {}, pause() {}, hasAttribute: () => false, removeAttribute() {}, load() {},
  }) as unknown as HTMLAudioElement;

  const manifest = (segs: number) => ({
    presentation: 'FULL', quality: 'LOSSLESS', signedIn: true, kind: 'segments', codec: 'flac',
    init: '/seg?u=init', media: '/seg?u=media', durations: new Array(segs).fill(4),
  }) as MusicManifest;

  const settle = async (deck: MusicDeck) => {
    for (let i = 0; i < 200 && !(deck as unknown as { loopDone: boolean }).loopDone; i++) await new Promise((r) => setTimeout(r, 5));
  };

  it('plays a 70-segment track in <= 12 requests (init included), covering every segment once', async () => {
    const deck = new MusicDeck(el());
    await deck.load(manifest(70), 1, () => true);
    await settle(deck);
    expect(urls.length).toBeLessThanOrEqual(12);
    expect(urls[0]).toBe('/seg?u=init');
    expect(urls[1]).toBe('/seg?u=media&n=1');
    expect(urls[2]).toBe('/seg?u=media&n=2&c=4');
    expect(urls[3]).toBe('/seg?u=media&n=6&c=8');
    // last batch stops at segment 70
    const last = urls[urls.length - 1];
    const [, n, c] = /&n=(\d+)(?:&c=(\d+))?$/.exec(last)!;
    expect(+n + (+c || 1) - 1).toBe(70);
    deck.dispose();
    expect(fetchSpy).toHaveBeenCalled();
  });

  it('a standby deck prepares with small batches', async () => {
    const deck = new MusicDeck(el());
    await deck.load(manifest(10), 1, () => true);
    await settle(deck);
    deck.dispose();
    const deck2 = new MusicDeck(el());
    urls.length = 0;
    deck2.prepare(manifest(70), 2);
    await new Promise((r) => setTimeout(r, 100));
    deck2.dispose();
    expect(urls.some((u) => /&c=8/.test(u))).toBeFalse();
  });
  it('a seek out of the buffer cancels the in-flight batch and refetches from the new position', async () => {
    const handlers: Record<string, (() => void)[]> = {};
    const audio = el() as unknown as { currentTime: number; addEventListener: (t: string, cb: () => void) => void };
    audio.addEventListener = (t, cb) => { (handlers[t] ||= []).push(cb); };
    let aborted = 0;
    urls.length = 0;
    fetchSpy.and.callFake(((u: string, init?: { signal?: AbortSignal }) => {
      urls.push(u);
      if (/&n=2&c=4$/.test(u)) { // the old position's batch: never completes on its own
        return new Promise((_, reject) => init?.signal?.addEventListener('abort', () => { aborted++; reject(new DOMException('x', 'AbortError')); }));
      }
      return Promise.resolve({ ok: true, status: 200, arrayBuffer: () => Promise.resolve(new ArrayBuffer(1)) });
    }) as unknown as typeof fetch);

    const deck = new MusicDeck(audio as unknown as HTMLAudioElement);
    await deck.load(manifest(70), 1, () => true);
    await new Promise((r) => setTimeout(r, 60)); // init, n=1, then the stuck n=2&c=4
    expect(urls[urls.length - 1]).toBe('/seg?u=media&n=2&c=4');

    audio.currentTime = 200; // 4 s segments: segment 51, nothing buffered there
    (handlers['seeking'] || []).forEach((f) => f());
    await new Promise((r) => setTimeout(r, 60));

    expect(aborted).toBe(1);
    // the very next request after the cancelled batch: the ramp restarts with a single segment
    expect(urls[urls.indexOf('/seg?u=media&n=2&c=4') + 1]).toBe('/seg?u=media&n=51');
    deck.dispose();
  });

  it('on a slow link asks for fewer segments than the ramp when the buffer cannot cover a bigger batch', async () => {
    // Playing, 2 s buffered; each request moves 1 MB in 400 ms (~2.5 MB/s) -> 0.4 s per 1 MB segment,
    // so (2 s - 1 s margin) / 0.4 s = 2 segments are affordable, not the ramp's 4.
    fetchSpy.and.callFake(((u: string) => {
      urls.push(u);
      return new Promise((r) => setTimeout(() => r({ ok: true, status: 200, arrayBuffer: () => Promise.resolve(new ArrayBuffer(u.includes('init') ? 1 : 1_000_000)) }), 400));
    }) as unknown as typeof fetch);
    const e = el() as unknown as { paused: boolean; buffered: { length: number; start: () => number; end: () => number } };
    e.paused = false;
    e.buffered = { length: 1, start: () => 0, end: () => 2 };
    const deck = new MusicDeck(e as unknown as HTMLAudioElement);
    await deck.load(manifest(70), 1, () => true);
    for (let i = 0; i < 100 && urls.length < 3; i++) await new Promise((r) => setTimeout(r, 20));
    expect(urls[1]).toBe('/seg?u=media&n=1');
    expect(urls[2]).toBe('/seg?u=media&n=2&c=2');
    deck.dispose();
  });
});
