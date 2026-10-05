// Discovery: mixes, track/artist radio, TIDAL playlists, explore and pages.
// Owned by package P9. api/music.js dispatches here; each handler is async
// (q, req, res): q is req.query, respond with res.json(...) and set Cache-Control.
// Errors are thrown with httpError(status, code) (api/music.js turns them into {error}).
//
// Everything here reads api.tidal.com/v1 (then tidal.com/v1 as a second host) with the
// app token. When TIDAL denies or fails a read we degrade to an empty 200 result
// ('no-store', so the empty answer is never cached) instead of a 500. A genuine 404
// (unknown mix / playlist) stays a 404.

const {
  appToken, countryFor, mapTrack, mapAlbum, mapArtist, mapPlaylist, mapMix,
  isBlockedId, isBlockedTrack, isBlockedAlbum, httpError,
} = require('../tidal');

const HOSTS = ['https://api.tidal.com/v1', 'https://tidal.com/v1'];
const CATALOG = 's-maxage=86400, stale-while-revalidate=3600';
const SHELVES = 's-maxage=3600, stale-while-revalidate=600';
const NO_STORE = 'no-store';

const PLAYLIST_PAGE = 100;
const MAX_RADIO = 100;

const reNumeric = /^\d{1,12}$/;
const reUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const reMix = /^[0-9a-f]{16,40}$/i;
// Explore drill-down: "pages/<slug>" (genres, moods, decades, "explore_*"), nothing else.
const rePage = /^pages\/[a-z0-9_-]{1,64}$/;

