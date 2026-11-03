// /torrent/* - the public door of the torrent box (tools/torrent-box, 127.0.0.1:8790 on this machine).
// Lives in its own module so it can be dropped next to the production relay.mjs (see
// install-torrent.sh), which only needs one import and one route line.
import { timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';

// Read per request: relay.mjs loads .env.local AFTER its imports have run.
const torrentUrl = () => (process.env.TORRENT_URL || 'http://127.0.0.1:8790').replace(/\/$/, '');
const torrentToken = () => process.env.TORRENT_TOKEN || '';

// --- torrents: the site adds/queries with the bearer secret, viewers stream with a signed URL ---
const isOwner = (req, SECRET) => {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) return false;
  const got = Buffer.from(auth.slice(7));
  const want = Buffer.from(SECRET);
  return got.length === want.length && timingSafeEqual(got, want);
};
const sendJson = (res, status, obj) => {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(obj));
};
const readBody = async (req, limit = 8 * 1024 * 1024) => {
  const chunks = [];
  let n = 0;
  for await (const c of req) {
    n += c.length;
    if (n > limit) throw Object.assign(new Error('body too large'), { status: 413 });
    chunks.push(c);
  }
  return Buffer.concat(chunks);
};
const boxFetch = (p, init = {}) =>
  fetch(torrentUrl() + p, { ...init, headers: { ...(init.headers || {}), Authorization: 'Bearer ' + torrentToken() } });

// POST /torrent/add            body: raw .torrent or {"magnet": "..."}     -> {id}
// GET  /torrent/:id            progress + `stream` (signed URL) once a video file is known
// DELETE /torrent/:id
async function handleTorrentApi(req, res, url, { SECRET, PUBLIC_URL, mintToken }) {
  if (!isOwner(req, SECRET)) return sendJson(res, 401, { error: 'unauthorized' });
  if (!torrentToken()) return sendJson(res, 503, { error: 'TORRENT_TOKEN not set on the relay' });
  if (req.method === 'POST' && url.pathname === '/torrent/add') {
    const body = await readBody(req);
    const r = await boxFetch('/api/add', { method: 'POST', body, headers: { 'Content-Type': req.headers['content-type'] || 'application/octet-stream' } });
    res.statusCode = r.status;
    res.setHeader('Content-Type', 'application/json');
    return res.end(await r.text());
  }
  if (req.method === 'GET' && url.pathname === '/torrent/list') {
    const r = await boxFetch('/api/torrents');
    const all = await r.json().catch(() => []);
    if (!r.ok) return sendJson(res, r.status, all);
    return sendJson(res, 200, all.map((d) => {
      const main = d.main != null ? d.files[d.main] : null;
      return {
        id: d.id, name: d.name, progress: d.progress, downloadSpeed: d.downloadSpeed, numPeers: d.numPeers, done: d.done,
        encode: d.encode, encodeInfo: d.encodeInfo, play: !main ? null : main.playableInBrowser ? 'direct' : 'hls',
        file: main && { name: main.name, path: main.path, length: main.length },
      };
    }));
  }
  const m = /^\/torrent\/([0-9a-f]{40})$/.exec(url.pathname);
  if (!m) return sendJson(res, 404, { error: 'not found' });
  if (req.method === 'DELETE') {
    const r = await boxFetch('/api/torrents/' + m[1], { method: 'DELETE' });
    res.statusCode = r.status;
    return res.end(await r.text());
  }
  if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
  const r = await boxFetch('/api/torrents/' + m[1]);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) return sendJson(res, r.status, data);
  const main = data.main != null ? data.files[data.main] : null;
  return sendJson(res, 200, {
    id: data.id,
    name: data.name,
    progress: data.progress,
    downloadSpeed: data.downloadSpeed,
    numPeers: data.numPeers,
    done: data.done,
    encode: data.encode,
    encodeInfo: data.encodeInfo,
    file: main && { name: main.name, path: main.path, length: main.length, progress: main.progress, playableInBrowser: main.playableInBrowser },
    stream: main && PUBLIC_URL ? `${PUBLIC_URL}/torrent/stream/${data.id}?t=${mintToken()}` : null,
    // The token sits in the PATH so the playlist's relative segment URLs inherit it.
    hls: main && PUBLIC_URL ? `${PUBLIC_URL}/torrent/hls/${mintToken()}/${data.id}/master.m3u8` : null,
    play: !main ? null : main.playableInBrowser ? 'direct' : 'hls',
  });
}

// GET /torrent/stream/:id?t=<token>  Range-capable bytes of the movie file, straight off the box.
async function handleTorrentStream(req, res, url, { setCors, verifyToken }) {
  setCors(req, res);
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }
  const m = /^\/torrent\/stream\/([0-9a-f]{40})$/.exec(url.pathname);
  if (!m || !verifyToken(url.searchParams.get('t'))) {
    res.statusCode = 403;
    return res.end('forbidden');
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.statusCode = 405;
    return res.end();
  }
  const abort = new AbortController();
  res.on('close', () => abort.abort());
  const up = await boxFetch('/stream/' + m[1], { method: req.method, headers: req.headers.range ? { Range: req.headers.range } : {}, signal: abort.signal });
  res.statusCode = up.status;
  for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
    const v = up.headers.get(h);
    if (v) res.setHeader(h, v);
  }
  res.setHeader('Cache-Control', 'no-store');
  if (!up.body || req.method === 'HEAD') return res.end();
  Readable.fromWeb(up.body).on('error', () => res.destroy()).pipe(res);
}

// GET /torrent/hls/<token>/<id>/<file>  the HLS fMP4 remux (master.m3u8, vN/index.m3u8, vN/init.mp4, vN/seg_NNNNN.m4s).
async function handleTorrentHls(req, res, url, { setCors, verifyToken }) {
  setCors(req, res);
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }
  const m = /^\/torrent\/hls\/([^/]+)\/([0-9a-f]{40})\/(master\.m3u8|v\d\/(?:index\.m3u8|init(?:_\d)?\.mp4|seg_\d{5}\.m4s))$/.exec(url.pathname);
  if (!m || !verifyToken(m[1])) {
    res.statusCode = 403;
    return res.end('forbidden');
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.statusCode = 405;
    return res.end();
  }
  const abort = new AbortController();
  res.on('close', () => abort.abort());
  const up = await boxFetch(`/hls/${m[2]}/${m[3]}`, { signal: abort.signal });
  res.statusCode = up.status;
  for (const h of ['content-type', 'content-length', 'cache-control']) {
    const v = up.headers.get(h);
    if (v) res.setHeader(h, v);
  }
  if (!up.body || req.method === 'HEAD') return res.end();
  Readable.fromWeb(up.body).on('error', () => res.destroy()).pipe(res);
}

/** ctx: { SECRET, PUBLIC_URL, setCors, mintToken, verifyToken } from relay.mjs */
export function handleTorrent(req, res, url, ctx) {
  if (url.pathname.startsWith('/torrent/stream/')) return handleTorrentStream(req, res, url, ctx);
  if (url.pathname.startsWith('/torrent/hls/')) return handleTorrentHls(req, res, url, ctx);
  return handleTorrentApi(req, res, url, ctx);
}
