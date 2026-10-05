// Music tab backend (TIDAL). One function, `action` picks the route:
//   search   ?q=               tracks + albums + artists (app token, no login)
//   album    ?id=              album + its tracks
//   artist   ?id=              artist + top tracks + albums
//   manifest ?id=&quality=     how to play a track: segment list + proxied URLs,
//                              plus TIDAL's ReplayGain/peak values when present
//                              (quality: LOW | HIGH | LOSSLESS | HI_RES_LOSSLESS)
//   seg      ?u=<b64>[&n=]     audio bytes, proxied (TIDAL's CDN 403s a browser Origin)
//   img      ?u=<b64url>       cover bytes from resources.tidal.com / image.tidal.com
//                              with CORS, so canvases can read them (dynamic colour,
//                              visualizer); any other host is a 400
// Handled by lib/music/<area>.js (owned by the packages named there):
//   suggest, search-type                                      lib/music/search.js
//   track, tracks, album-extras, artist-bio, similar-artists,
//   similar-albums, artist-albums, artist-toptracks,
//   artist-links, artist-images, aoty                         lib/music/catalog.js
//   mix, track-mix, artist-mix, playlist, explore, page       lib/music/discovery.js
//   lastfm (GET or POST)                                      lib/music/scrobble.js
// Full-length playback needs the viewer's own token (see lib/tidal.js);
// without one TIDAL hands out 30-second previews and `manifest` says so.
// MUSIC_BLOCKED_IDS ("track:1,album:2,artist:3") hides items from search, album
// and artist results; a blocked track's manifest is a 451.

const {
  appToken, userToken, countryFor, tidalGet, mapTrack, mapAlbum, mapArtist, isTidalAudioHost, isTidalImageHost,
  isBlockedId, isBlockedTrack, isBlockedAlbum, httpError,
} = require('../lib/tidal');
const search_ = require('../lib/music/search');
const catalog = require('../lib/music/catalog');
const { isArtistImageHost } = require('../lib/music/artist-images');
const discovery = require('../lib/music/discovery');
const scrobble = require('../lib/music/scrobble');

const CACHE = {
  search: 's-maxage=3600, stale-while-revalidate=600',
  album: 's-maxage=86400, stale-while-revalidate=3600',
  artist: 's-maxage=86400, stale-while-revalidate=3600',
};

const QUALITIES = { LOW: 'LOW', HIGH: 'HIGH', LOSSLESS: 'LOSSLESS', HI_RES_LOSSLESS: 'HI_RES_LOSSLESS' };

// Kebab-case action -> [module, camelCase export].
const DELEGATED = {
  suggest: [search_, 'suggest'],
  'search-type': [search_, 'searchType'],
  track: [catalog, 'track'],
  tracks: [catalog, 'tracks'],
  'album-extras': [catalog, 'albumExtras'],
  'artist-bio': [catalog, 'artistBio'],
  'similar-artists': [catalog, 'similarArtists'],
  'similar-albums': [catalog, 'similarAlbums'],
  'artist-albums': [catalog, 'artistAlbums'],
  'artist-toptracks': [catalog, 'artistTopTracks'],
  'artist-links': [catalog, 'artistLinks'],
  'artist-images': [catalog, 'artistImages'],
  aoty: [catalog, 'aoty'],
  mix: [discovery, 'mix'],
  'track-mix': [discovery, 'trackMix'],
  'artist-mix': [discovery, 'artistMix'],
  playlist: [discovery, 'playlist'],
  explore: [discovery, 'explore'],
  page: [discovery, 'page'],
  lastfm: [scrobble, 'lastfm'],
};

// Only these actions accept POST (form bodies for signed Last.fm calls).
const POST_ACTIONS = new Set(['lastfm']);

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'X-Tidal-Token, Range, Accept, Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const q = req.query || {};
  try {
    if (req.method === 'POST' && !POST_ACTIONS.has(q.action)) throw httpError(405, 'method_not_allowed');
    switch (q.action) {
      case 'search': return await search(q, res);
      case 'album': return await album(q, res);
      case 'artist': return await artist(q, res);
      case 'manifest': return await manifest(q, req, res);
      case 'seg': return await seg(q, req, res);
      case 'img': return await img(q, res);
      default: {
        const route = Object.prototype.hasOwnProperty.call(DELEGATED, q.action) ? DELEGATED[q.action] : null;
        if (!route) return res.status(400).json({ error: 'unknown_action' });
        return await route[0][route[1]](q, req, res);
      }
    }
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) console.error('music api:', e.code || e.message);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(status).json({ error: e.code || 'server_error' });
  }
};

