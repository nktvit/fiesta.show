import { md5 } from '../utils/music-md5';
import { ScrobbleMeta, audioscrobblerSign } from './music-scrobble-core';
import {
  FetchFn, ScrobbleError, audioscrobblerSubmit, lastfmBeginWebAuth, lastfmStatus, librefmLogin, listenBrainzLove,
  listenBrainzSubmit, listenBrainzValidate, malojaScrobble,
} from './music-scrobble-providers';

const meta: ScrobbleMeta = { artist: 'Ann', title: 'Song', album: 'Alb', duration: 200, trackNumber: 1, isrc: '' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

interface Call { url: string; init?: RequestInit }
function fake(handler: (c: Call) => Response | Promise<Response>): { f: FetchFn; calls: Call[] } {
  const calls: Call[] = [];
  return { calls, f: async (url, init) => { const c = { url, init }; calls.push(c); return handler(c); } };
}

describe('ListenBrainz', () => {
  it('posts a single listen with the token', async () => {
    const { f, calls } = fake(() => json({ status: 'ok' }));
    await listenBrainzSubmit({ token: 'tok' }, 'single', meta, 100, f);
    expect(calls[0].url).toBe('https://api.listenbrainz.org/1/submit-listens');
    expect((calls[0].init?.headers as Record<string, string>)['Authorization']).toBe('Token tok');
    expect(JSON.parse(calls[0].init?.body as string).listen_type).toBe('single');
  });
  it('marks network and 5xx failures retryable, 4xx not', async () => {
    const down: FetchFn = async () => { throw new TypeError('offline'); };
    await expectAsync(listenBrainzSubmit({ token: 't' }, 'single', meta, 1, down)).toBeRejectedWith(jasmine.objectContaining({ retryable: true }));
    const five = fake(() => new Response('x', { status: 503 }));
    await expectAsync(listenBrainzSubmit({ token: 't' }, 'single', meta, 1, five.f)).toBeRejectedWith(jasmine.objectContaining({ retryable: true }));
    const four = fake(() => new Response('bad', { status: 401 }));
    await expectAsync(listenBrainzSubmit({ token: 't' }, 'single', meta, 1, four.f)).toBeRejectedWith(jasmine.objectContaining({ retryable: false }));
  });
  it('loves through a metadata lookup then feedback', async () => {
    const { f, calls } = fake((c) => (c.url.includes('/metadata/lookup/') ? json({ recording_mbid: 'abc' }) : json({ status: 'ok' })));
    await listenBrainzLove({ token: 't' }, meta, f);
    expect(calls.length).toBe(2);
    expect(JSON.parse(calls[1].init?.body as string)).toEqual({ recording_mbid: 'abc', score: 1 });
  });
  it('does not retry a love with no recording', async () => {
    const { f } = fake(() => json({}));
    await expectAsync(listenBrainzLove({ token: 't' }, meta, f)).toBeRejectedWith(jasmine.objectContaining({ retryable: false }));
  });
  it('validates tokens', async () => {
    expect(await listenBrainzValidate('t', undefined, fake(() => json({ valid: true, user_name: 'me' })).f)).toEqual({ valid: true, user: 'me' });
    expect((await listenBrainzValidate('t', undefined, fake(() => json({ valid: false }, 200)).f)).valid).toBeFalse();
    expect((await listenBrainzValidate('t', undefined, async () => { throw new Error('x'); })).valid).toBeNull();
  });
});

describe('Maloja', () => {
  it('posts a form to mlj_1 and falls back to native on 404', async () => {
    const { f, calls } = fake((c) => (c.url.includes('mlj_1') ? new Response('no', { status: 404 }) : json({ status: 'success' })));
    await malojaScrobble({ url: 'https://m.test/', key: 'K' }, meta, 9, f);
    expect(calls.map((c) => c.url)).toEqual(['https://m.test/apis/mlj_1/newscrobble', 'https://m.test/apis/native/newscrobble']);
    expect(String(calls[0].init?.body)).toContain('key=K');
  });
});

describe('Last.fm (server signed)', () => {
  it('posts {method, params} to the proxy and never sends a secret', async () => {
    const { f, calls } = fake(() => json({ scrobbles: {} }));
    await audioscrobblerSubmit('lastfm', 'SK', 'scrobble', meta, 77, f);
    expect(calls[0].url).toBe('/api/music?action=lastfm');
    const body = JSON.parse(calls[0].init?.body as string);
    expect(body.method).toBe('track.scrobble');
    expect(body.params.sk).toBe('SK');
    expect(body.params.timestamp).toBe('77');
    expect(JSON.stringify(body)).not.toContain('api_sig');
  });
  it('reports a missing site key', async () => {
    const { f } = fake(() => json({ error: 'lastfm_not_configured' }, 503));
    await expectAsync(audioscrobblerSubmit('lastfm', 'SK', 'love', meta, 0, f)).toBeRejectedWith(jasmine.objectContaining({ retryable: false, code: 503 }));
    expect(await lastfmStatus(f)).toEqual({ configured: false, apiKey: '' });
    expect(await lastfmStatus(fake(() => json({ configured: true, apiKey: 'pub' })).f)).toEqual({ configured: true, apiKey: 'pub' });
  });
  it('treats rate limits as retryable and bad sessions as final', async () => {
    await expectAsync(audioscrobblerSubmit('lastfm', 'S', 'scrobble', meta, 1, fake(() => json({ error: 29, message: 'rate' })).f)).toBeRejectedWith(jasmine.objectContaining({ retryable: true }));
    await expectAsync(audioscrobblerSubmit('lastfm', 'S', 'scrobble', meta, 1, fake(() => json({ error: 9, message: 'bad session' })).f)).toBeRejectedWith(jasmine.objectContaining({ retryable: false }));
  });
  it('builds the web auth url from the public key', async () => {
    const r = await lastfmBeginWebAuth('pub', fake(() => json({ token: 'TKN' })).f);
    expect(r.url).toBe('https://www.last.fm/api/auth/?api_key=pub&token=TKN');
  });
});

describe('Libre.fm (client signed)', () => {
  it('signs requests with an md5 the service can verify', async () => {
    const { f, calls } = fake(() => json({}));
    await audioscrobblerSubmit('librefm', 'SK', 'love', meta, 0, f);
    const form = new URLSearchParams(String(calls[0].init?.body));
    const sent: Record<string, string> = {};
    form.forEach((v, k) => { if (k !== 'api_sig') sent[k] = v; });
    expect(form.get('api_sig')).toBe(audioscrobblerSign(sent, 'streamfiesta-libre-fm-client', md5));
    expect(form.get('method')).toBe('track.love');
    expect(form.get('sk')).toBe('SK');
  });
  it('logs in with a hashed token, never the password', async () => {
    const { f, calls } = fake(() => json({ session: { key: 'K', name: 'me' } }));
    const s = await librefmLogin('me', 'hunter2', f);
    expect(s).toEqual({ session: 'K', name: 'me' });
    const body = String(calls[0].init?.body);
    expect(body).not.toContain('hunter2');
    expect(new URLSearchParams(body).get('authToken')).toBe(md5('me' + md5('hunter2')));
  });
  it('surfaces service errors', async () => {
    await expectAsync(librefmLogin('me', 'x', fake(() => json({ error: 4, message: 'Invalid authentication token supplied' })).f)).toBeRejectedWithError(ScrobbleError);
  });
});
