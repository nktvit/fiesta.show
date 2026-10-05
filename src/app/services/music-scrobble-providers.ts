// Ported from Monochrome (Apache-2.0), js/listenbrainz.js, js/maloja.js, js/librefm.js, js/lastfm.js - adapted for Fiesta.
import { md5 } from '../utils/music-md5';
import {
  ScrobbleMeta, ScrobbleServiceId, audioscrobblerParams, audioscrobblerSign, listenBrainzPayload, malojaForm,
} from './music-scrobble-core';

// Credentials are the visitor's own; Last.fm requests are signed on the server (/api/music?action=lastfm).

/** A failed submission. `retryable` ones go to the offline queue. */
export class ScrobbleError extends Error {
  constructor(message: string, readonly retryable: boolean, readonly code = 0) {
    super(message);
  }
}

export interface ListenBrainzCreds { token: string; url?: string }
export interface MalojaCreds { url: string; key: string }
export interface SessionCreds { session: string; name: string }
export interface LastfmCreds extends SessionCreds { pendingToken?: string }

/** Everything stored under fiesta:music:secret:scrobble-creds. */
export interface ScrobbleCreds {
  listenbrainz?: ListenBrainzCreds;
  maloja?: MalojaCreds;
  librefm?: SessionCreds;
  lastfm?: Partial<LastfmCreds>;
}

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;
const defaultFetch: FetchFn = (input, init) => fetch(input, init);

/** Fiesta's own Libre.fm app strings: Libre.fm accepts any key/secret, so these are not credentials. */
export const LIBREFM_API_KEY = 'streamfiesta';
export const LIBREFM_API_SECRET = 'streamfiesta-libre-fm-client';
const LIBREFM_URL = 'https://libre.fm/2.0/';
export const LISTENBRAINZ_DEFAULT_URL = 'https://api.listenbrainz.org';
const LASTFM_PROXY = '/api/music?action=lastfm';

function failFromStatus(service: string, status: number, detail = ''): ScrobbleError {
  const retryable = status >= 500 || status === 429 || status === 408 || status === 0;
  return new ScrobbleError(`${service} answered ${status}${detail ? ': ' + detail.slice(0, 120) : ''}`, retryable, status);
}

async function send(f: FetchFn, service: string, url: string, init: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await f(url, init);
  } catch {
    throw new ScrobbleError(`${service} could not be reached`, true);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw failFromStatus(service, res.status, text);
  }
  return res;
}

// ── ListenBrainz ───────────────────────────────────────────────────────────

export function listenBrainzBase(c: ListenBrainzCreds): string {
  return (c.url || LISTENBRAINZ_DEFAULT_URL).replace(/\/+$/, '').replace(/\/1$/, '');
}

