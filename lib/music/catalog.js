// Catalog extras (track page, album/artist extras, bios, links, AOTY).
// Owned by package P8. api/music.js dispatches here.

const {
  appToken, tidalGet, countryFor, mapTrack, mapAlbum, mapArtist,
  isBlockedId, isBlockedTrack, isBlockedAlbum, httpError,
} = require('../tidal');

const CACHE_CATALOG = 's-maxage=86400, stale-while-revalidate=3600';
const CACHE_LINKS = 's-maxage=604800, stale-while-revalidate=86400';
const OPENAPI = 'https://openapi.tidal.com/v2';
const AOTY_BASE = 'https://aoty.edideaur.works';
const MB_BASE = 'https://musicbrainz.org/ws/2';
const MB_UA = 'StreamFiesta/1.0 (+https://streamfiesta.vercel.app)';

function numericId(v) {
  if (!/^\d{1,12}$/.test(String(v || ''))) throw httpError(400, 'bad_id');
  return String(v);
}

function clampInt(v, min, max, dflt) {
  const n = Number.parseInt(String(v), 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

// TIDAL denials / 5xx / missing things degrade to an empty answer.
function isUpstreamDenial(e) {
  return !!e && (e.code === 'not_found' || /^tidal_error_/.test(e.code || ''));
}

async function soft(promise, fallback) {
  try {
    return await promise;
  } catch (e) {
    if (isUpstreamDenial(e)) return fallback;
    throw e;
  }
}

// Run fn over items with at most `n` in flight; keeps order, failures become null.
async function mapLimit(items, n, fn) {
  const out = new Array(items.length).fill(null);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      try {
        out[i] = await fn(items[i], i);
      } catch (e) {
        if (!isUpstreamDenial(e)) throw e;
        out[i] = null;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

// openapi.tidal.com v2 (JSON:API) relationship ids. [] when TIDAL denies it.
async function v2RelationshipIds(path, token, limit) {
  try {
    const url = new URL(OPENAPI + path);
    url.searchParams.set('countryCode', countryFor(''));
    const r = await fetch(url, {
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.api+json' },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return [];
    const j = await r.json();
    return (Array.isArray(j.data) ? j.data : []).map((d) => String(d.id)).filter((id) => /^\d{1,12}$/.test(id)).slice(0, limit);
  } catch {
    return [];
  }
}

async function hydrateAlbums(ids, token) {
  const cc = countryFor('');
  const list = await mapLimit(ids, 8, (id) => tidalGet(`/albums/${id}`, { countryCode: cc }, token));
  return list.filter(Boolean).map(mapAlbum).filter((a) => !isBlockedAlbum(a));
}

async function hydrateArtists(ids, token) {
  const cc = countryFor('');
  const list = await mapLimit(ids, 8, (id) => tidalGet(`/artists/${id}`, { countryCode: cc }, token));
  return list.filter(Boolean).map(mapArtist).filter((a) => !isBlockedId('artist', a.id));
}

async function similarAlbumList(id, token, limit = 12) {
  const ids = await v2RelationshipIds(`/albums/${id}/relationships/similarAlbums`, token, limit + 1);
  return hydrateAlbums(ids.filter((x) => x !== id).slice(0, limit), token);
}

async function similarArtistList(id, token, limit = 12) {
  const ids = await v2RelationshipIds(`/artists/${id}/relationships/similarArtists`, token, limit + 1);
  return hydrateArtists(ids.filter((x) => x !== id).slice(0, limit), token);
}

async function track(q, req, res) {
  const id = numericId(q.id);
  if (isBlockedId('track', id)) throw httpError(451, 'blocked');
  const token = await appToken();
  const cc = countryFor('');
  const t = await tidalGet(`/tracks/${id}`, { countryCode: cc }, token);
  const mapped = mapTrack(t);
  if (isBlockedTrack(mapped)) throw httpError(451, 'blocked');
  let albumTracks = [];
  let album = null;
  if (mapped.albumId) {
    const [a, items] = await Promise.all([
      soft(tidalGet(`/albums/${mapped.albumId}`, { countryCode: cc }, token), null),
      soft(tidalGet(`/albums/${mapped.albumId}/items`, { countryCode: cc, limit: 100 }, token), { items: [] }),
    ]);
    if (a) album = mapAlbum(a);
    albumTracks = (items.items || []).filter((i) => i.type === 'track').map((i) => mapTrack(i.item)).filter((x) => !isBlockedTrack(x));
  }
  res.setHeader('Cache-Control', CACHE_CATALOG);
  return res.json({ track: mapped, albumTracks, album });
}

async function tracks(q, req, res) {
  const ids = String(q.ids || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!ids.length || ids.length > 100) throw httpError(400, 'bad_ids');
  ids.forEach(numericId);
  const unique = [...new Set(ids)];
  const token = await appToken();
  const cc = countryFor('');
  const list = await mapLimit(unique, 8, (id) => tidalGet(`/tracks/${id}`, { countryCode: cc }, token));
  const byId = new Map();
  list.filter(Boolean).map(mapTrack).filter((t) => !isBlockedTrack(t)).forEach((t) => byId.set(String(t.id), t));
  res.setHeader('Cache-Control', CACHE_CATALOG);
  return res.json(ids.map((id) => byId.get(id)).filter(Boolean));
}

async function albumExtras(q, req, res) {
  const id = numericId(q.id);
  if (isBlockedId('album', id)) throw httpError(451, 'blocked');
  const token = await appToken();
  const cc = countryFor('');
  const a = await tidalGet(`/albums/${id}`, { countryCode: cc }, token);
  const album = mapAlbum(a);
  if (isBlockedAlbum(album)) throw httpError(451, 'blocked');
  const artistId = album.artistId ? String(album.artistId) : '';
  const empty = { items: [] };
  const [more, eps, similar, similarArtists] = await Promise.all([
    artistId ? soft(tidalGet(`/artists/${artistId}/albums`, { countryCode: cc, limit: 20 }, token), empty) : empty,
    artistId ? soft(tidalGet(`/artists/${artistId}/albums`, { countryCode: cc, limit: 20, filter: 'EPSANDSINGLES' }, token), empty) : empty,
    similarAlbumList(id, token),
    artistId ? similarArtistList(artistId, token) : [],
  ]);
  const clean = (r) => (r.items || []).map(mapAlbum).filter((x) => String(x.id) !== id && !isBlockedAlbum(x));
  res.setHeader('Cache-Control', CACHE_CATALOG);
  return res.json({
    moreByArtist: clean(more),
    epsSingles: clean(eps),
    similarAlbums: similar,
    similarArtists,
    copyright: album.copyright || '',
    releaseDate: album.releaseDate || '',
  });
}

// TIDAL bios carry [wimpLink artistId="1"]Name[/wimpLink] markup and <br/> tags.
function parseBio(raw) {
  const links = [];
  let text = String(raw || '').replace(/\[wimpLink\s+(artistId|albumId)="(\d{1,12})"\]([\s\S]*?)\[\/wimpLink\]/g, (m, kind, id, label) => {
    const route = (kind === 'artistId' ? '/music/artist/' : '/music/album/') + id;
    if (!links.some((l) => l.route === route)) links.push({ label, route });
    return label;
  });
  text = text.replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n\n').replace(/<[^>]+>/g, '');
  text = text.replace(/\[\/?[a-zA-Z]+[^\]]*\]/g, '');
  text = text.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  text = text.replace(/\n{3,}/g, '\n\n').trim();
  return { text, links };
}

async function artistBio(q, req, res) {
  const id = numericId(q.id);
  if (isBlockedId('artist', id)) throw httpError(451, 'blocked');
  const token = await appToken();
  const j = await soft(tidalGet(`/artists/${id}/bio`, { countryCode: countryFor('') }, token), null);
  res.setHeader('Cache-Control', CACHE_CATALOG);
  if (!j || !j.text) return res.json({ text: '', source: '', links: [] });
  const { text, links } = parseBio(j.text);
  return res.json({ text, source: j.source || 'TIDAL', links });
}

async function similarArtists(q, req, res) {
  const id = numericId(q.id);
  const token = await appToken();
  const list = await similarArtistList(id, token, 20);
  res.setHeader('Cache-Control', CACHE_CATALOG);
  return res.json(list);
}

async function similarAlbums(q, req, res) {
  const id = numericId(q.id);
  const token = await appToken();
  const list = await similarAlbumList(id, token, 20);
  res.setHeader('Cache-Control', CACHE_CATALOG);
  return res.json(list);
}

const ARTIST_FILTERS = { ALBUMS: '', EPSANDSINGLES: 'EPSANDSINGLES', COMPILATIONS: 'COMPILATIONS', APPEARS_ON: 'APPEARS_ON' };

async function artistAlbums(q, req, res) {
  const id = numericId(q.id);
  if (isBlockedId('artist', id)) throw httpError(451, 'blocked');
  const filter = String(q.filter || 'ALBUMS').toUpperCase();
  if (!Object.prototype.hasOwnProperty.call(ARTIST_FILTERS, filter)) throw httpError(400, 'bad_filter');
  const limit = clampInt(q.limit, 1, 100, 50);
  const offset = clampInt(q.offset, 0, 2000, 0);
  const token = await appToken();
  const query = { countryCode: countryFor(''), limit, offset };
  if (ARTIST_FILTERS[filter]) query.filter = ARTIST_FILTERS[filter];
  // APPEARS_ON is not offered to every app token; TIDAL's refusal reads as "none".
  const j = await soft(tidalGet(`/artists/${id}/albums`, query, token), { items: [] });
  const items = (j.items || []).map(mapAlbum).filter((a) => !isBlockedAlbum(a));
  res.setHeader('Cache-Control', CACHE_CATALOG);
  return res.json({ items, total: Number.isFinite(j.totalNumberOfItems) ? j.totalNumberOfItems : items.length });
}

async function artistTopTracks(q, req, res) {
  const id = numericId(q.id);
  if (isBlockedId('artist', id)) throw httpError(451, 'blocked');
  const limit = clampInt(q.limit, 1, 50, 20);
  const offset = clampInt(q.offset, 0, 500, 0);
  const token = await appToken();
  const j = await soft(tidalGet(`/artists/${id}/toptracks`, { countryCode: countryFor(''), limit, offset }, token), { items: [] });
  const items = (j.items || []).map(mapTrack).filter((t) => !isBlockedTrack(t));
  res.setHeader('Cache-Control', CACHE_CATALOG);
  return res.json({ items, total: Number.isFinite(j.totalNumberOfItems) ? j.totalNumberOfItems : items.length });
}

// ---- MusicBrainz (<= 1 request/second, 7 day cache) ---------------------------------

let mbChain = Promise.resolve();
let mbLast = 0;
function mbFetch(path) {
  const run = async () => {
    const wait = mbLast + 1100 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    mbLast = Date.now();
    const r = await fetch(MB_BASE + path, { headers: { 'User-Agent': MB_UA, Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error('mb_' + r.status);
    return r.json();
  };
  const p = mbChain.then(run, run);
  mbChain = p.catch(() => {});
  return p;
}

const LINK_TYPES = new Set(['official homepage', 'social network', 'streaming', 'youtube', 'soundcloud', 'bandcamp', 'free streaming', 'streaming music', 'wikipedia', 'wikidata', 'discogs', 'allmusic', 'last.fm', 'lyrics', 'bandsintown', 'songkick', 'patronage']);
const mbCache = new Map();

async function musicBrainzLinks(tidalId, name) {
  const hit = mbCache.get(tidalId);
  if (hit && Date.now() - hit.at < 7 * 864e5) return hit.links;
  let links = [];
  try {
    let mbid = '';
    const byUrl = await mbFetch(`/url?resource=${encodeURIComponent('https://tidal.com/artist/' + tidalId)}&inc=artist-rels&fmt=json`).catch(() => null);
    const rel = byUrl && Array.isArray(byUrl.relations) ? byUrl.relations.find((r) => r.artist && r.artist.id) : null;
    if (rel) mbid = rel.artist.id;
    if (!mbid && name) {
      const s = await mbFetch(`/artist/?query=${encodeURIComponent('artist:"' + name.replace(/["\\]/g, '') + '"')}&limit=3&fmt=json`);
      const best = (s.artists || []).find((a) => (a.score || 0) >= 95 && String(a.name).toLowerCase() === name.toLowerCase());
      if (best) mbid = best.id;
    }
    if (mbid && /^[0-9a-f-]{36}$/.test(mbid)) {
      const d = await mbFetch(`/artist/${mbid}?inc=url-rels&fmt=json`);
      links.push({ type: 'musicbrainz', url: 'https://musicbrainz.org/artist/' + mbid });
      for (const r of d.relations || []) {
        const url = r.url && r.url.resource;
        if (url && /^https?:\/\//i.test(url) && LINK_TYPES.has(r.type) && !links.some((l) => l.url === url)) links.push({ type: r.type, url });
      }
    }
  } catch {
    links = [];
  }
  mbCache.set(tidalId, { at: Date.now(), links });
  return links;
}

async function artistLinks(q, req, res) {
  const id = numericId(q.id);
  if (isBlockedId('artist', id)) throw httpError(451, 'blocked');
  const token = await appToken();
  const a = await soft(tidalGet(`/artists/${id}`, { countryCode: countryFor('') }, token), null);
  const links = await musicBrainzLinks(id, a ? String(a.name || '') : '');
  res.setHeader('Cache-Control', links.length ? CACHE_LINKS : 's-maxage=3600');
  return res.json(links);
}

// ---- Album of the Year scores (aoty.edideaur.works, public) -------------------------

function aotyNumber(v) {
  if (v === null || v === undefined) return undefined;
  const s = String(v).trim();
  if (!s || s.toUpperCase() === 'NR') return undefined;
  const n = Number(s.replace(/,/g, ''));
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
}

function cleanTitle(t) {
  return String(t).replace(/\s*[([][^)\]]*(remaster|deluxe|edition|version|expanded|anniversary)[^)\]]*[)\]]/gi, '').replace(/\s+-\s+.*(remaster|deluxe|edition|version).*$/i, '').trim();
}

async function aotyLookup(artist, name) {
  const url = `${AOTY_BASE}/album?artist=${encodeURIComponent(artist)}&name=${encodeURIComponent(name)}`;
  const r = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
  if (!r.ok) return null;
  const j = await r.json();
  const critic = aotyNumber(j.criticScore);
  const user = aotyNumber(j.userScore);
  if (critic === undefined && user === undefined) return null;
  const out = { critic, user, criticCount: aotyNumber(j.criticCount), userCount: aotyNumber(j.userCount) };
  if (j.mustHear === true) out.mustHear = true;
  if (typeof j.url === 'string' && /^https:\/\/www\.albumoftheyear\.org\//.test(j.url)) out.url = j.url;
  return out;
}

async function aoty(q, req, res) {
  const title = String(q.title || '').trim().slice(0, 150);
  const artist = String(q.artist || '').split(',')[0].trim().slice(0, 150);
  if (!title || !artist) throw httpError(400, 'missing_params');
  let out = null;
  try {
    out = await aotyLookup(artist, title);
    const alt = cleanTitle(title);
    if (!out && alt && alt !== title) out = await aotyLookup(artist, alt);
  } catch {
    out = null;
  }
  res.setHeader('Cache-Control', out ? CACHE_CATALOG : 's-maxage=3600');
  return res.json(out);
}

module.exports = { track, tracks, albumExtras, artistBio, similarArtists, similarAlbums, artistAlbums, artistTopTracks, artistLinks, aoty, parseBio };
