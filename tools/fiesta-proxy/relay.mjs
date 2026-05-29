// Residential-IP relay for the fiesta HLS stream.
//
// Runs on a home machine (e.g. a Mac mini) behind a tunnel mapped to a public
// subdomain. Cloudflare fronts cloudnestra's playlist + segment hosts and 403s
// datacenter IPs (Vercel, cheap proxies), but lets residential IPs through. So
// this box does the actual cloudnestra fetches with its home IP and serves the
// bytes to the browser — offloading both the Webshare proxy quota and Vercel's
// egress bandwidth.
//
// Endpoints:
//   GET /healthz                         -> "ok"
//   GET /resolve?type=&id=&s=&e=         -> { master, upstream }   [Vercel only, Bearer auth]
//   GET /hls?u=<b64url(absUrl)>&t=<tok>  -> playlist (rewritten) or segment bytes  [browser, token-gated]
//
// /resolve is called server-side by Vercel (STREAM_RELAY_SECRET). It walks the
// embed chain and returns a master URL pointing back at THIS relay's public /hls,
// carrying a short-lived HMAC token. The browser then streams playlists+segments
// straight from /hls (token-gated so the public subdomain isn't an open proxy).
//
// Env:
//   RELAY_PORT          listen port (default 8787)
//   RELAY_PUBLIC_URL    public base, e.g. https://relay.fiesta.show  (required for /resolve)
//   RELAY_SECRET        bearer secret Vercel presents to /resolve     (required)
//   RELAY_SIGNING_KEY   HMAC key for playback tokens                  (required)
//   RELAY_TOKEN_TTL     token lifetime seconds (default 21600 = 6h)
//   RELAY_ALLOW_ORIGIN  optional CORS allowlist (comma list). Default: reflect any origin.

import http from 'node:http';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Load gitignored .env.local (RELAY_* live here for convenience).
const envFile = path.join(HERE, '.env.local');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const PORT = parseInt(process.env.RELAY_PORT || '8787', 10);
const PUBLIC_URL = (process.env.RELAY_PUBLIC_URL || '').replace(/\/$/, '');
const SECRET = process.env.RELAY_SECRET || '';
const SIGNING_KEY = process.env.RELAY_SIGNING_KEY || '';
const TOKEN_TTL = parseInt(process.env.RELAY_TOKEN_TTL || '21600', 10);
const ALLOW_ORIGIN = (process.env.RELAY_ALLOW_ORIGIN || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

if (!SECRET || !SIGNING_KEY) {
  console.error('FATAL: set RELAY_SECRET and RELAY_SIGNING_KEY');
  process.exit(1);
}

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const VIDSRC_ORIGIN = 'https://vidsrc.me';
const CLOUDNESTRA = 'https://cloudnestra.com';
const STREAM_REFERER = 'https://cloudnestra.com/';

const b64urlEncode = (s) => Buffer.from(s, 'utf8').toString('base64url');
const b64urlDecode = (s) => Buffer.from(s, 'base64url').toString('utf8');

// --- playback tokens: `${exp}.${base64url(hmac(exp))}`, time-limited ----------
function mintToken(ttl = TOKEN_TTL) {
  const exp = Math.floor(Date.now() / 1000) + ttl;
  const sig = createHmac('sha256', SIGNING_KEY).update(String(exp)).digest('base64url');
  return `${exp}.${sig}`;
}
function verifyToken(token) {
  if (!token || typeof token !== 'string') return false;
  const dot = token.indexOf('.');
  if (dot < 0) return false;
  const exp = parseInt(token.slice(0, dot), 10);
  if (!exp || exp < Math.floor(Date.now() / 1000)) return false;
  const sig = token.slice(dot + 1);
  const expected = createHmac('sha256', SIGNING_KEY).update(String(exp)).digest('base64url');
  const a = Buffer.from(sig, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

// --- SSRF guard: only public https hosts (protects the home LAN if SECRET leaks) -
function isPrivateAddr(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }
  const low = ip.toLowerCase();
  return low === '::1' || low === '::' || low.startsWith('fc') || low.startsWith('fd') || low.startsWith('fe80');
}
async function assertPublicHttps(target) {
  const url = new URL(target);
  if (url.protocol !== 'https:') throw new Error('only https allowed');
  const { address } = await lookup(url.hostname);
  if (isPrivateAddr(address)) throw new Error('blocked private host');
  return url;
}

// --- cloudnestra fetches (direct from this box's residential IP) ---------------
async function fetchText(url, referer) {
  const r = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: '*/*', 'Accept-Language': 'en-US,en;q=0.9', Referer: referer },
    redirect: 'follow',
  });
  return { status: r.status, text: await r.text() };
}

