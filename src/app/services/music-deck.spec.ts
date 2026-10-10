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
    preload: '', src: '', currentTime: 0, buffered: { length: 0, start: () => 0, end: () => 0 },
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
});
