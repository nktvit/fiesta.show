import { MusicManifest } from '../services/music.service';
import { audioKind, fetchAudio, FetchLike } from './music-download-fetch';

const ok = (bytes: number[]) => Promise.resolve({ ok: true, status: 200, arrayBuffer: () => Promise.resolve(new Uint8Array(bytes).buffer) });

describe('music-download-fetch', () => {
  const manifest = { presentation: 'FULL', quality: 'LOSSLESS', signedIn: true, kind: 'segments', codec: 'flac', init: '/seg?u=init', media: '/seg?u=media', durations: [4, 4, 2] } as MusicManifest;

  it('fetches init + every numbered segment in order and reports progress', async () => {
    const urls: string[] = [];
    const progress: number[] = [];
    const f: FetchLike = (url) => {
      urls.push(url);
      const n = url.endsWith('init') ? 0 : +url.split('&n=')[1].split('&')[0];
      return ok([n]);
    };
    const a = await fetchAudio(manifest, { fetchFn: f, onProgress: (p) => progress.push(p) });
    expect(a.kind).toBe('segments');
    expect(Array.from(a.init)).toEqual([0]);
    expect(a.parts.map((p) => p[0])).toEqual([1]);
    expect(urls).toEqual(['/seg?u=init', '/seg?u=media&n=1&c=3']);
    expect(progress.length).toBe(4); // still one tick per segment + init
    expect(progress[progress.length - 1]).toBe(1);
  });

  it('a 70-segment track takes <= 12 requests and splits at 8 per batch', async () => {
    const urls: string[] = [];
    const f: FetchLike = (url) => { urls.push(url); return ok([1]); };
    const a = await fetchAudio({ ...manifest, durations: new Array(70).fill(4) }, { fetchFn: f });
    expect(urls.length).toBeLessThanOrEqual(12);
    expect(urls.length).toBe(1 + 9);
    expect(a.parts.length).toBe(9);
    expect(urls[urls.length - 1]).toBe('/seg?u=media&n=65&c=6');
  });

  it('never runs more than 2 batch fetches at once', async () => {
    let live = 0;
    let peak = 0;
    const f: FetchLike = async () => {
      live++;
      peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 5));
      live--;
      return { ok: true, status: 200, arrayBuffer: () => Promise.resolve(new ArrayBuffer(1)) };
    };
    await fetchAudio({ ...manifest, durations: new Array(40).fill(1) }, { fetchFn: f });
    expect(peak).toBeLessThanOrEqual(2);
    expect(peak).toBeGreaterThan(1);
  });

  it('retries a failing segment and then gives up', async () => {
    let calls = 0;
    const flaky: FetchLike = () => (++calls < 3 ? Promise.resolve({ ok: false, status: 502, arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)) }) : ok([1]));
    const a = await fetchAudio({ ...manifest, durations: [1] }, { fetchFn: flaky });
    expect(a.parts.length).toBe(1);
    const dead: FetchLike = () => Promise.resolve({ ok: false, status: 404, arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)) });
    await expectAsync(fetchAudio(manifest, { fetchFn: dead })).toBeRejected();
  });

  it('stops when aborted', async () => {
    const c = new AbortController();
    c.abort();
    await expectAsync(fetchAudio(manifest, { fetchFn: () => ok([1]), signal: c.signal })).toBeRejected();
  });

  it('fetches a single-file manifest', async () => {
    const a = await fetchAudio({ ...manifest, kind: 'file', codec: 'mp4a.40.2', mime: 'audio/mp4', url: '/seg?u=f' } as MusicManifest, { fetchFn: () => ok([5, 6]) });
    expect(a.kind).toBe('file');
    expect(Array.from(a.parts[0])).toEqual([5, 6]);
  });

  it('audioKind: flac codec or mime -> flac, anything else -> m4a', () => {
    expect(audioKind('flac')).toBe('flac');
    expect(audioKind('mp4a.40.2', 'audio/flac')).toBe('flac');
    expect(audioKind('mp4a.40.2', 'audio/mp4')).toBe('m4a');
  });
});