// Residential IPs rarely get a Turnstile page, but it's probabilistic — small retry.
async function resolveMaster(embedUrl) {
  let lastErr;
  for (let i = 0; i < 4; i++) {
    try {
      return await resolveMasterOnce(embedUrl);
    } catch (e) {
      lastErr = e;
      if (!/Turnstile|status (404|5\d\d)|fetch failed|timeout|ECONNRESET|terminated/i.test(String(e?.message || e)))
        break;
    }
  }
  throw lastErr;
}

async function resolveMasterOnce(embedUrl) {
  const embed = await fetchText(embedUrl, VIDSRC_ORIGIN + '/');
  if (embed.status !== 200) throw new Error('embed status ' + embed.status);
  const rcpMatch = embed.text.match(/src="(\/\/cloudnestra\.com\/rcp\/[^"]+)"/i);
  if (!rcpMatch) throw new Error('rcp iframe not found in embed');
  const rcpUrl = 'https:' + rcpMatch[1];

  const rcp = await fetchText(rcpUrl, VIDSRC_ORIGIN + '/');
  if (rcp.status !== 200) throw new Error('rcp status ' + rcp.status);
  if (/cf-turnstile|challenges\.cloudflare\.com/i.test(rcp.text) && !/\/prorcp\//i.test(rcp.text))
    throw new Error('blocked by Turnstile challenge');
  const prorcpMatch = rcp.text.match(/['"](\/prorcp\/[A-Za-z0-9_=-]+)['"]/);
  if (!prorcpMatch) throw new Error('prorcp path not found in rcp');
  const prorcpUrl = CLOUDNESTRA + prorcpMatch[1];

  const prorcp = await fetchText(prorcpUrl, rcpUrl);
  if (prorcp.status !== 200) throw new Error('prorcp status ' + prorcp.status);
  const fileMatch = prorcp.text.match(/file:\s*"([^"]+)"/i);
  if (!fileMatch || !fileMatch[1].trim()) throw new Error('player file string not found in prorcp');

  const first = fileMatch[1].split(/\s+or\s+/i).map((s) => s.trim()).find((u) => /\.m3u8/i.test(u));
  if (!first) throw new Error('no m3u8 url in player file string');
  return first.replace(/\{v\d+\}/g, 'cloudnestra.com');
}

// --- playlist rewriting: point child URLs back at this relay's /hls -------------
const TAGS_WITH_URI = /(#EXT-X-(?:KEY|MAP|MEDIA|I-FRAME-STREAM-INF)[^\n]*?URI=")([^"]+)(")/gi;

function rewritePlaylist(body, playlistUrl, token) {
  const base = new URL(playlistUrl);
  // Relative URLs resolve against the playlist's URL (served from this relay),
  // so children stay on the relay regardless of public hostname.
  const proxied = (raw) => {
    let abs;
    try {
      abs = new URL(raw, base).href;
    } catch {
      return raw;
    }
    return '/hls?u=' + b64urlEncode(abs) + '&t=' + token;
  };
  body = body.replace(TAGS_WITH_URI, (_m, pre, uri, post) => pre + proxied(uri) + post);
  return body
    .split('\n')
    .map((line) => {
      const t = line.trim();
      if (!t || t.startsWith('#')) return line;
      return proxied(t);
    })
    .join('\n');
}

// --- http helpers --------------------------------------------------------------
function setCors(req, res) {
  const origin = req.headers.origin;
  if (ALLOW_ORIGIN.length === 0) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
  } else if (origin && ALLOW_ORIGIN.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Expose-Headers', 'X-Fiesta-Source');
}

async function handleResolve(req, res, url) {
  const auth = req.headers.authorization || '';
  const ok = auth.startsWith('Bearer ') && (() => {
    const got = Buffer.from(auth.slice(7));
    const want = Buffer.from(SECRET);
    return got.length === want.length && timingSafeEqual(got, want);
  })();
  if (!ok) {
    res.statusCode = 401;
    return res.end('unauthorized');
  }
  if (!PUBLIC_URL) {
    res.statusCode = 500;
    return res.end('RELAY_PUBLIC_URL not set');
  }

  const type = url.searchParams.get('type') === 'tv' ? 'tv' : 'movie';
  const id = url.searchParams.get('id');
  const s = url.searchParams.get('s');
  const e = url.searchParams.get('e');
  if (!id || !/^tt\d+$/.test(id)) {
    res.statusCode = 400;
    return res.end(JSON.stringify({ error: 'invalid imdb id' }));
  }

  let embedUrl = VIDSRC_ORIGIN + '/embed/' + type + '/' + id;
  if (type === 'tv' && s && e) embedUrl += '/' + s + '-' + e;

  try {
    const master = await resolveMaster(embedUrl);
    const token = mintToken();
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    return res.end(
      JSON.stringify({
        master: PUBLIC_URL + '/hls?u=' + b64urlEncode(master) + '&t=' + token,
        upstream: master,
      }),
    );
  } catch (err) {
    console.error('[resolve]', id, String(err?.message || err));
    res.statusCode = 502;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ error: String(err?.message || err) }));
  }
}