export async function listenBrainzSubmit(c: ListenBrainzCreds, type: 'single' | 'playing_now', meta: ScrobbleMeta, ts: number, f: FetchFn = defaultFetch): Promise<void> {
  await send(f, 'ListenBrainz', `${listenBrainzBase(c)}/1/submit-listens`, {
    method: 'POST',
    headers: { Authorization: `Token ${c.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(listenBrainzPayload(type, meta, ts)),
  });
}

/** Loves a track through recording feedback (needs the recording MBID, found by metadata lookup). */
export async function listenBrainzLove(c: ListenBrainzCreds, meta: ScrobbleMeta, f: FetchFn = defaultFetch): Promise<void> {
  const base = listenBrainzBase(c);
  const headers = { Authorization: `Token ${c.token}` };
  const find = async (withAlbum: boolean): Promise<string> => {
    const qs = new URLSearchParams({ recording_name: meta.title, artist_name: meta.artist });
    if (withAlbum && meta.album) qs.set('release_name', meta.album);
    try {
      const res = await f(`${base}/1/metadata/lookup/?${qs}`, { headers });
      if (!res.ok) return '';
      const data = (await res.json()) as { recording_mbid?: string };
      return data.recording_mbid || '';
    } catch {
      return '';
    }
  };
  const mbid = (await find(true)) || (meta.album ? await find(false) : '');
  if (!mbid) throw new ScrobbleError('ListenBrainz has no recording for this track', false);
  await send(f, 'ListenBrainz', `${base}/1/feedback/recording-feedback`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ recording_mbid: mbid, score: 1 }),
  });
}

/** Checks a token. `valid:null` means the server could not be reached. */
export async function listenBrainzValidate(token: string, url?: string, f: FetchFn = defaultFetch): Promise<{ valid: boolean | null; user: string }> {
  try {
    const res = await f(`${listenBrainzBase({ token, url })}/1/validate-token`, { headers: { Authorization: `Token ${token}` } });
    if (!res.ok) return { valid: false, user: '' };
    const data = (await res.json()) as { valid?: boolean; user_name?: string };
    return { valid: !!data.valid, user: data.user_name || '' };
  } catch {
    return { valid: null, user: '' };
  }
}

// ── Maloja ─────────────────────────────────────────────────────────────────

export async function malojaScrobble(c: MalojaCreds, meta: ScrobbleMeta, ts: number, f: FetchFn = defaultFetch): Promise<void> {
  const body = new URLSearchParams(malojaForm(meta, ts, c.key));
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
  const base = c.url.replace(/\/+$/, '');
  try {
    await send(f, 'Maloja', `${base}/apis/mlj_1/newscrobble`, { method: 'POST', headers, body });
  } catch (e) {
    // Older Maloja servers only know the native API.
    if (e instanceof ScrobbleError && !e.retryable && (e.code === 404 || e.code === 405)) {
      await send(f, 'Maloja', `${base}/apis/native/newscrobble`, { method: 'POST', headers, body });
      return;
    }
    throw e;
  }
}

// ── Last.fm and Libre.fm (audioscrobbler 2.0) ──────────────────────────────

interface Audioscrobbler2Reply {
  error?: number;
  message?: string;
  [k: string]: unknown;
}

/** Last.fm error codes worth retrying: 11 offline, 16 temporary, 29 rate limit. */
function checkReply(service: string, data: Audioscrobbler2Reply): Audioscrobbler2Reply {
  if (typeof data.error === 'number') {
    throw new ScrobbleError(`${service}: ${data.message || 'error ' + data.error}`, [11, 16, 29].includes(data.error), data.error);
  }
  return data;
}

/** Calls Last.fm through the server, which signs with its secret. */
export async function lastfmCall(method: string, params: Record<string, string> = {}, f: FetchFn = defaultFetch): Promise<Audioscrobbler2Reply> {
  const res = await send(f, 'Last.fm', LASTFM_PROXY, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method, params }),
  }).catch((e) => {
    if (e instanceof ScrobbleError && e.code === 503) throw new ScrobbleError('Last.fm is not configured on this site', false, 503);
    throw e;
  });
  return checkReply('Last.fm', (await res.json()) as Audioscrobbler2Reply);
}

/** Whether this site has Last.fm keys; the api key is public. */
export async function lastfmStatus(f: FetchFn = defaultFetch): Promise<{ configured: boolean; apiKey: string }> {
  try {
    const res = await f(LASTFM_PROXY, { headers: { Accept: 'application/json' } });
    if (!res.ok) return { configured: false, apiKey: '' };
    const data = (await res.json()) as { configured?: boolean; apiKey?: string };
    return { configured: !!data.configured, apiKey: data.apiKey || '' };
  } catch {
    return { configured: false, apiKey: '' };
  }
}

/** Libre.fm signs in the browser; any key/secret string is accepted by the service. */
export async function librefmCall(method: string, params: Record<string, string> = {}, f: FetchFn = defaultFetch): Promise<Audioscrobbler2Reply> {
  const signed: Record<string, string> = { ...params, method, api_key: LIBREFM_API_KEY };
  const body = new URLSearchParams({ ...signed, api_sig: audioscrobblerSign(signed, LIBREFM_API_SECRET, md5), format: 'json' });
  const res = await send(f, 'Libre.fm', LIBREFM_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  return checkReply('Libre.fm', (await res.json()) as Audioscrobbler2Reply);
}

/** Libre.fm password login; the password is only hashed here and never kept. */
export async function librefmLogin(username: string, password: string, f: FetchFn = defaultFetch): Promise<SessionCreds> {
  const user = username.trim();
  const authToken = md5(user + md5(password));
  const data = await librefmCall('auth.getMobileSession', { username: user, authToken }, f);
  return sessionFrom('Libre.fm', data);
}

/** Last.fm password login (auth.getMobileSession); the server signs it and nothing is kept but the session. */
export async function lastfmLogin(username: string, password: string, f: FetchFn = defaultFetch): Promise<SessionCreds> {
  const data = await lastfmCall('auth.getMobileSession', { username: username.trim(), password }, f);
  return sessionFrom('Last.fm', data);
}

export function sessionFrom(service: string, data: Audioscrobbler2Reply): SessionCreds {
  const s = data['session'] as { key?: string; name?: string } | undefined;
  if (!s?.key) throw new ScrobbleError(`${service} did not return a session`, false);
  return { session: s.key, name: s.name || '' };
}

/** Step 1 of the Last.fm web flow: a token and the page the visitor approves it on. */
export async function lastfmBeginWebAuth(apiKey: string, f: FetchFn = defaultFetch): Promise<{ token: string; url: string }> {
  const data = await lastfmCall('auth.getToken', {}, f);
  const token = typeof data['token'] === 'string' ? data['token'] : '';
  if (!token) throw new ScrobbleError('Last.fm did not return a token', false);
  return { token, url: `https://www.last.fm/api/auth/?api_key=${encodeURIComponent(apiKey)}&token=${encodeURIComponent(token)}` };
}

/** Step 2: trade the approved token for a session. */
export async function lastfmFinishWebAuth(token: string, f: FetchFn = defaultFetch): Promise<SessionCreds> {
  return sessionFrom('Last.fm', await lastfmCall('auth.getSession', { token }, f));
}

/** One nowplaying / scrobble / love call for Last.fm or Libre.fm. */
export async function audioscrobblerSubmit(
  service: Extract<ScrobbleServiceId, 'lastfm' | 'librefm'>,
  session: string,
  kind: 'nowplaying' | 'scrobble' | 'love',
  meta: ScrobbleMeta,
  ts: number,
  f: FetchFn = defaultFetch,
): Promise<void> {
  const method = kind === 'nowplaying' ? 'track.updateNowPlaying' : kind === 'scrobble' ? 'track.scrobble' : 'track.love';
  const params = { ...audioscrobblerParams(kind, meta, ts), sk: session };
  if (service === 'lastfm') await lastfmCall(method, params, f);
  else await librefmCall(method, params, f);
}
