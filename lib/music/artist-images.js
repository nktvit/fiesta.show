// Artist imagery from keyless sources, for the artist page's glass hero and gallery.
// Providers (each soft-fails to []): TIDAL (profile art, video stills, album covers),
// Deezer (exact-name artist picture), Wikimedia Commons (Wikidata P18 + the linked
// Commons category, with credit/licence). A FANART_TV_KEY provider slot exists but is
// only active when that env var is set (fanart.tv needs a key; none is configured).
// Used by lib/music/catalog.js (`artist-images`) and the `img` proxy allow-list.

const OPENAPI = 'https://openapi.tidal.com/v2';
const UA = 'StreamFiesta/1.0 (+https://streamfiesta.vercel.app)';
const MAX_IMAGES = 8;

// Hosts images may come from; the `img` proxy refuses everything else.
const IMAGE_HOSTS = new Set([
  'resources.tidal.com',
  'image.tidal.com',
  'cdn-images.dzcdn.net',
  'e-cdns-images.dzcdn.net',
  'upload.wikimedia.org',
  'assets.fanart.tv',
]);

function isArtistImageHost(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && IMAGE_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}

async function getJson(url, headers = {}, ms = 7000) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json', ...headers }, signal: AbortSignal.timeout(ms) });
  if (!r.ok) throw new Error('http_' + r.status);
  return r.json();
}

const stripTags = (s) => String(s || '').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();

const norm = (s) => String(s || '').normalize('NFKC').trim().toLowerCase();

// ---- TIDAL -------------------------------------------------------------------------

async function tidalImages(tidalId, token, albumCovers) {
  const out = [];
  const cc = 'US';
  try {
    const j = await getJson(`${OPENAPI}/artists/${tidalId}?countryCode=${cc}&include=profileArt`, {
      Authorization: 'Bearer ' + token, Accept: 'application/vnd.api+json',
    });
    for (const inc of j.included || []) {
      if (inc.type !== 'artworks') continue;
      const files = (inc.attributes && inc.attributes.files) || [];
      const best = files.slice().sort((a, b) => ((b.meta && b.meta.width) || 0) - ((a.meta && a.meta.width) || 0))[0];
      if (best && best.href) out.push({ url: best.href, w: best.meta.width, h: best.meta.height, source: 'tidal', kind: 'photo' });
    }
  } catch { /* denied or down */ }
  // Album covers of the artist (variety for the gallery; never used as the hero backdrop).
  for (const c of albumCovers.slice(0, 4)) out.push({ url: c, w: 640, h: 640, source: 'tidal', kind: 'cover' });
  return out;
}

// ---- Deezer ------------------------------------------------------------------------

async function deezerImages(name) {
  try {
    const j = await getJson(`https://api.deezer.com/search/artist?q=${encodeURIComponent(name)}&limit=10`);
    const exact = (j.data || []).filter((a) => norm(a.name) === norm(name) && a.picture_xl && !/\/artist\/\/|\/images\/artist\/[^/]*\/?$/.test(a.picture_xl));
    exact.sort((a, b) => (b.nb_fan || 0) - (a.nb_fan || 0));
    const a = exact[0];
    if (!a) return [];
    return [{ url: a.picture_xl, w: 1000, h: 1000, source: 'deezer', kind: 'photo' }];
  } catch {
    return [];
  }
}

// ---- Wikimedia Commons (via Wikidata) ----------------------------------------------

const COMMONS = 'https://commons.wikimedia.org/w/api.php';

function commonsImage(p) {
  const ii = p && p.imageinfo && p.imageinfo[0];
  if (!ii || !ii.thumburl || !/^image\/(jpeg|png|webp)$/.test(ii.mime || '')) return null;
  const meta = ii.extmetadata || {};
  const val = (k) => stripTags(meta[k] && meta[k].value);
  const lic = val('LicenseShortName');
  // Only freely reusable media (CC, public domain); anything else is skipped.
  if (!/^(cc[ -]|public domain|pd|cc0)/i.test(lic)) return null;
  const author = val('Artist');
  const w = ii.thumbwidth || ii.width;
  const h = ii.thumbheight || ii.height;
  const credit = [author ? 'Photo: ' + author.slice(0, 80) : 'Photo: Wikimedia Commons', lic].filter(Boolean).join(', ');
  return { url: ii.thumburl.split('?')[0], w, h, source: 'wikimedia', kind: 'photo', credit, page: ii.descriptionurl };
}

