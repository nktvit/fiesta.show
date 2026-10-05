// TIDAL access for api/music.js.
//
// Two kinds of token:
//  - the app token (client_credentials with OUR developer app): catalog calls
//    (search, albums, artists) and 30-second previews, for everyone, no login.
//  - a user token (a viewer's own subscription): full-length playback. It
//    arrives per request (header, set by the TIDAL login flow), from the owner's
//    session kept fresh by the Mac mini relay (previews and local dev; in
//    production only with MUSIC_SHARED_SESSION=1), or - in local dev and
//    previews only - from TIDAL_DEV_ACCESS_TOKEN. One personal subscription
//    must not stream to the public by accident.

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

// Whether this deployment may stream from the relay-held TIDAL session (the
// owner's personal subscription). Previews and local dev: yes. Production: no,
// unless MUSIC_SHARED_SESSION=1 is set on purpose - that makes every visitor
// listen on one personal account, so it is an explicit opt-in, not a default.
function relaySessionAllowed() {
  return process.env.VERCEL_ENV !== 'production' || process.env.MUSIC_SHARED_SESSION === '1';
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
//   2. the owner's relay-held session, where relaySessionAllowed()
//   3. TIDAL_DEV_ACCESS_TOKEN, outside production only
// `force` re-fetches from the relay (after TIDAL rejected the cached token).
async function userToken(req, force) {
  const h = req.headers['x-tidal-token'];
  if (typeof h === 'string' && h) return h.replace(/^Bearer\s+/i, '');
  if (relaySessionAllowed()) {
    const t = await relayToken(force);
    if (t) return t;
  }
  const dev = process.env.TIDAL_DEV_ACCESS_TOKEN;
  if (dev && process.env.VERCEL_ENV !== 'production' && !jwtExpired(dev)) return dev;
  return '';
}

// A dev token past its `exp` claim would only cost a rejected TIDAL round trip
// before the preview fallback, so it is skipped up front (unknown exp: try it).
function jwtExpired(token) {
  const exp = jwtClaims(token) && jwtClaims(token).exp;
  return typeof exp === 'number' && exp * 1000 < Date.now();
}

function countryFor(token) {
  const cc = token && jwtClaims(token) && jwtClaims(token).cc;
  return cc || process.env.TIDAL_COUNTRY || 'US';
}

async function tidalGet(path, query, token) {
  const url = new URL(API + path);
  for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, String(v));
  let r;
  try {
    r = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
  } catch {
    // Network failure (DNS, reset): a 502 the catalog handlers can degrade on, not a bare 500.
    throw httpError(502, 'tidal_error_network');
  }
  if (r.status === 401) throw httpError(401, 'token_expired');
  if (r.status === 404) throw httpError(404, 'not_found');
  if (!r.ok) throw httpError(502, 'tidal_error_' + r.status);
  return r.json();
}

function cover(uuid, size) {
  return uuid ? `https://resources.tidal.com/images/${String(uuid).replace(/-/g, '/')}/${size}x${size}.jpg` : '';
}

function artistList(x) {
  const list = (x && x.artists) || (x && x.artist ? [x.artist] : []);
  return list.filter((a) => a && a.id).map((a) => ({ id: a.id, name: a.name || '' }));
}

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function mapTrack(t) {
  const out = {
    id: t.id,
    title: t.title + (t.version ? ` (${t.version})` : ''),
    artist: (t.artists && t.artists.map((a) => a.name).join(', ')) || (t.artist && t.artist.name) || '',
    artistId: (t.artists && t.artists[0] && t.artists[0].id) || (t.artist && t.artist.id) || null,
    artists: artistList(t),
    album: t.album ? t.album.title : '',
    albumId: t.album ? t.album.id : null,
    cover: cover(t.album && t.album.cover, 320),
    duration: t.duration || 0,
    explicit: !!t.explicit,
    trackNumber: t.trackNumber || 0,
    quality: t.audioQuality || '',
    isrc: t.isrc || '',
    copyright: t.copyright || '',
    popularity: num(t.popularity),
    releaseDate: t.streamStartDate || (t.album && t.album.releaseDate) || '',
    version: t.version || '',
    replayGain: num(t.replayGain),
    peak: num(t.peak),
  };
  if (num(t.bpm) !== undefined) out.bpm = t.bpm;
  return out;
}