async function search(q, res) {
  const text = String(q.q || '').trim().slice(0, 100);
  if (!text) return res.status(400).json({ error: 'missing_q' });
  const token = await appToken();
  const j = await tidalGet('/search', {
    query: text, types: 'TRACKS,ALBUMS,ARTISTS', limit: 20, countryCode: countryFor(''),
  }, token);
  res.setHeader('Cache-Control', CACHE.search);
  return res.json({
    tracks: ((j.tracks && j.tracks.items) || []).map(mapTrack).filter((t) => !isBlockedTrack(t)),
    albums: ((j.albums && j.albums.items) || []).map(mapAlbum).filter((a) => !isBlockedAlbum(a)),
    artists: ((j.artists && j.artists.items) || []).map(mapArtist).filter((a) => !isBlockedId('artist', a.id)),
  });
}

async function album(q, res) {
  const id = numericId(q.id);
  if (isBlockedId('album', id)) throw httpError(451, 'blocked');
  const token = await appToken();
  const cc = countryFor('');
  const [a, items] = await Promise.all([
    tidalGet(`/albums/${id}`, { countryCode: cc }, token),
    tidalGet(`/albums/${id}/items`, { countryCode: cc, limit: 100 }, token),
  ]);
  const mapped = mapAlbum(a);
  if (isBlockedAlbum(mapped)) throw httpError(451, 'blocked');
  res.setHeader('Cache-Control', CACHE.album);
  return res.json({
    album: mapped,
    tracks: (items.items || []).filter((i) => i.type === 'track').map((i) => mapTrack(i.item)).filter((t) => !isBlockedTrack(t)),
  });
}

async function artist(q, res) {
  const id = numericId(q.id);
  if (isBlockedId('artist', id)) throw httpError(451, 'blocked');
  const token = await appToken();
  const cc = countryFor('');
  const [a, top, albums] = await Promise.all([
    tidalGet(`/artists/${id}`, { countryCode: cc }, token),
    tidalGet(`/artists/${id}/toptracks`, { countryCode: cc, limit: 10 }, token),
    tidalGet(`/artists/${id}/albums`, { countryCode: cc, limit: 30 }, token),
  ]);
  res.setHeader('Cache-Control', CACHE.artist);
  return res.json({
    artist: mapArtist(a),
    topTracks: (top.items || []).map(mapTrack).filter((t) => !isBlockedTrack(t)),
    albums: (albums.items || []).map(mapAlbum).filter((al) => !isBlockedAlbum(al)),
  });
}

async function manifest(q, req, res) {
  const id = numericId(q.id);
  if (isBlockedId('track', id)) throw httpError(451, 'blocked');
  const quality = QUALITIES[q.quality] || 'LOSSLESS';
  let user = await userToken(req);
  const query = { audioquality: quality, playbackmode: 'STREAM', assetpresentation: 'FULL' };
  let info;
  try {
    info = await tidalGet(`/tracks/${id}/playbackinfo`, query, user || (await appToken()));
  } catch (e) {
    // The cached relay session can be rejected before it "expires" (TIDAL revoked
    // it, or the relay renewed meanwhile): ask the relay for a fresh one, once.
    if (e.code !== 'token_expired' || !user || req.headers['x-tidal-token']) throw e;
    user = await userToken(req, true);
    info = null;
    if (user) {
      try {
        info = await tidalGet(`/tracks/${id}/playbackinfo`, query, user);
      } catch (e2) {
        if (e2.code !== 'token_expired') throw e2;
      }
    }
    // A dead server-side session (expired TIDAL_DEV_ACCESS_TOKEN, relay down) must
    // not break playback: fall back to the app token, i.e. 30 s previews.
    if (!info) {
      user = '';
      info = await tidalGet(`/tracks/${id}/playbackinfo`, query, await appToken());
    }
  }
  const body = Buffer.from(info.manifest, 'base64').toString();
  const base = {
    presentation: info.assetPresentation, // FULL | PREVIEW
    quality: info.audioQuality,
    signedIn: !!user,
    // Loudness normalisation (dB) and peaks (linear), when TIDAL provides them.
    ...gainFields(info),
  };
  res.setHeader('Cache-Control', 'no-store');

  if (info.manifestMimeType === 'application/dash+xml') {
    const attr = (re) => { const m = body.match(re); return m ? m[1].replace(/&amp;/g, '&') : ''; };
    const init = attr(/initialization="([^"]+)"/);
    const media = attr(/media="([^"]+)"/);
    if (!isTidalAudioHost(init) || !isTidalAudioHost(media)) throw httpError(502, 'bad_manifest');
    const timescale = +attr(/timescale="(\d+)"/) || 1;
    const durations = [];
    for (const m of body.matchAll(/<S d="(\d+)"(?: r="(\d+)")?/g)) {
      for (let i = 0; i <= (+m[2] || 0); i++) durations.push(+m[1] / timescale);
    }
    return res.json({
      ...base,
      kind: 'segments',
      codec: attr(/codecs="([^"]+)"/) || 'flac',
      sampleRate: +attr(/audioSamplingRate="(\d+)"/) || 44100,
      init: segUrl(init),
      media: segUrl(media), // contains $Number$ via the b64 payload on the server side
      durations,
    });
  }

  // Older progressive manifests (AAC, application/vnd.tidal.bts): one file.
  const bts = JSON.parse(body);
  const url = bts.urls && bts.urls[0];
  if (!url || !isTidalAudioHost(url)) throw httpError(502, 'bad_manifest');
  return res.json({ ...base, kind: 'file', codec: bts.codecs, mime: bts.mimeType, url: segUrl(url) });
}

