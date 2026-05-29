// Proxies HLS playlists and segments from cloudnestra's stream hosts.
//
// Stream segments 403 without `Referer: https://cloudnestra.com/` and the hosts
// send no CORS headers, so the browser can't fetch them directly. This injects
// the Referer, adds CORS, and rewrites playlist child URLs back through itself.
//
// Cloudnestra's playlist hosts (tmstr*.cloudnestra.com) are behind Cloudflare and
// 403 datacenter IPs (e.g. Vercel), so .m3u8 fetches go through the rotating
// residential proxy (same as resolution). Segments live on a plain CDN — fetched
// direct first to save proxy bandwidth, falling back to the proxy only on 403.
//
//   GET /api/hls?u={base64url(absoluteUrl)}

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const STREAM_REFERER = 'https://cloudnestra.com/';
const CLOUDNESTRA = 'https://cloudnestra.com';
const PROXY_MAX_ATTEMPTS = parseInt(process.env.STREAM_PROXY_RETRIES || '10', 10);

function makeDispatcher() {
  const base = process.env.STREAM_PROXY_URL;
  if (!base) return null;
  const { ProxyAgent } = require('undici');
  return new ProxyAgent(base);
}

// Fetch with the cloudnestra Referer. Playlists always go through the rotating
// proxy (retrying fresh IPs on 403/5xx); segments try direct, then proxy on 403.
// Returns { res, viaProxy } so the handler can report the path taken.
async function fetchUpstream(target) {
  const headers = { 'User-Agent': UA, Accept: '*/*', Referer: STREAM_REFERER, Origin: CLOUDNESTRA };
  const isPlaylist = /\.m3u8($|\?)/i.test(target);

  if (!isPlaylist) {
    const direct = await fetch(target, { headers, redirect: 'follow' });
    if (direct.status !== 403) return { res: direct, viaProxy: false };
  }
  const res = await fetchViaProxy(target, headers);
  return { res, viaProxy: true };
}

async function fetchViaProxy(target, headers) {
  const proxyEnabled = !!process.env.STREAM_PROXY_URL;
  const attempts = proxyEnabled ? PROXY_MAX_ATTEMPTS : 1;
  let last;
  for (let i = 0; i < attempts; i++) {
    const dispatcher = makeDispatcher();
    try {
      const opts = { headers, redirect: 'follow' };
      if (dispatcher) opts.dispatcher = dispatcher;
      const r = await fetch(target, opts);
      if (r.status !== 403 && r.status < 500) return r;
      last = r;
    } catch (e) {
      last = e;
    } finally {
      if (dispatcher) dispatcher.close().catch(() => {});
    }
    if (!proxyEnabled) break;
  }
  if (last && typeof last.status === 'number') return last;
  throw last;
}

function b64urlEncode(s) {
  return Buffer.from(s, 'utf8').toString('base64url');
}
function b64urlDecode(s) {
  return Buffer.from(s, 'base64url').toString('utf8');
}

const TAGS_WITH_URI = /(#EXT-X-(?:KEY|MAP|MEDIA|I-FRAME-STREAM-INF)[^\n]*?URI=")([^"]+)(")/gi;

// Root-relative so the browser resolves against its own origin (dev proxy / prod).
function proxied(absUrl) {
  return '/api/hls?u=' + b64urlEncode(absUrl);
}

function rewritePlaylist(body, playlistUrl) {
  const base = new URL(playlistUrl);
  const resolve = (raw) => {
    try {
      return new URL(raw, base).href;
    } catch {
      return raw;
    }
  };

  body = body.replace(TAGS_WITH_URI, (_m, pre, uri, post) => pre + proxied(resolve(uri)) + post);

  return body
    .split('\n')
    .map((line) => {
      const t = line.trim();
      if (!t || t.startsWith('#')) return line;
      return proxied(resolve(t));
    })
    .join('\n');
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const u = req.query.u;
  if (!u) return res.status(400).send('missing u');

  let target;
  try {
    target = b64urlDecode(u);
    new URL(target); // validate
  } catch {
    return res.status(400).send('bad u param');
  }

  let upstream, viaProxy;
  try {
    ({ res: upstream, viaProxy } = await fetchUpstream(target));
  } catch (e) {
    console.error('hls upstream error:', e);
    return res.status(502).send('upstream fetch failed');
  }

  // Debug: report which path was used (read by the preview-only player overlay).
  res.setHeader('X-Fiesta-Source', viaProxy ? 'proxy' : 'direct');
  res.setHeader('Access-Control-Expose-Headers', 'X-Fiesta-Source');

  const targetPath = new URL(target).pathname;
  const ct = (upstream.headers.get('content-type') || '').toLowerCase();
  const isPlaylist = ct.includes('mpegurl') || /\.m3u8($|\?)/i.test(target);

  if (isPlaylist) {
    const text = await upstream.text();
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(upstream.status).send(rewritePlaylist(text, target));
  }

  // binary segment passthrough; segments are MPEG-TS mislabeled as text/html (page-N.html)
  const buf = Buffer.from(await upstream.arrayBuffer());
  const looksTs = /\.(ts|html)($|\?)/i.test(targetPath);
  res.setHeader('Content-Type', looksTs ? 'video/mp2t' : ct || 'application/octet-stream');
  // s-maxage lets Vercel's edge CDN cache segments across users (not just the
  // browser). The (token, segment) URL is immutable, so a long TTL is safe.
  res.setHeader('Cache-Control', 'public, max-age=31536000, s-maxage=31536000, immutable');
  return res.status(upstream.status).send(buf);
};
