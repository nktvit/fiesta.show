// Torrent box front door for the site. Owner-only for now (x-admin-key = TORRENT_ADMIN_KEY): the
// relay on the Mac mini does the work (tools/torrent-box) and hands back signed stream URLs.
//   POST /api/torrent            {"magnet": "magnet:?..."} or {"torrent": "<base64 .torrent>"}   -> {id}
//   GET  /api/torrent?id=<hash>  progress, the movie file and, once it exists, `stream`
//   DELETE /api/torrent?id=<hash>
import { timingSafeEqual } from 'node:crypto';

const RELAY_URL = (process.env.STREAM_RELAY_URL || '').replace(/\/$/, '');
const RELAY_SECRET = process.env.STREAM_RELAY_SECRET || '';
const ADMIN_KEY = process.env.TORRENT_ADMIN_KEY || '';

const sameSecret = (given, want) => {
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
};

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!ADMIN_KEY || !RELAY_URL || !RELAY_SECRET) return res.status(503).json({ error: 'torrents not configured' });
  if (!sameSecret(req.headers['x-admin-key'], ADMIN_KEY)) return res.status(401).json({ error: 'unauthorized' });

  const auth = { Authorization: 'Bearer ' + RELAY_SECRET };
  const id = String(req.query.id || '');
  try {
    let r;
    if (req.method === 'POST') {
      const b = req.body || {};
      if (typeof b.magnet === 'string' && b.magnet.startsWith('magnet:?')) {
        r = await fetch(RELAY_URL + '/torrent/add', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ magnet: b.magnet }) });
      } else if (typeof b.torrent === 'string' && b.torrent) {
        r = await fetch(RELAY_URL + '/torrent/add', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/x-bittorrent' }, body: Buffer.from(b.torrent, 'base64') });
      } else {
        return res.status(400).json({ error: 'send {magnet} or {torrent: base64}' });
      }
    } else if (req.method === 'GET' || req.method === 'DELETE') {
      if (!/^[0-9a-f]{40}$/.test(id)) return res.status(400).json({ error: 'bad id' });
      r = await fetch(RELAY_URL + '/torrent/' + id, { method: req.method, headers: auth });
    } else {
      return res.status(405).json({ error: 'method not allowed' });
    }
    const data = await r.json().catch(() => ({}));
    return res.status(r.status).json(data);
  } catch (e) {
    return res.status(502).json({ error: String((e && e.message) || e) });
  }
}