function gainFields(info) {
  const out = {};
  for (const k of ['trackReplayGain', 'trackPeakAmplitude', 'albumReplayGain', 'albumPeakAmplitude']) {
    if (typeof info[k] === 'number' && Number.isFinite(info[k])) out[k] = info[k];
  }
  return out;
}

function segUrl(target) {
  return '/api/music?action=seg&u=' + Buffer.from(target).toString('base64url');
}

async function seg(q, req, res) {
  const target = Buffer.from(String(q.u || ''), 'base64url').toString().replace('$Number$', String(+q.n || 0));
  if (!isTidalAudioHost(target)) return res.status(400).json({ error: 'bad_target' });
  const headers = {};
  if (req.headers.range) headers.Range = req.headers.range;
  const r = await fetch(target, { headers });
  if (!r.ok && r.status !== 206) return res.status(r.status === 404 ? 404 : 502).json({ error: 'upstream_' + r.status });
  for (const h of ['content-type', 'content-range', 'accept-ranges']) {
    const v = r.headers.get(h);
    if (v) res.setHeader(h, v);
  }
  // The URL is signed and short-lived but also unique per track+segment, so a
  // viewer's browser can reuse it (seek back) for a while.
  res.setHeader('Cache-Control', 'private, max-age=1800');
  res.status(r.status).end(Buffer.from(await r.arrayBuffer()));
}

// Cover art through our origin with CORS, so the client can draw it on a canvas
// (dynamic colour, visualizer). Only TIDAL's image hosts; anything else is a 400.
async function img(q, res) {
  let target = '';
  try {
    target = Buffer.from(String(q.u || ''), 'base64url').toString();
  } catch {
    target = '';
  }
  if (!isTidalImageHost(target) && !isArtistImageHost(target)) throw httpError(400, 'bad_target');
  const get = () => fetch(target, { headers: { 'User-Agent': 'StreamFiesta/1.0 (+https://streamfiesta.vercel.app)' } });
  let r = await get();
  // Artist-photo CDNs (Deezer, Wikimedia) now and then answer 403/429/5xx under bursts: two retries.
  for (const wait of [400, 1200]) {
    if (r.ok || r.status === 404) break;
    r = await new Promise((res) => setTimeout(res, wait)).then(get);
  }
  const type = r.headers.get('content-type') || '';
  if (!r.ok) throw httpError(r.status === 404 ? 404 : 502, 'upstream_' + r.status);
  if (!/^image\//.test(type)) throw httpError(502, 'not_an_image');
  res.setHeader('Content-Type', type);
  res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
  res.status(200).end(Buffer.from(await r.arrayBuffer()));
}

function numericId(v) {
  if (!/^\d{1,12}$/.test(String(v || ''))) throw httpError(400, 'bad_id');
  return String(v);
}
