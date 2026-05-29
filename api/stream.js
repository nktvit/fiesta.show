// Resolves a vidsrc/cloudnestra embed to a clean HLS master playlist, server-side.
//
// Walks the embed chain (all fetchable server-side with the right Referer):
//   1. vidsrc.me/embed/{type}/{imdb}[/{s}-{e}]  -> iframe //cloudnestra.com/rcp/{hash}
//   2. cloudnestra.com/rcp/{hash}   (Referer: vidsrc)  -> '/prorcp/{hash2}'
//   3. cloudnestra.com/prorcp/{hash2} (Referer: rcp)   -> Playerjs file: "<master.m3u8> or ..."
//
// Returns { master, upstream } where `master` is proxied through /api/hls so the
// frontend can play it (segments need a cloudnestra Referer + CORS, see hls.js).

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const VIDSRC_ORIGIN = 'https://vidsrc.me';
const CLOUDNESTRA = 'https://cloudnestra.com';
const MIRROR_HOST = 'cloudnestra.com'; // {vN} host placeholders resolve to this

// cloudnestra serves a Cloudflare Turnstile MANAGED challenge to many IPs. A bare
// fetch can't execute the challenge JS, so success is per-IP probabilistic. We
// route resolution (tiny ~66KB pages) through a Webshare rotating residential
// proxy and RETRY until an un-challenged IP is drawn; the resolved master is then
// cached. Video segments stay direct (see hls.js) to save proxy bandwidth.
// STREAM_PROXY_URL must use Webshare's `rotate` keyword so each new connection
// gets a fresh IP, e.g. http://user-CC-rotate:pass@p.webshare.io:80
const PROXY_MAX_ATTEMPTS = parseInt(process.env.STREAM_PROXY_RETRIES || '10', 10);

// Preferred path: a residential-IP relay (home machine behind a tunnel) does the
// cloudnestra fetches with an un-blocked IP and serves segments on its own
// unmetered bandwidth. When configured we just ask it to resolve; it returns a
// master URL pointing at its own /hls. Webshare below is the fallback.
const RELAY_URL = (process.env.STREAM_RELAY_URL || '').replace(/\/$/, '');
const RELAY_SECRET = process.env.STREAM_RELAY_SECRET || '';

async function resolveViaRelay({ type, id, season, episode }) {
  const params = new URLSearchParams({ type, id });
  if (type === 'tv' && season && episode) {
    params.set('s', season);
    params.set('e', episode);
  }
  const r = await fetch(RELAY_URL + '/resolve?' + params.toString(), {
    headers: { Authorization: 'Bearer ' + RELAY_SECRET },
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.master) throw new Error(data.error || 'relay resolve failed (' + r.status + ')');
  return { master: data.master, upstream: data.upstream };
}

// Fresh ProxyAgent per attempt => new upstream connection => the `rotate` endpoint
// hands out a new residential IP.
function makeDispatcher() {
  const base = process.env.STREAM_PROXY_URL;
  if (!base) return null;
  const { ProxyAgent } = require('undici');
  return new ProxyAgent(base);
}

function b64urlEncode(s) {
  return Buffer.from(s, 'utf8').toString('base64url');
}

async function fetchText(url, referer, dispatcher) {
  const opts = {
    headers: {
      'User-Agent': UA,
      Accept: '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      Referer: referer,
    },
    redirect: 'follow',
  };
  if (dispatcher) opts.dispatcher = dispatcher;
  const r = await fetch(url, opts);
  return { status: r.status, text: await r.text() };
}

// Retryable failures: Turnstile block, or transient upstream/proxy errors that a
// different IP may avoid. Anything else (e.g. parse failures) won't improve on retry.
function isRetryable(err) {
  return /Turnstile|status (404|5\d\d)|fetch failed|timeout|ECONNRESET|terminated/i.test(
    String((err && err.message) || err),
  );
}

async function resolveMasterWithRetry(embedUrl) {
  const proxyEnabled = !!process.env.STREAM_PROXY_URL;
  const attempts = proxyEnabled ? PROXY_MAX_ATTEMPTS : 1;
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    const dispatcher = makeDispatcher();
    try {
      return await resolveMaster(embedUrl, dispatcher);
    } catch (e) {
      lastErr = e;
      if (!proxyEnabled || !isRetryable(e)) break;
    } finally {
      if (dispatcher) dispatcher.close().catch(() => {});
    }
  }
  throw lastErr;
}

async function resolveMaster(embedUrl, dispatcher) {
  const embed = await fetchText(embedUrl, VIDSRC_ORIGIN + '/', dispatcher);
  if (embed.status !== 200) throw new Error('embed status ' + embed.status);
  const rcpMatch = embed.text.match(/src="(\/\/cloudnestra\.com\/rcp\/[^"]+)"/i);
  if (!rcpMatch) throw new Error('rcp iframe not found in embed');
  const rcpUrl = 'https:' + rcpMatch[1];

  const rcp = await fetchText(rcpUrl, VIDSRC_ORIGIN + '/', dispatcher);
  if (rcp.status !== 200) throw new Error('rcp status ' + rcp.status);
  if (/cf-turnstile|challenges\.cloudflare\.com/i.test(rcp.text) && !/\/prorcp\//i.test(rcp.text)) {
    throw new Error('blocked by Turnstile challenge');
  }
  const prorcpMatch = rcp.text.match(/['"](\/prorcp\/[A-Za-z0-9_=-]+)['"]/);
  if (!prorcpMatch) throw new Error('prorcp path not found in rcp');
  const prorcpUrl = CLOUDNESTRA + prorcpMatch[1];

  const prorcp = await fetchText(prorcpUrl, rcpUrl, dispatcher);
  if (prorcp.status !== 200) throw new Error('prorcp status ' + prorcp.status);
  const fileMatch = prorcp.text.match(/file:\s*"([^"]+)"/i);
  if (!fileMatch || !fileMatch[1].trim()) throw new Error('player file string not found in prorcp');

  const candidates = fileMatch[1].split(/\s+or\s+/i).map((s) => s.trim());
  const first = candidates.find((u) => /\.m3u8/i.test(u));
  if (!first) throw new Error('no m3u8 url in player file string');

  return first.replace(/\{v\d+\}/g, MIRROR_HOST);
}

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

  try {
    let payload;
    if (RELAY_URL && RELAY_SECRET) {
      payload = await resolveViaRelay({ type, id, season, episode });
    } else {
      let embedUrl = VIDSRC_ORIGIN + '/embed/' + type + '/' + id;
      if (type === 'tv' && season && episode) embedUrl += '/' + season + '-' + episode;
      const master = await resolveMasterWithRetry(embedUrl);
      // Relative URL: the browser resolves it against its own origin, so it works
      // identically behind the dev proxy (:4200) and in production (fiesta.show).
      payload = { master: '/api/hls?u=' + b64urlEncode(master), upstream: master };
    }
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');
    return res.status(200).json({ ...payload, env: process.env.VERCEL_ENV || 'development' });
  } catch (e) {
    console.error('stream resolve error:', e);
    return res.status(502).json({ error: String((e && e.message) || e) });
  }
};
