// Prototype torrent box for the Mac mini.
//
//   POST /api/add        {"magnet": "magnet:?xt=..."}  or a raw .torrent body (application/x-bittorrent)
//   GET  /api/torrents       state of every torrent (progress, speed, peers, files, `main` = the movie file)
//   GET  /api/torrents/:id   the same for one torrent
//   DELETE /api/torrents/:id remove it and delete its files
//   GET  /stream/:id         the movie (largest video file), Range-capable, playable WHILE it downloads
//   GET  /stream/:id/:fileIndex   any file of the torrent
//   GET  /subs/:id/:n.vtt    an embedded text subtitle track as WebVTT (once extracted)
//   GET  /hls/:id/master.m3u8 (+ vN/index.m3u8, vN/init.mp4, vN/seg_NNNNN.m4s)  the movie remuxed to HLS fMP4 for browsers (MKV, AC-3, ...), started on first request
//
// API only, no UI: the Fiesta Show site drives it.
//
// Downloads are sequential (first piece first) and go ONLY to an external HDD (see disk-guard.mjs).
// Everything needs the token. Bound to 127.0.0.1: reach it through an
// SSH tunnel for now; exposing it publicly is a later step.
import http from 'node:http';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import WebTorrent from 'webtorrent';
import parseTorrent from 'parse-torrent';
import { createHls, HLS_FILE, HLS_MIME } from './hls.mjs';
import { assertExternalHdd } from './disk-guard.mjs';

const PORT = +(process.env.PORT || 8790);
const HOST = process.env.HOST || '127.0.0.1';
const TOKEN = process.env.TORRENT_TOKEN || '';
const DIR = process.env.TORRENT_DIR || '/Volumes/Monster/Torrents';
const ALLOW_ANY_DISK = process.env.ALLOW_ANY_DISK === '1'; // laptop testing only
/** Seeding shares the home uplink with the audio/video relay: keep it small. */
const UPLOAD_LIMIT = (+(process.env.UPLOAD_LIMIT_KBPS || 256)) * 1024;
const MAX_DOWNLOADS = +process.env.MAX_DOWNLOADS || 4; // simultaneous unfinished downloads the disk is asked to take
const MIN_FREE_BYTES = (+(process.env.MIN_FREE_GB || 50)) * 1e9;
const MAX_TORRENT_FILE = 5 * 1024 * 1024;

if (!TOKEN || TOKEN.length < 16) {
  console.error('TORRENT_TOKEN (>= 16 chars) is required');
  process.exit(1);
}

const root = await assertExternalHdd(DIR, { allowAnyDisk: ALLOW_ANY_DISK });
const stateDir = path.join(root, '.fiesta');
await fs.mkdir(path.join(stateDir, 'torrents'), { recursive: true });
const registryFile = path.join(stateDir, 'registry.json');
console.log(`[torrent] downloading to ${root}${ALLOW_ANY_DISK ? ' (ANY-DISK MODE, test only)' : ' (external HDD verified)'}`);

const hls = createHls({ root });
const client = new WebTorrent({ uploadLimit: UPLOAD_LIMIT });
client.on('error', (e) => console.error('[torrent] client error', e.message));

// ── registry: what to re-add after a restart ────────────────────────────────
/** infoHash -> {magnet} | {file: "<infoHash>.torrent"} */
let registry = {};
try { registry = JSON.parse(await fs.readFile(registryFile, 'utf8')); } catch { /* first run */ }
const saveRegistry = () => fs.writeFile(registryFile, JSON.stringify(registry, null, 1));

// Finished downloads are encoded for streaming in the background, one at a time (the M4 has a single
// encoder engine). AUTO_ENCODE=0 turns it off. Nothing is deleted: the original file stays.
const AUTO_ENCODE = process.env.AUTO_ENCODE !== '0';
function encodeWhenDone(t) {
  if (!AUTO_ENCODE) return;
  t.once('done', () => {
    const input = `http://127.0.0.1:${PORT}/stream/${t.infoHash}?t=${encodeURIComponent(TOKEN)}`;
    hls.enqueue(t.infoHash, input).catch((e) => console.error('[hls] enqueue failed', t.infoHash, String(e.message).slice(0, 200)));
  });
}

function startTorrent(source) {
  // sequential = pieces in order, so the start of the file is what arrives first
  const t = client.add(source, { path: root, strategy: 'sequential' });
  encodeWhenDone(t);
  return t;
}