function numericId(v) {
  if (!reNumeric.test(String(v || ''))) throw httpError(400, 'bad_id');
  return String(v);
}
function uuid(v) {
  const s = String(v || '');
  if (!reUuid.test(s)) throw httpError(400, 'bad_id');
  return s.toLowerCase();
}
function mixId(v) {
  const s = String(v || '');
  if (!reMix.test(s)) throw httpError(400, 'bad_id');
  return s.toLowerCase();
}
function clampInt(v, min, max, dflt) {
  const n = Number.parseInt(String(v), 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

// One GET against TIDAL v1: tries each host in turn. Returns the parsed body,
// throws httpError(404, 'not_found') on a 404 and an Error with .denied on any
// other failure (callers turn that into an empty result).
async function v1(path, query) {
  const token = await appToken();
  const cc = countryFor('');
  let notFound = false;
  let last = null;
  for (const host of HOSTS) {
    const url = new URL(host + path);
    url.searchParams.set('countryCode', cc);
    for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, String(v));
    try {
      const r = await fetch(url, {
        headers: { Authorization: 'Bearer ' + token },
        signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined,
      });
      if (r.status === 404) { notFound = true; continue; }
      if (!r.ok) { last = new Error('tidal_' + r.status); continue; }
      return await r.json();
    } catch (e) {
      last = e;
    }
  }
  if (notFound && !last) throw httpError(404, 'not_found');
  const e = last || new Error('tidal_unreachable');
  e.denied = true;
  throw e;
}

// Like v1 but a denial or a miss is `null` (404 included): for best-effort reads.
async function v1OrNull(path, query) {
  try {
    return await v1(path, query);
  } catch {
    return null;
  }
}

function isTrack(x) { return x && typeof x === 'object' && x.id && x.title !== undefined; }

// Items of a mix / playlist list come as {item, type} or as bare tracks.
function trackItems(items) {
  const out = [];
  for (const x of Array.isArray(items) ? items : []) {
    if (x && x.type && x.type !== 'track') continue;
    const t = x && x.item ? x.item : x;
    if (isTrack(t)) out.push(t);
  }
  return out;
}

function mapTracks(raw) {
  return trackItems(raw).map(mapTrack).filter((t) => !isBlockedTrack(t));
}

function dedupe(tracks, exclude) {
  const seen = new Set(exclude || []);
  const out = [];
  for (const t of tracks) {
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    out.push(t);
  }
  return out;
}

// Tracks of a TIDAL mix id (radio), best effort.
async function mixTracks(id) {
  const j = await v1OrNull(`/mixes/${id}/items`, { deviceType: 'BROWSER' });
  return j ? mapTracks(j.items) : [];
}

// "Similar artists' top tracks" fallback for radio: round-robin across the artists.
async function similarArtistTracks(artistIds, perArtist, seedArtistFirst) {
  const lists = [];
  const seenArtists = new Set();
  for (const id of artistIds) {
    if (!id || seenArtists.has(String(id))) continue;
    seenArtists.add(String(id));
    const sim = await v1OrNull(`/artists/${id}/similar`, { limit: 6 });
    const similar = ((sim && sim.items) || []).map((a) => a.id).filter(Boolean).slice(0, 5);
    const ids = seedArtistFirst ? [id, ...similar] : similar;
    const tops = await Promise.all(ids.map((a) => v1OrNull(`/artists/${a}/toptracks`, { limit: perArtist })));
    for (const t of tops) if (t) lists.push(mapTracks(t.items));
  }
  const out = [];
  for (let i = 0; i < perArtist; i++) for (const l of lists) if (l[i]) out.push(l[i]);
  return out;
}

async function trackMix(q, req, res) {
  const id = numericId(q.id);
  if (isBlockedId('track', id)) throw httpError(451, 'blocked');
  const mix = await v1OrNull(`/tracks/${id}/mix`, { deviceType: 'BROWSER' });
  if (q.mixOnly === '1') {
    // Just the mix id (the home page links a mix without needing its songs).
    res.setHeader('Cache-Control', mix && mix.id ? CATALOG : NO_STORE);
    return res.json({ mixId: (mix && mix.id) || '', tracks: [] });
  }
  let tracks = mix && mix.id ? await mixTracks(mix.id) : [];
  tracks = dedupe(tracks, [Number(id)]);
  if (tracks.length < 10) {
    // Fallback: similar artists' top tracks.
    const seed = await v1OrNull(`/tracks/${id}`, {});
    const artistIds = seed ? (seed.artists || []).map((a) => a.id).concat(seed.artist ? [seed.artist.id] : []) : [];
    const more = await similarArtistTracks(artistIds.slice(0, 2), 5, false);
    tracks = dedupe(tracks.concat(more), [Number(id)]);
  }
  tracks = tracks.slice(0, MAX_RADIO);
  res.setHeader('Cache-Control', tracks.length ? CATALOG : NO_STORE);
  return res.json({ mixId: (mix && mix.id) || '', tracks });
}

async function artistMix(q, req, res) {
  const id = numericId(q.id);
  if (isBlockedId('artist', id)) throw httpError(451, 'blocked');
  const mix = await v1OrNull(`/artists/${id}/mix`, { deviceType: 'BROWSER' });
  let tracks = mix && mix.id ? await mixTracks(mix.id) : [];
  tracks = dedupe(tracks, []);
  if (tracks.length < 10) {
    const more = await similarArtistTracks([id], 5, true);
    tracks = dedupe(tracks.concat(more), []);
  }
  tracks = tracks.slice(0, MAX_RADIO);
  res.setHeader('Cache-Control', tracks.length ? CATALOG : NO_STORE);
  return res.json({ mixId: (mix && mix.id) || '', tracks });
}

async function mix(q, req, res) {
  const id = mixId(q.id);
  let j;
  try {
    j = await v1('/pages/mix', { mixId: id, deviceType: 'BROWSER' });
  } catch (e) {
    if (!e.denied) throw e;
    res.setHeader('Cache-Control', NO_STORE);
    return res.json({ mix: { id, title: '', subTitle: '', cover: '', type: '' }, tracks: [] });
  }
  let header = null;
  let items = [];
  for (const row of j.rows || []) {
    for (const m of row.modules || []) {
      if (m.type === 'MIX_HEADER' && m.mix) header = m.mix;
      if (m.type === 'TRACK_LIST') items = (m.pagedList && m.pagedList.items) || [];
    }
  }
  const mapped = header ? mapMix(header) : { id, title: j.title || '', subTitle: '', cover: '', type: '' };
  mapped.id = id;
  if (!mapped.title) mapped.title = j.title || '';
  res.setHeader('Cache-Control', CATALOG);
  return res.json({ mix: mapped, tracks: mapTracks(items) });
}

async function playlist(q, req, res) {
  const id = uuid(q.id);
  if (isBlockedId('playlist', id)) throw httpError(451, 'blocked');
  const offset = clampInt(q.offset, 0, 100000, 0);
  let meta;
  let items;
  try {
    [meta, items] = await Promise.all([
      v1(`/playlists/${id}`, {}),
      v1(`/playlists/${id}/items`, { limit: PLAYLIST_PAGE, offset }),
    ]);
  } catch (e) {
    if (!e.denied) throw e;
    res.setHeader('Cache-Control', NO_STORE);
    return res.json({ playlist: mapPlaylist({ uuid: id }), tracks: [], total: 0 });
  }
  const total = typeof items.totalNumberOfItems === 'number' ? items.totalNumberOfItems : meta.numberOfTracks || 0;
  res.setHeader('Cache-Control', CATALOG);
  return res.json({ playlist: mapPlaylist(meta), tracks: mapTracks(items.items), total });
}

// ---- explore / pages ------------------------------------------------------------------

function pathFrom(link) {
  const p = String((link && (link.apiPath || link.path)) || '');
  return rePage.test(p) ? p : '';
}

function mapModule(m) {
  const title = m.title || '';
  const list = (m.pagedList && m.pagedList.items) || [];
  switch (m.type) {
    case 'PAGE_LINKS':
    case 'PAGE_LINKS_CLOUD': {
      const items = list.map((l) => ({ title: l.title || '', path: pathFrom(l) })).filter((l) => l.title && l.path);
      return items.length ? { title, kind: 'links', items } : null;
    }
    case 'PLAYLIST_LIST': {
      const items = list.filter((p) => p && p.uuid && !isBlockedId('playlist', p.uuid)).map(mapPlaylist);
      return items.length ? { title, kind: 'playlists', items } : null;
    }
    case 'ALBUM_LIST': {
      const items = list.filter((a) => a && a.id).map(mapAlbum).filter((a) => !isBlockedAlbum(a));
      return items.length ? { title, kind: 'albums', items } : null;
    }
    case 'ARTIST_LIST': {
      const items = list.filter((a) => a && a.id && !isBlockedId('artist', a.id)).map(mapArtist);
      return items.length ? { title, kind: 'artists', items } : null;
    }
    case 'TRACK_LIST': {
      const items = mapTracks(list);
      return items.length ? { title, kind: 'tracks', items } : null;
    }
    case 'MIX_LIST': {
      const items = list.filter((x) => x && x.id).map(mapMix);
      return items.length ? { title, kind: 'mixes', items } : null;
    }
    default:
      return null; // videos, promotions, text blocks: not music
  }
}

function sectionsFrom(j) {
  const sections = [];
  for (const row of j.rows || []) {
    for (const m of row.modules || []) {
      const s = mapModule(m);
      if (s) sections.push(s);
    }
  }
  return sections;
}

async function explore(q, req, res) {
  let j;
  try {
    j = await v1('/pages/explore', { deviceType: 'BROWSER' });
  } catch (e) {
    if (!e.denied && e.status !== 404) throw e;
    res.setHeader('Cache-Control', NO_STORE);
    return res.json({ title: 'Explore', sections: [] });
  }
  const sections = sectionsFrom(j);
  res.setHeader('Cache-Control', sections.length ? SHELVES : NO_STORE);
  return res.json({ title: j.title || 'Explore', sections });
}

async function page(q, req, res) {
  let p = String(q.path || '').trim();
  if (p && !p.startsWith('pages/')) p = 'pages/' + p;
  if (!rePage.test(p)) throw httpError(400, 'bad_path');
  let j;
  try {
    j = await v1('/' + p, { deviceType: 'BROWSER' });
  } catch (e) {
    if (!e.denied && e.status !== 404) throw e;
    res.setHeader('Cache-Control', NO_STORE);
    return res.json({ title: '', sections: [] });
  }
  const sections = sectionsFrom(j);
  res.setHeader('Cache-Control', sections.length ? SHELVES : NO_STORE);
  return res.json({ title: j.title || '', sections });
}

module.exports = { mix, trackMix, artistMix, playlist, explore, page };
