// Search-as-you-type suggestions and per-type paged search.
// Owned by package P8. api/music.js dispatches here (suggest, search-type).

const {
  appToken, tidalGet, countryFor, mapTrack, mapAlbum, mapArtist, mapPlaylist,
  isBlockedId, isBlockedTrack, isBlockedAlbum, httpError,
} = require('../tidal');

const CACHE_SEARCH = 's-maxage=3600, stale-while-revalidate=600';

function queryText(q) {
  const text = String(q.q || '').trim().slice(0, 100);
  if (!text) throw httpError(400, 'missing_q');
  return text;
}

function clampInt(v, min, max, dflt) {
  const n = Number.parseInt(String(v), 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

// Upstream trouble (TIDAL denies, 5xx, not found) degrades to "no results";
// configuration and auth problems still surface as errors.
function isUpstreamDenial(e) {
  return !!e && (e.code === 'not_found' || /^tidal_error_/.test(e.code || ''));
}

async function suggest(q, req, res) {
  const text = queryText(q);
  const token = await appToken();
  let j = {};
  try {
    j = await tidalGet('/search', {
      query: text, types: 'TRACKS,ARTISTS,ALBUMS', limit: 5, countryCode: countryFor(''),
    }, token);
  } catch (e) {
    if (!isUpstreamDenial(e)) throw e;
  }
  const tracks = ((j.tracks && j.tracks.items) || []).map(mapTrack).filter((t) => !isBlockedTrack(t));
  const albums = ((j.albums && j.albums.items) || []).map(mapAlbum).filter((a) => !isBlockedAlbum(a));
  const artists = ((j.artists && j.artists.items) || []).map(mapArtist).filter((a) => !isBlockedId('artist', a.id));
  // Plain-text completions: artist names first, then titles.
  const seen = new Set();
  const terms = [];
  const add = (s) => {
    const v = String(s || '').trim();
    const k = v.toLowerCase();
    if (!v || seen.has(k) || k === text.toLowerCase()) return;
    seen.add(k);
    terms.push(v);
  };
  artists.forEach((a) => add(a.name));
  tracks.forEach((t) => add(t.title));
  albums.forEach((a) => add(a.title));
  res.setHeader('Cache-Control', CACHE_SEARCH);
  return res.json({ terms: terms.slice(0, 5), tracks, albums, artists });
}

const TYPES = {
  tracks: (x) => mapTrack(x),
  albums: (x) => mapAlbum(x),
  artists: (x) => mapArtist(x),
  playlists: (x) => mapPlaylist(x),
};

async function searchType(q, req, res) {
  const text = queryText(q);
  const type = String(q.type || '');
  if (!Object.prototype.hasOwnProperty.call(TYPES, type)) throw httpError(400, 'bad_type');
  const limit = clampInt(q.limit, 1, 50, 20);
  const offset = clampInt(q.offset, 0, 1000, 0);
  const token = await appToken();
  let j = {};
  try {
    j = await tidalGet('/search/' + type, { query: text, limit, offset, countryCode: countryFor('') }, token);
  } catch (e) {
    if (!isUpstreamDenial(e)) throw e;
  }
  const raw = Array.isArray(j.items) ? j.items : [];
  const items = raw.map(TYPES[type]).filter((x) => {
    if (type === 'tracks') return !isBlockedTrack(x);
    if (type === 'albums') return !isBlockedAlbum(x);
    if (type === 'artists') return !isBlockedId('artist', x.id);
    return !isBlockedId('playlist', x.uuid);
  });
  res.setHeader('Cache-Control', CACHE_SEARCH);
  return res.json({ items, total: Number.isFinite(j.totalNumberOfItems) ? j.totalNumberOfItems : items.length });
}

module.exports = { suggest, searchType };