const COMMONS_PROPS = { prop: 'imageinfo', iiprop: 'url|size|mime|extmetadata', iiurlwidth: '1600', format: 'json', formatversion: '2' };

async function wikimediaImages(qid) {
  if (!/^Q\d{1,10}$/.test(qid || '')) return [];
  const out = [];
  try {
    const wd = await getJson(`https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${qid}&props=claims&format=json`);
    const claims = ((wd.entities || {})[qid] || {}).claims || {};
    const files = (claims.P18 || []).map((c) => c.mainsnak && c.mainsnak.datavalue && c.mainsnak.datavalue.value).filter((v) => typeof v === 'string').slice(0, 2);
    const cat = ((claims.P373 || [])[0] || {}).mainsnak;
    const category = cat && cat.datavalue && typeof cat.datavalue.value === 'string' ? cat.datavalue.value : '';
    if (files.length) {
      const q = new URLSearchParams({ action: 'query', titles: files.map((f) => 'File:' + f).join('|'), ...COMMONS_PROPS });
      const j = await getJson(`${COMMONS}?${q}`);
      for (const p of (j.query && j.query.pages) || []) { const im = commonsImage(p); if (im) out.push(im); }
    }
    if (category && out.length < 5) {
      const q = new URLSearchParams({ action: 'query', generator: 'categorymembers', gcmtitle: 'Category:' + category, gcmtype: 'file', gcmlimit: '12', ...COMMONS_PROPS });
      const j = await getJson(`${COMMONS}?${q}`);
      const extra = [];
      for (const p of (j.query && j.query.pages) || []) {
        const im = commonsImage(p);
        const ii = p.imageinfo && p.imageinfo[0];
        // Photos only: large enough, not tiny logos/scans, and not a duplicate of the P18 file.
        if (im && ii && ii.width >= 900 && ii.height >= 600 && !out.some((o) => o.url === im.url)) extra.push(im);
      }
      out.push(...extra.slice(0, 4));
    }
  } catch { /* soft */ }
  return out;
}

// ---- fanart.tv (key-gated, off unless FANART_TV_KEY is set) ---------------------------

async function fanartImages(mbid) {
  const key = process.env.FANART_TV_KEY;
  if (!key || !/^[0-9a-f-]{36}$/.test(mbid || '')) return [];
  try {
    const j = await getJson(`https://webservice.fanart.tv/v3/music/${mbid}?api_key=${encodeURIComponent(key)}`);
    const list = [...(j.artistbackground || []), ...(j.artistthumb || [])].slice(0, 4);
    return list.filter((x) => isArtistImageHost(x.url)).map((x) => ({ url: x.url.replace('http://', 'https://'), w: 1920, h: 1080, source: 'fanart', kind: 'photo' }));
  } catch {
    return [];
  }
}

// Order: freely licensed photos first (best for a backdrop), then press-style photos, then art.
function assemble(groups) {
  const flat = groups.flat();
  const seen = new Set();
  const uniq = [];
  for (const im of flat) {
    if (!im || !isArtistImageHost(im.url)) continue;
    const key = im.url.split('?')[0];
    if (seen.has(key)) continue;
    seen.add(key);
    uniq.push(im);
  }
  const rank = (im) => (im.kind === 'photo' ? 0 : 1);
  uniq.sort((a, b) => rank(a) - rank(b));
  return uniq.slice(0, MAX_IMAGES);
}

module.exports = { isArtistImageHost, tidalImages, deezerImages, wikimediaImages, fanartImages, assemble, MAX_IMAGES };