async function handleHls(req, res, url) {
  setCors(req, res);
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }

  const u = url.searchParams.get('u');
  const token = url.searchParams.get('t');
  if (!u) {
    res.statusCode = 400;
    return res.end('missing u');
  }
  if (!verifyToken(token)) {
    res.statusCode = 403;
    return res.end('bad or expired token');
  }

  let target;
  try {
    target = b64urlDecode(u);
    await assertPublicHttps(target);
  } catch (err) {
    res.statusCode = 400;
    return res.end('bad target: ' + String(err?.message || err));
  }

  let upstream;
  try {
    upstream = await fetch(target, {
      headers: { 'User-Agent': UA, Accept: '*/*', Referer: STREAM_REFERER, Origin: CLOUDNESTRA },
      redirect: 'follow',
    });
  } catch (err) {
    console.error('[hls] upstream fail', String(err?.message || err));
    res.statusCode = 502;
    return res.end('upstream fetch failed');
  }

  res.setHeader('X-Fiesta-Source', 'relay');
  const targetPath = new URL(target).pathname;
  const ct = (upstream.headers.get('content-type') || '').toLowerCase();
  const isPlaylist = ct.includes('mpegurl') || /\.m3u8($|\?)/i.test(target);

  if (isPlaylist) {
    const text = await upstream.text();
    res.statusCode = upstream.status;
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control', 'no-store');
    return res.end(rewritePlaylist(text, target, token));
  }

  // Segment: MPEG-TS, often mislabeled text/html (page-N.html). Immutable -> long cache.
  const buf = Buffer.from(await upstream.arrayBuffer());
  const looksTs = /\.(ts|html?)($|\?)/i.test(targetPath);
  res.statusCode = upstream.status;
  res.setHeader('Content-Type', looksTs ? 'video/mp2t' : ct || 'application/octet-stream');
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  return res.end(buf);
}

const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch {
    res.statusCode = 400;
    return res.end('bad request');
  }

  try {
    if (url.pathname === '/healthz') {
      res.statusCode = 200;
      return res.end('ok');
    }
    if (url.pathname === '/resolve') return await handleResolve(req, res, url);
    if (url.pathname === '/hls') return await handleHls(req, res, url);
    res.statusCode = 404;
    res.end('not found');
  } catch (err) {
    console.error('[relay] unhandled', String(err?.stack || err));
    if (!res.headersSent) res.statusCode = 500;
    res.end('error');
  }
});

server.listen(PORT, () => {
  console.log(`fiesta relay listening on :${PORT}`);
  console.log(`  public url : ${PUBLIC_URL || '(RELAY_PUBLIC_URL unset — /resolve will 500)'}`);
  console.log(`  token ttl  : ${TOKEN_TTL}s`);
  console.log(`  cors       : ${ALLOW_ORIGIN.length ? ALLOW_ORIGIN.join(', ') : 'reflect any origin'}`);
});