const ALBUM_TYPES = { ALBUM: 'ALBUM', EP: 'EP', SINGLE: 'SINGLE', COMPILATION: 'COMPILATION' };

function mapAlbum(a) {
  const artists = artistList(a);
  return {
    id: a.id,
    title: a.title,
    artist: (a.artists && a.artists.map((x) => x.name).join(', ')) || (a.artist && a.artist.name) || '',
    artistId: (artists[0] && artists[0].id) || null,
    artists,
    cover: cover(a.cover, 640),
    year: (a.releaseDate || '').slice(0, 4),
    tracks: a.numberOfTracks || 0,
    duration: a.duration || 0,
    quality: a.audioQuality || '',
    type: ALBUM_TYPES[a.type] || 'ALBUM',
    releaseDate: a.releaseDate || '',
    explicit: !!a.explicit,
    copyright: a.copyright || '',
    popularity: num(a.popularity),
  };
}

function mapArtist(a) {
  return {
    id: a.id,
    name: a.name,
    picture: cover(a.picture, 320),
    popularity: num(a.popularity),
    roles: Array.isArray(a.artistRoles) ? a.artistRoles.map((r) => r && r.category).filter(Boolean) : [],
  };
}

// TIDAL playlists (editorial and user-made). `squareImage` is the cover the apps
// show in grids; the wide `image` is the fallback.
function mapPlaylist(p) {
  const img = p.squareImage || p.image || '';
  return {
    uuid: p.uuid,
    title: p.title || '',
    description: p.description || '',
    cover: img ? `https://resources.tidal.com/images/${String(img).replace(/-/g, '/')}/640x640.jpg` : '',
    creator: (p.creator && p.creator.name) || (p.type === 'EDITORIAL' ? 'TIDAL' : ''),
    tracks: p.numberOfTracks || 0,
    duration: p.duration || 0,
    lastUpdated: p.lastUpdated || '',
  };
}

// Mixes ("My Mix", track/artist radio). Their images come as ready URLs.
function mapMix(m) {
  const images = m.images || {};
  const pick = (k) => images[k] && images[k].url;
  return {
    id: String(m.id),
    title: m.title || '',
    subTitle: m.subTitle || '',
    cover: pick('MEDIUM') || pick('SMALL') || pick('LARGE') || '',
    type: m.mixType || m.type || '',
  };
}

// Owner-controlled takedown list (DMCA and the like): MUSIC_BLOCKED_IDS is
// "track:1,album:2,artist:3". Parsed once per cold start.
let blockedCache = null;
function blockedSet() {
  const raw = process.env.MUSIC_BLOCKED_IDS || '';
  if (blockedCache && blockedCache.raw === raw) return blockedCache.set;
  const set = new Set();
  for (const part of raw.split(',')) {
    const m = part.trim().match(/^(track|album|artist|playlist|mix):([\w-]+)$/i);
    if (m) set.add(m[1].toLowerCase() + ':' + m[2]);
  }
  blockedCache = { raw, set };
  return set;
}

function isBlockedId(kind, id) {
  if (id === null || id === undefined || id === '') return false;
  return blockedSet().has(String(kind).toLowerCase() + ':' + String(id));
}

// Whether a mapped item (or anything it belongs to) is on the blocklist.
function isBlockedTrack(t) {
  return isBlockedId('track', t.id) || isBlockedId('album', t.albumId)
    || (t.artists || []).some((a) => isBlockedId('artist', a.id)) || isBlockedId('artist', t.artistId);
}
function isBlockedAlbum(a) {
  return isBlockedId('album', a.id) || (a.artists || []).some((x) => isBlockedId('artist', x.id)) || isBlockedId('artist', a.artistId);
}

// Hosts the image proxy may fetch from.
function isTidalImageHost(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && (u.hostname === 'resources.tidal.com' || u.hostname === 'image.tidal.com');
  } catch {
    return false;
  }
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
  mapPlaylist,
  mapMix,
  isBlockedId,
  isBlockedTrack,
  isBlockedAlbum,
  isTidalAudioHost,
  isTidalImageHost,
  httpError,
};
