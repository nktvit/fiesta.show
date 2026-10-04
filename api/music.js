// Music tab backend (TIDAL). One function, `action` picks the route:
//   search   ?q=               tracks + albums + artists (app token, no login)
//   album    ?id=              album + its tracks
//   artist   ?id=              artist + top tracks + albums
//   manifest ?id=&quality=     how to play a track: segment list + proxied URLs
//   seg      ?u=<b64>[&n=]     audio bytes, proxied (TIDAL's CDN 403s a browser Origin)
// Full-length playback needs the viewer's own token (see lib/tidal.js);
// without one TIDAL hands out 30-second previews and `manifest` says so.

const {
  appToken, userToken, countryFor, tidalGet, mapTrack, mapAlbum, mapArtist, isTidalAudioHost, httpError,
} = require('../lib/tidal');

const CACHE = {
  search: 's-maxage=3600, stale-while-revalidate=600',
  album: 's-maxage=86400, stale-while-revalidate=3600',
  artist: 's-maxage=86400, stale-while-revalidate=3600',
};

const QUALITIES = { LOW: 'LOW', HIGH: 'HIGH', LOSSLESS: 'LOSSLESS' };

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'X-Tidal-Token, Range, Accept, Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const q = req.query || {};
  try {
    switch (q.action) {
      case 'search': return await search(q, res);
      case 'album': return await album(q, res);
      case 'artist': return await artist(q, res);
      case 'manifest': return await manifest(q, req, res);
      case 'seg': return await seg(q, req, res);
      default: return res.status(400).json({ error: 'unknown_action' });
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
    tracks: ((j.tracks && j.tracks.items) || []).map(mapTrack),
    albums: ((j.albums && j.albums.items) || []).map(mapAlbum),
    artists: ((j.artists && j.artists.items) || []).map(mapArtist),
  });
}

async function album(q, res) {
  const id = numericId(q.id);
  const token = await appToken();
  const cc = countryFor('');
  const [a, items] = await Promise.all([
    tidalGet(`/albums/${id}`, { countryCode: cc }, token),
    tidalGet(`/albums/${id}/items`, { countryCode: cc, limit: 100 }, token),
  ]);
  res.setHeader('Cache-Control', CACHE.album);
  return res.json({
    album: mapAlbum(a),
    tracks: (items.items || []).filter((i) => i.type === 'track').map((i) => mapTrack(i.item)),
  });
}

async function artist(q, res) {
  const id = numericId(q.id);
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
    topTracks: (top.items || []).map(mapTrack),
    albums: (albums.items || []).map(mapAlbum),
  });
}

async function manifest(q, req, res) {
  const id = numericId(q.id);
  const quality = QUALITIES[q.quality] || 'LOSSLESS';
  const user = userToken(req);
  const token = user || (await appToken());
  const info = await tidalGet(`/tracks/${id}/playbackinfo`, {
    audioquality: quality, playbackmode: 'STREAM', assetpresentation: 'FULL',
  }, token);
  const body = Buffer.from(info.manifest, 'base64').toString();
  const base = {
    presentation: info.assetPresentation, // FULL | PREVIEW
    quality: info.audioQuality,
    signedIn: !!user,
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

function numericId(v) {
  if (!/^\d{1,12}$/.test(String(v || ''))) throw httpError(400, 'bad_id');
  return String(v);
}
