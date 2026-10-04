// TIDAL access for api/music.js.
//
// Two kinds of token:
//  - the app token (client_credentials with OUR developer app): catalog calls
//    (search, albums, artists) and 30-second previews, for everyone, no login.
//  - a user token (a viewer's own subscription): full-length playback. It
//    arrives per request (header, set by the TIDAL login flow), from the owner's
//    session kept fresh by the Mac mini relay (only for requests carrying the
//    owner's unlock key), or - in local dev and previews only - from
//    TIDAL_DEV_ACCESS_TOKEN. One personal subscription must never stream to
//    the public, hence the owner gate.

const { timingSafeEqual } = require('crypto');

const TOKEN_URL = 'https://auth.tidal.com/v1/oauth2/token';
const API = 'https://api.tidal.com/v1';

let appTokenCache = { token: '', exp: 0 };

async function appToken() {
  if (appTokenCache.token && Date.now() < appTokenCache.exp - 60_000) return appTokenCache.token;
  const id = process.env.TIDAL_CLIENT_ID;
  const secret = process.env.TIDAL_CLIENT_SECRET;
  if (!id || !secret) throw httpError(500, 'tidal_not_configured');
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: 'Basic ' + Buffer.from(id + ':' + secret).toString('base64'),
    },
    body: 'grant_type=client_credentials',
  });
  if (!r.ok) throw httpError(502, 'tidal_auth_failed');
  const j = await r.json();
  appTokenCache = { token: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return appTokenCache.token;
}

function httpError(status, code) {
  const e = new Error(code);
  e.status = status;
  e.code = code;
  return e;
}

function jwtClaims(token) {
  try {
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
  } catch {
    return null;
  }
}

// Owner gate for the relay-held session: the request must carry the owner's
// unlock key (X-Music-Key, set once via /music?unlock=<key>). Without
// MUSIC_OWNER_KEY configured nobody passes.
function isOwner(req) {
  const want = process.env.MUSIC_OWNER_KEY || '';
  const got = req.headers['x-music-key'];
  if (!want || typeof got !== 'string') return false;
  const a = Buffer.from(got);
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

// The owner's TIDAL session, renewed by the Mac mini relay (tools/fiesta-proxy/
// tidal-session.mjs). Cached here until shortly before it expires.
let relaySession = { token: '', exp: 0 };

async function relayToken(force) {
  const base = (process.env.STREAM_RELAY_URL || '').replace(/\/$/, '');
  const secret = process.env.STREAM_RELAY_SECRET || '';
  if (!base || !secret) return '';
  if (!force && relaySession.token && Date.now() < relaySession.exp - 2 * 60_000) return relaySession.token;
  try {
    const r = await fetch(base + '/tidal/token', { headers: { Authorization: 'Bearer ' + secret } });
    if (!r.ok) return '';
    const j = await r.json();
    relaySession = { token: j.access_token || '', exp: j.expires_at || 0 };
    return relaySession.token;
  } catch {
    return '';
  }
}

// The token for full-length playback, or '' (-> 30 s previews only):
//   1. X-Tidal-Token: a viewer's own token (the future TIDAL login flow, tests)
//   2. the owner's relay-held session, for requests with the unlock key
//   3. TIDAL_DEV_ACCESS_TOKEN, outside production only
// `force` re-fetches from the relay (after TIDAL rejected the cached token).
async function userToken(req, force) {
  const h = req.headers['x-tidal-token'];
  if (typeof h === 'string' && h) return h.replace(/^Bearer\s+/i, '');
  if (isOwner(req)) {
    const t = await relayToken(force);
    if (t) return t;
  }
  const dev = process.env.TIDAL_DEV_ACCESS_TOKEN;
  if (dev && process.env.VERCEL_ENV !== 'production') return dev;
  return '';
}

function countryFor(token) {
  const cc = token && jwtClaims(token) && jwtClaims(token).cc;
  return cc || process.env.TIDAL_COUNTRY || 'US';
}

async function tidalGet(path, query, token) {
  const url = new URL(API + path);
  for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, String(v));
  const r = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
  if (r.status === 401) throw httpError(401, 'token_expired');
  if (r.status === 404) throw httpError(404, 'not_found');
  if (!r.ok) throw httpError(502, 'tidal_error_' + r.status);
  return r.json();
}

function cover(uuid, size) {
  return uuid ? `https://resources.tidal.com/images/${String(uuid).replace(/-/g, '/')}/${size}x${size}.jpg` : '';
}

function mapTrack(t) {
  return {
    id: t.id,
    title: t.title + (t.version ? ` (${t.version})` : ''),
    artist: (t.artists && t.artists.map((a) => a.name).join(', ')) || (t.artist && t.artist.name) || '',
    artistId: (t.artists && t.artists[0] && t.artists[0].id) || (t.artist && t.artist.id) || null,
    album: t.album ? t.album.title : '',
    albumId: t.album ? t.album.id : null,
    cover: cover(t.album && t.album.cover, 320),
    duration: t.duration || 0,
    explicit: !!t.explicit,
    trackNumber: t.trackNumber || 0,
    quality: t.audioQuality || '',
  };
}

function mapAlbum(a) {
  return {
    id: a.id,
    title: a.title,
    artist: (a.artists && a.artists.map((x) => x.name).join(', ')) || (a.artist && a.artist.name) || '',
    cover: cover(a.cover, 640),
    year: (a.releaseDate || '').slice(0, 4),
    tracks: a.numberOfTracks || 0,
    duration: a.duration || 0,
    quality: a.audioQuality || '',
  };
}

function mapArtist(a) {
  return { id: a.id, name: a.name, picture: cover(a.picture, 320) };
}

// Hosts a signed audio URL may point at; the segment proxy refuses the rest.
function isTidalAudioHost(url) {
  try {
    const h = new URL(url).hostname;
    return /(^|\.)tidal\.com$/.test(h);
  } catch {
    return false;
  }
}

module.exports = {
  appToken,
  userToken,
  countryFor,
  tidalGet,
  mapTrack,
  mapAlbum,
  mapArtist,
  isTidalAudioHost,
  httpError,
};
