// Torrent box front door for the site. No keys of its own for now: it is open on previews and local
// dev and answers 404 on production (DEPLOY_ENV=production) until real access rules exist. The relay
// on the Mac mini does the work (tools/torrent-box) and hands back signed stream URLs.
//   POST /api/torrent            {"magnet": "magnet:?..."} or {"torrent": "<base64 .torrent>"}   -> {id}
//   GET  /api/torrent?id=<hash>  progress, the movie file and, once it exists, `stream` (direct file) or `hls` (remuxed), `play` says which
//   DELETE /api/torrent?id=<hash>
const RELAY_URL = (process.env.STREAM_RELAY_URL || '').replace(/\/$/, '');
const RELAY_SECRET = process.env.STREAM_RELAY_SECRET || '';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if ((process.env.DEPLOY_ENV || process.env.VERCEL_ENV) === 'production') return res.status(404).json({ error: 'not_found' });
  if (!RELAY_URL || !RELAY_SECRET) return res.status(503).json({ error: 'torrents not configured' });

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
