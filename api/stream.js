// Resolves a vidsrc/cloudnestra embed to a clean, playable HLS master URL.
//
// Resolution must beat cloudnestra's per-IP Cloudflare Turnstile, which a single
// fixed IP can't do reliably and a bare server fetch can't solve at all. So the
// whole resolve is delegated to the residential relay (tools/fiesta-proxy/relay.mjs)
// running on a home machine behind a tunnel: it tries a plain fetch first and
// falls back to a headless browser that actually solves the challenge, then
// returns a master URL pointing at its own token-gated /hls. Playback bytes
// (playlists + segments) stream straight off that relay on unmetered home
// bandwidth — they never touch Vercel or any metered proxy.
//
// vidsrc.me and vsembed.ru are two front-ends onto the same cloudnestra backend;
// each hands out a different stream instance, so when one is dead the other may
// play. `srv` (1=vidsrc, 2=vsembed) forces a front; omit it to let the relay pick
// the first that resolves. The relay echoes back which front it used as `server`.
//
//   GET /api/stream?type=movie&id=tt123[&s=&e=][&srv=1|2]  ->  { master, upstream, server, env }

const RELAY_URL = (process.env.STREAM_RELAY_URL || '').replace(/\/$/, '');
const RELAY_SECRET = process.env.STREAM_RELAY_SECRET || '';

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Accept, Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const type = req.query.type === 'tv' ? 'tv' : 'movie';
  const id = req.query.id;
  const season = req.query.s || null;
  const episode = req.query.e || null;

  if (!id || !/^tt\d+$/.test(id)) {
    return res.status(400).json({ error: 'Invalid IMDB ID. Expected format: tt1234567' });
  }
  if (!RELAY_URL || !RELAY_SECRET) {
    return res.status(500).json({ error: 'stream relay not configured (STREAM_RELAY_URL / STREAM_RELAY_SECRET)' });
  }

  const params = new URLSearchParams({ type, id });
  if (type === 'tv' && season && episode) {
    params.set('s', season);
    params.set('e', episode);
  }
  if (req.query.srv === '1' || req.query.srv === '2') {
    params.set('srv', req.query.srv);
  }

  try {
    const r = await fetch(RELAY_URL + '/resolve?' + params.toString(), {
      headers: { Authorization: 'Bearer ' + RELAY_SECRET },
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.master) throw new Error(data.error || 'relay resolve failed (' + r.status + ')');
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');
    return res.status(200).json({
      master: data.master,
      upstream: data.upstream,
      server: data.server ?? null,
      env: process.env.VERCEL_ENV || 'development',
    });
  } catch (e) {
    console.error('stream resolve error:', e);
    return res.status(502).json({ error: String((e && e.message) || e) });
  }
};