for (const [id, entry] of Object.entries(registry)) {
  try {
    const src = entry.magnet ?? (await fs.readFile(path.join(stateDir, 'torrents', entry.file)));
    startTorrent(src);
  } catch (e) {
    console.error('[torrent] could not restore', id, e.message);
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────
const MIME = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska', '.m2ts': 'video/mp2t', '.ts': 'video/mp2t', '.avi': 'video/x-msvideo', '.mp3': 'audio/mpeg', '.flac': 'audio/flac',
  '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.srt': 'text/plain; charset=utf-8', '.vtt': 'text/vtt; charset=utf-8',
};
const BROWSER_PLAYABLE = new Set(['.mp4', '.m4v', '.webm', '.mov', '.mp3', '.m4a', '.ogg', '.flac']);
const ext = (name) => path.extname(name).toLowerCase();

function authorized(req, url) {
  const given = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || req.headers['x-token'] || url.searchParams.get('t') || '';
  const a = Buffer.from(String(given));
  const b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const send = (res, status, body, headers = {}) => {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  res.writeHead(status, { 'content-type': isJson ? 'application/json' : 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(isJson ? JSON.stringify(body) : body);
};

async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw Object.assign(new Error('body too large'), { status: 413 });
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

// .m2ts: a Blu-ray folder (BDMV/STREAM) - the largest stream is the feature film.
const describeFull = async (t) => {
  const e = await hls.status(t.infoHash);
  return { ...describe(t), encode: e.state, encodeInfo: e };
};
const VIDEO = new Set(['.mp4', '.m4v', '.webm', '.mov', '.mkv', '.avi', '.m2ts', '.ts']);
/** The movie inside a torrent: its largest video file. */
const mainIndex = (t) => {
  let best = -1;
  t.files.forEach((f, i) => { if (VIDEO.has(ext(f.name)) && (best < 0 || f.length > t.files[best].length)) best = i; });
  return best < 0 ? null : best;
};

function describe(t) {
  return {
    main: mainIndex(t),
    id: t.infoHash,
    name: t.name,
    ready: t.ready,
    length: t.length,
    downloaded: t.downloaded,
    progress: t.progress,
    downloadSpeed: t.downloadSpeed,
    uploadSpeed: t.uploadSpeed,
    numPeers: t.numPeers,
    done: t.done,
    files: t.files.map((f, index) => ({
      index, name: f.name, path: f.path, length: f.length, downloaded: f.downloaded, progress: f.progress,
      playableInBrowser: BROWSER_PLAYABLE.has(ext(f.name)),
    })),
  };
}

async function freeBytes() {
  const s = await fs.statfs(root);
  return s.bavail * s.bsize;
}

// ── handlers ────────────────────────────────────────────────────────────────
async function add(req, res) {
  if ((await freeBytes()) < MIN_FREE_BYTES) return send(res, 507, { error: `less than ${MIN_FREE_BYTES / 1e9} GB free on the drive` });
  if (client.torrents.filter((t) => !t.done).length >= MAX_DOWNLOADS) return send(res, 429, { error: `already downloading ${MAX_DOWNLOADS} torrents; wait for one to finish` }, { 'retry-after': '60' });
  const body = await readBody(req, MAX_TORRENT_FILE);
  let source;
  let entry;
  if ((req.headers['content-type'] || '').includes('json')) {
    const { magnet } = JSON.parse(body.toString() || '{}');
    if (typeof magnet !== 'string' || !magnet.startsWith('magnet:?') || magnet.length > 4000) return send(res, 400, { error: 'send {"magnet":"magnet:?xt=urn:btih:..."}' });
    source = magnet;
    entry = { magnet };
  } else {
    if (!body.length) return send(res, 400, { error: 'empty body' });
    let parsed;
    try { parsed = await parseTorrent(body); } catch { return send(res, 400, { error: 'not a valid .torrent file' }); }
    source = body;
    entry = { file: `${parsed.infoHash}.torrent` };
    await fs.writeFile(path.join(stateDir, 'torrents', entry.file), body);
  }
  const parsed = await parseTorrent(source).catch(() => null);
  const id = parsed?.infoHash;
  if (!id) return send(res, 400, { error: 'could not read an info hash from that' });
  // webtorrent v2: get() is async
  if (!(await client.get(id))) startTorrent(source);
  registry[id] = entry;
  await saveRegistry();
  send(res, 202, { id });
}

async function remove(id, res) {
  const t = await client.get(id);
  if (!t) return send(res, 404, { error: 'unknown torrent' });
  await hls.stop(id);
  await new Promise((resolve) => t.destroy({ destroyStore: true }, resolve));
  const entry = registry[id];
  delete registry[id];
  await saveRegistry();
  if (entry?.file) await fs.rm(path.join(stateDir, 'torrents', entry.file), { force: true });
  send(res, 200, { removed: id });
}

async function stream(req, res, id, index) {
  const t = await client.get(id);
  const file = t?.files?.[index ?? mainIndex(t) ?? -1];
  if (!file) return send(res, 404, { error: 'no such file (yet: metadata may still be loading)' });
  const size = file.length;
  const type = MIME[ext(file.name)] || 'application/octet-stream';
  let start = 0;
  let end = size - 1;
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (range) {
    if (range[1] === '' && range[2] !== '') { start = Math.max(0, size - +range[2]); } // suffix range
    else { start = +range[1]; if (range[2] !== '') end = Math.min(size - 1, +range[2]); }
    if (!(start <= end) || start >= size) return send(res, 416, '', { 'content-range': `bytes */${size}` });
    res.writeHead(206, { 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': end - start + 1, 'content-type': type, 'accept-ranges': 'bytes', 'cache-control': 'no-store' });
  } else {
    res.writeHead(200, { 'content-length': size, 'content-type': type, 'accept-ranges': 'bytes', 'cache-control': 'no-store' });
  }
  if (req.method === 'HEAD') return res.end();
  // createReadStream asks the torrent for exactly these bytes first: the piece picker jumps there.
  const rs = file.createReadStream({ start, end });
  const stop = () => rs.destroy();
  res.on('close', stop);
  rs.on('error', () => res.destroy());
  rs.pipe(res);
}

async function serveHls(res, id, file) {
  const t = await client.get(id);
  if (!t) return send(res, 404, { error: 'unknown torrent' });
  let job;
  try {
    const input = `http://127.0.0.1:${PORT}/stream/${id}?t=${encodeURIComponent(TOKEN)}`;
    job = await hls.ensure(id, input);
  } catch (e) {
    if (e.code === 'busy') return send(res, 503, { error: 'busy', reason: e.message }, { 'retry-after': '15' });
    return send(res, 502, { error: 'remux failed: ' + String(e.message).slice(0, 300) });
  }
  const p = path.join(job.dir, file);
  let st;
  try { st = await fs.stat(p); } catch { return send(res, 404, { error: 'not ready' }); }
  const live = file.endsWith('.m3u8');
  res.writeHead(200, {
    'content-type': HLS_MIME[path.extname(file)],
    'content-length': st.size,
    'cache-control': live && !job.finished ? 'no-store' : 'public, max-age=31536000, immutable',
  });
  createReadStream(p).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (!authorized(req, url)) return send(res, 401, { error: 'token required' });
    if (req.method === 'POST' && url.pathname === '/api/add') return await add(req, res);
    if (req.method === 'GET' && url.pathname === '/api/torrents') return send(res, 200, await Promise.all(client.torrents.map(describeFull)));
    const one = /^\/api\/torrents\/([0-9a-f]{40})$/.exec(url.pathname);
    if (req.method === 'DELETE' && one) return await remove(one[1], res);
    if (req.method === 'GET' && one) {
      const t = await client.get(one[1]);
      return t ? send(res, 200, await describeFull(t)) : send(res, 404, { error: 'unknown torrent' });
    }
    const h = /^\/hls\/([0-9a-f]{40})\/(.+)$/.exec(url.pathname);
    if (req.method === 'GET' && h && HLS_FILE.test(h[2])) return await serveHls(res, h[1], h[2]);
    const sub = /^\/subs\/([0-9a-f]{40})\/(\d)\.vtt$/.exec(url.pathname);
    if (req.method === 'GET' && sub) {
      const f = await hls.subtitleFile(sub[1], +sub[2]);
      if (!f) return send(res, 404, { error: 'subtitles not ready' });
      const st = await fs.stat(f);
      res.writeHead(200, { 'content-type': 'text/vtt; charset=utf-8', 'content-length': st.size, 'cache-control': 'public, max-age=3600' });
      return createReadStream(f).pipe(res);
    }
    const s = /^\/stream\/([0-9a-f]{40})(?:\/(\d+))?$/.exec(url.pathname);
    if ((req.method === 'GET' || req.method === 'HEAD') && s) return await stream(req, res, s[1], s[2] === undefined ? undefined : +s[2]);
    send(res, 404, { error: 'not found' });
  } catch (e) {
    console.error('[torrent] request failed', e);
    if (!res.headersSent) send(res, e.status || 500, { error: e.message });
    else res.destroy();
  }
});
server.listen(PORT, HOST, () => console.log(`[torrent] http://${HOST}:${PORT}`));

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { hls.stopAll(); client.destroy(() => process.exit(0)); });
