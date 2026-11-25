// /tidal/seg - TIDAL audio segment proxy for the browser.
//
// TIDAL's audio CDN answers 403 to any request carrying an Origin header (so browsers
// cannot fetch it) or a Cf-Worker header (so Cloudflare Workers cannot either). This box
// can: the browser fetches segments from here, with CORS, and the Cloudflare Worker is
// never involved in the audio bytes.
//
//   GET /tidal/seg?u=<b64url TIDAL url, may contain $Number$>&t=<exp.sig>&n=<first>&c=<count 1..8>
//
// `t` = `${exp}.${base64url(HMAC-SHA256(RELAY_SECRET, `${exp}.${u}`))}`, minted by the Worker
// (lib/tidal.js relaySegSign) so only URLs it issued are served. c>1 concatenates n..n+c-1
// back to back in one streamed body; c=1 honours Range.
import { createHmac, timingSafeEqual } from 'node:crypto';

const MAX_COUNT = 8;
const PARALLEL = 3;
const AUDIO_HOST = /(^|\.)tidal\.com$/;

function verify(u, t, secret) {
  if (!u || typeof t !== 'string') return false;
  const dot = t.indexOf('.');
  if (dot < 0) return false;
  const exp = parseInt(t.slice(0, dot), 10);
  if (!exp || exp < Math.floor(Date.now() / 1000)) return false;
  const expected = createHmac('sha256', secret).update(`${exp}.${u}`).digest('base64url');
  const a = Buffer.from(t.slice(dot + 1));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function target(u, n) {
  let s = '';
  try {
    s = Buffer.from(u, 'base64url').toString().replace('$Number$', String(n));
    const x = new URL(s);
    return x.protocol === 'https:' && AUDIO_HOST.test(x.hostname) ? s : null;
  } catch {
    return null;
  }
}

function fail(res, status, error) {
  if (res.headersSent) return res.destroy();
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify({ error }));
}

export async function handleTidalSeg(req, res, url, secret, setCors) {
  setCors(req, res);
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, X-Fiesta-Source');
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.setHeader('Access-Control-Max-Age', '3600');
    return res.end();
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, 'method_not_allowed');

  const u = url.searchParams.get('u') || '';
  if (!verify(u, url.searchParams.get('t'), secret)) return fail(res, 403, 'bad_token');
  const n0 = Math.max(0, parseInt(url.searchParams.get('n') || '0', 10) || 0);
  const c = Math.min(MAX_COUNT, Math.max(1, parseInt(url.searchParams.get('c') || '1', 10) || 1));
  if (!target(u, n0)) return fail(res, 400, 'bad_target');

  const cache = 'private, max-age=1800';
  const ac = new AbortController();
  res.on('close', () => ac.abort());

  if (c === 1) {
    const headers = {};
    if (req.headers.range) headers.Range = req.headers.range;
    let r;
    try {
      r = await fetch(target(u, n0), { headers, signal: ac.signal });
    } catch {
      return fail(res, 502, 'upstream_fetch');
    }
    if (!r.ok && r.status !== 206) return fail(res, r.status === 404 ? 404 : 502, 'upstream_' + r.status);
    for (const h of ['content-type', 'content-range', 'accept-ranges', 'content-length']) {
      const v = r.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    res.setHeader('Cache-Control', cache);
    res.statusCode = r.status;
    if (req.method === 'HEAD') return res.end();
    for await (const chunk of r.body) if (!res.write(chunk)) await new Promise((ok) => res.once('drain', ok));
    return res.end();
  }

  const start = (i) => fetch(target(u, n0 + i), { signal: ac.signal }).then((r) => r, (e) => ({ failed: e }));
  const pending = [];
  for (let i = 0; i < Math.min(c, PARALLEL); i++) pending.push(start(i));
  let sent = false;
  try {
    for (let i = 0; i < c; i++) {
      const r = await pending[i];
      const next = i + PARALLEL;
      if (next < c) pending.push(start(next));
      if (r.failed || !r.ok) {
        if (!sent) return fail(res, !r.failed && r.status === 404 ? 404 : 502, 'upstream_' + (r.failed ? 'fetch' : r.status));
        if (!r.failed && r.status >= 400 && r.status < 500) break; // past the last segment
        return res.destroy(); // mid-stream failure: never truncate audio silently
      }
      if (!sent) {
        const type = r.headers.get('content-type');
        if (type) res.setHeader('Content-Type', type);
        res.setHeader('Cache-Control', cache);
        res.statusCode = 200;
        sent = true;
      }
      for await (const chunk of r.body) if (!res.write(chunk)) await new Promise((ok) => res.once('drain', ok));
    }
    res.end();
  } catch {
    if (sent) res.destroy();
    else fail(res, 502, 'upstream_fetch');
  } finally {
    ac.abort();
  }
}
