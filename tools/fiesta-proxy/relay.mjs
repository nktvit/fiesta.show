// Residential-IP relay for the fiesta HLS stream.
//
// Runs on a home machine (e.g. a Mac mini) behind a tunnel mapped to a public
// subdomain. Cloudflare fronts the stream backend's playlist + segment hosts and
// 403s datacenter IPs (Vercel, cheap proxies), but lets residential IPs through.
// So this box does the actual upstream fetches with its home IP and serves the
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
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { chromium } from 'playwright-core';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { handleTidalToken } from './tidal-session.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Load gitignored .env.local (RELAY_* live here for convenience).
const envFile = path.join(HERE, '.env.local');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

// relay.log carried no timestamps on any of its console sites, so it could not be
// sliced into before/after windows — which made every claim about playback health
// unfalsifiable. Wrap once here so all existing call sites gain an ISO-8601 prefix
// without being touched. NOTE: this shifts awk field positions and breaks a
// `^\[resolve\]` anchor, so scripts/autofix-watchdog.sh was updated in the same
// change window. If you revert this, revert that too.
for (const level of ['log', 'error', 'warn']) {
  const orig = console[level].bind(console);
  console[level] = (...args) => orig(new Date().toISOString(), ...args);
}

const PORT = parseInt(process.env.RELAY_PORT || '8787', 10);
const PUBLIC_URL = (process.env.RELAY_PUBLIC_URL || '').replace(/\/$/, '');
const SECRET = process.env.RELAY_SECRET || '';
const SIGNING_KEY = process.env.RELAY_SIGNING_KEY || '';
const TOKEN_TTL = parseInt(process.env.RELAY_TOKEN_TTL || '21600', 10);
// Re-resolve a front this many times (fresh stream token each) when the walk fails
// transiently or the master is born dead, before falling through to the next front.
// Each try is a full walk (~1-4s). Lowered to 1 while upstream is rate-limiting our IP
// — extra retries on a 429 just amplify pressure and prolong the rate-limit window.
// Raise back to 2–3 once upstreams are healthy again.
const RESOLVE_TRIES = parseInt(process.env.RELAY_RESOLVE_TRIES || '1', 10);
// The stream backend 502s individual stream fetches at random (transient, per-request
// — the same URL succeeds on a retry). Retry each /hls upstream fetch this many times on 5xx.
const HLS_TRIES = parseInt(process.env.RELAY_HLS_TRIES || '3', 10);
// Resolve cache: same (type, id, s, e, srv) returns the same upstream m3u8 within this
// TTL without doing another upstream walk. Repeat opens / multi-viewer / refreshes all
// share one walk; the per-call token + UA stay fresh. Tokens we mint have their own 6h
// TTL, so this only bounds upstream staleness.
const RESOLVE_CACHE_TTL = parseInt(process.env.RELAY_RESOLVE_CACHE_TTL || '600', 10);
const RESOLVE_CACHE_MAX = parseInt(process.env.RELAY_RESOLVE_CACHE_MAX || '500', 10);
// Per-front circuit breaker: when a front returns an HTTP-status response (rate-limit
// or origin down), refuse to even try it again for this cooldown. Stops amplification
// on a front that's already telling us "no".
const BREAKER_COOLDOWN = parseInt(process.env.RELAY_BREAKER_COOLDOWN || '90', 10);
// While every front is cooling, let one request through this often to find out whether
// upstream is back, instead of refusing everything until the cooldown happens to lapse.
const BREAKER_PROBE = parseInt(process.env.RELAY_BREAKER_PROBE || '15', 10);
const ALLOW_ORIGIN = (process.env.RELAY_ALLOW_ORIGIN || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

if (!SECRET || !SIGNING_KEY) {
  console.error('FATAL: set RELAY_SECRET and RELAY_SIGNING_KEY');
  process.exit(1);
}

// Pool of realistic device UAs. One is chosen per /resolve and used for that whole
// movie (the resolve walk + every /hls segment fetch), so the stream backend sees
// what looks like a mix of household devices rather than one client hammering it.
const UAS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (iPad; CPU OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
];
const UA = UAS[0]; // default/fallback when an /hls request carries no (valid) ua index
let uaCursor = 0;
function nextUaIndex() {
  const i = uaCursor;
  uaCursor = (uaCursor + 1) % UAS.length;
  return i;
}
// Front-ends onto the SAME stream backend. Same embed path, different host →
// a different embed session → a different underlying stream, so when one
// front's stream for a title is dead the other often plays.
const FRONTS = {
  1: { host: 'vidsrc.me', origin: 'https://vidsrc.me' },
  2: { host: 'vsembed.ru', origin: 'https://vsembed.ru' },
};
// Origin of the current stream backend (rotates when the operator migrates
// infra — cloudnestra.com -> cloudorchestranova.com happened 2026-08). Sent as
// Referer/Origin on the final CDN fetches (playlists/segments); the embed-chain
// walk below discovers the live domain itself each resolve, so only this
// fetchUpstream-facing constant needs updating on the next rotation.
const STREAM_BACKEND_ORIGIN = 'https://cloudorchestranova.com';
const STREAM_REFERER = STREAM_BACKEND_ORIGIN + '/';

const b64urlEncode = (s) => Buffer.from(s, 'utf8').toString('base64url');
const b64urlDecode = (s) => Buffer.from(s, 'base64url').toString('utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

// --- embed-chain fetches (direct from this box's residential IP) ---------------
async function fetchText(url, referer, ua = UA) {
  const r = await fetch(url, {
    headers: { 'User-Agent': ua, Accept: '*/*', 'Accept-Language': 'en-US,en;q=0.9', Referer: referer },
    redirect: 'follow',
  });
  // r.url is the POST-redirect URL. Fronts like vidsrc.me 301 to a different host
  // (vidsrcme.ru) before rendering the iframe, so the next hop's real Referer (what
  // a browser would send, per the pages' referrer-policy="origin") is this page's
  // final origin — not the URL we originally requested.
  return { status: r.status, text: await r.text(), url: r.url };
}

// Turnstile shows up as a Cloudflare challenge served in place of the expected
// HTML at any step of the embed-chain walk. Recognized by resolveMaster's retry
// logic (`/Turnstile/i`), which then falls through to the headless-browser path.
function checkTurnstile(html, step) {
  if (/cf-turnstile|challenges\.cloudflare\.com/i.test(html)) {
    throw new Error(`blocked by Turnstile challenge (${step})`);
  }
}

// Each embed-chain page hands off to the next via a flat `window.<NAME> = {...};`
// object literal — CFG on the iframe page, CONFIG on the player page. Values seen
// so far are all scalars, so a non-greedy match up to the first `};` is enough.
function extractInlineJSON(html, varName) {
  const m = html.match(new RegExp('window\\.' + varName + '\\s*=\\s*(\\{.*?\\});', 's'));
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

// The #player_iframe tag no longer carries a static src=; instead it has a
// data-api= pointing at a gate endpoint (vs_src.php) that returns {src: "..."}
// with a short-lived host-bound token. Fetched at runtime, not baked into the
// (cacheable) embed HTML.
function extractPlayerIframeApi(html) {
  const tag = html.match(/<iframe\b[^>]*\bid=["']player_iframe["'][^>]*>/i);
  if (!tag) return null;
  const api = tag[0].match(/\bdata-api=["']([^"']+)["']/i);
  if (!api) return null;
  return api[1].replace(/&amp;/g, '&');
}

// --- stream_urls decryption (mirrors vsdec.js) ----------------------------------
// The stream-data API returns `data.stream_urls` as a plain array, OR — when
// protection is enabled — a single base64 ChaCha20 (nonce||ciphertext) string
// plus `vs: { w, wasm_url }` naming the per-~5min-window WASM decryptor. Node's
// WebAssembly global does this natively; no browser needed for this step.
const wasmModuleCache = new Map(); // vs.w -> Promise<WebAssembly.Module>
const WASM_CACHE_MAX = 20;

function getWasmModule(w, wasmUrl, ua) {
  const key = String(w);
  const cached = wasmModuleCache.get(key);
  if (cached) return cached;
  if (wasmModuleCache.size >= WASM_CACHE_MAX) {
    const oldest = wasmModuleCache.keys().next().value;
    if (oldest !== undefined) wasmModuleCache.delete(oldest);
  }
  const p = fetch(wasmUrl, { headers: { 'User-Agent': ua, Referer: STREAM_REFERER } })
    .then((r) => {
      if (!r.ok) throw new Error('wasm status ' + r.status);
      return r.arrayBuffer();
    })
    .then((buf) => WebAssembly.compile(buf));
  p.catch(() => wasmModuleCache.delete(key)); // don't cache a failed compile
  wasmModuleCache.set(key, p);
  return p;
}

async function decryptStreamUrls(apiJson, ua) {
  const raw = apiJson?.data?.stream_urls;
  if (Array.isArray(raw)) return raw.filter(Boolean);
  if (typeof raw !== 'string' || !raw) return [];
  const vs = apiJson.vs;
  if (!vs?.wasm_url) throw new Error('stream_urls encrypted but no vs.wasm_url in api response');
  const mod = await getWasmModule(vs.w, vs.wasm_url, ua);
  // Fresh instance per call (fresh linear memory) — the module's bump allocator
  // never resets, so reusing an instance across calls would leak/overflow it.
  const inst = await WebAssembly.instantiate(mod, {});
  const ex = inst.exports;
  const enc = Buffer.from(raw, 'base64');
  const ptr = ex.alloc(enc.length);
  new Uint8Array(ex.memory.buffer, ptr, enc.length).set(enc);
  const outLen = ex.decrypt(ptr, enc.length);
  const text = Buffer.from(ex.memory.buffer, ptr + 12, outLen).toString('utf8'); // first 12 bytes: nonce
  return text.split('\n').map((s) => s.trim()).filter(Boolean);
}

// --- per-host playback token (`<origin>/generate.php`) --------------------------
// Returns a short-lived (~4h) JWT bound to the caller's IP /24. One token covers
// the whole master + its child playlists/segments for that host, and the
// endpoint itself is aggressively rate-limited — so cache per host and dedupe
// concurrent fetches rather than pinging it per request.
const hostTokenCache = new Map(); // origin -> { token, exp }
const hostTokenInflight = new Map(); // origin -> Promise<string>

// Only SUCCESS used to be remembered here, and that is what turned a short upstream
// throttle into a sustained outage: a 429 wrote nothing, so the very next request for
// that origin called generate.php again immediately. Under real traffic that is a
// hammer on an endpoint whose own docs (see above) say it is aggressively rate-limited.
// Remember the refusal too. Keyed per origin, because a stream host is effectively
// per-title — five consecutive films resolved to five different hosts — so one host
// saying no tells us nothing about the others.
const hostTokenCooldown = new Map(); // origin -> { until, status }
const TOKEN_COOLDOWN = parseInt(process.env.RELAY_TOKEN_COOLDOWN || '120', 10);
const TOKEN_COOLDOWN_MAX = 900;
// Bound the map: origins are unbounded over time, the cooldowns are seconds long.
const TOKEN_COOLDOWN_MAX_ENTRIES = 500;

// A single origin refusing is a sick host; several distinct origins refusing inside a
// short window means the limit is on OUR IP (the token is a JWT bound to the caller's
// /24), and then trying the next new host just spends more of the same budget. Back off
// globally for that case only — this is the distinction the per-front breaker could not
// make, because fronts and stream origins are unrelated axes.
const TOKEN_GLOBAL_WINDOW_MS = 60_000;
const TOKEN_GLOBAL_TRIP = 3;
let tokenRecentFails = []; // [{ origin, at }], distinct origins only
let tokenGlobalUntil = 0;

function noteTokenFailure(origin, status) {
  const now = Date.now();
  tokenRecentFails = tokenRecentFails.filter((f) => now - f.at < TOKEN_GLOBAL_WINDOW_MS && f.origin !== origin);
  tokenRecentFails.push({ origin, at: now });
  if (tokenRecentFails.length >= TOKEN_GLOBAL_TRIP) {
    tokenGlobalUntil = now + TOKEN_COOLDOWN * 1000;
    tokenRecentFails = [];
    console.error(`[token] global cooldown ${TOKEN_COOLDOWN}s — ${TOKEN_GLOBAL_TRIP} distinct origins returned ${status}`);
  }
}

function jwtExp(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return typeof payload.exp === 'number' ? payload.exp : null;
  } catch {
    return null;
  }
}

async function getHostToken(origin, ua) {
  const now = Math.floor(Date.now() / 1000);
  const cached = hostTokenCache.get(origin);
  if (cached && cached.exp - 60 > now) return cached.token;

  // Both cooldowns are checked before the in-flight map so a refusal costs no socket.
  if (Date.now() < tokenGlobalUntil) {
    const left = Math.ceil((tokenGlobalUntil - Date.now()) / 1000);
    throw new Error(`generate cooling globally ${left}s`);
  }
  const cd = hostTokenCooldown.get(origin);
  if (cd && Date.now() < cd.until) {
    const left = Math.ceil((cd.until - Date.now()) / 1000);
    throw new Error(`generate cooling ${left}s for ${origin} (last status ${cd.status})`);
  }

  let p = hostTokenInflight.get(origin);
  if (!p) {
    p = (async () => {
      const r = await fetch(origin + '/generate.php', { headers: { 'User-Agent': ua, Referer: STREAM_REFERER } });
      if (!r.ok) {
        // Prefer the endpoint's own answer over our guess when it gives one.
        const ra = parseInt(r.headers.get('retry-after') || '', 10);
        const secs = Number.isFinite(ra) && ra > 0 ? Math.min(ra, TOKEN_COOLDOWN_MAX) : TOKEN_COOLDOWN;
        if (hostTokenCooldown.size >= TOKEN_COOLDOWN_MAX_ENTRIES) {
          const oldest = hostTokenCooldown.keys().next().value;
          if (oldest !== undefined) hostTokenCooldown.delete(oldest);
        }
        hostTokenCooldown.set(origin, { until: Date.now() + secs * 1000, status: r.status });
        console.error(`[token] ${origin} generate status ${r.status} — cooling ${secs}s`);
        noteTokenFailure(origin, r.status);
        throw new Error('generate status ' + r.status);
      }
      const token = (await r.text()).trim();
      hostTokenCooldown.delete(origin);
      hostTokenCache.set(origin, { token, exp: jwtExp(token) ?? now + 3600 });
      return token;
    })().finally(() => hostTokenInflight.delete(origin));
    hostTokenInflight.set(origin, p);
  }
  return p;
}

function applyStreamToken(url, token) {
  if (!token) return url;
  if (url.includes('__TOKEN__')) return url.split('__TOKEN__').join(token);
  return url + (url.includes('?') ? '&' : '?') + 'token=' + token;
}

// Single-attempt check (no retries — that's what the outer masterServes is for)
// used only to pick a likely-good candidate among several stream_urls.
async function quickServes(url, ua) {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': ua, Accept: '*/*', Referer: STREAM_REFERER }, redirect: 'follow' });
    try {
      await r.body?.cancel();
    } catch {}
    return r.status === 200;
  } catch {
    return false;
  }
}

// The shared tail of the embed-chain walk, from the layer2 (iframe target) page's
// HTML onward. `get(url, referer)` fetches a page as {status, text} — plain fetch
// for the fast path, or a browser-context request (post Turnstile-solve) for the
// fallback — everything from here behaves identically either way.
async function walkFromLayer2(layer2Text, layer2Url, ua, get) {
  checkTurnstile(layer2Text, 'layer2');
  const cfg = extractInlineJSON(layer2Text, 'CFG');
  if (!cfg?.playerUrl) throw new Error('CFG.playerUrl not found in layer2');
  const backendOrigin = new URL(layer2Url).origin;
  const layer3Url = backendOrigin + cfg.playerUrl;

  const layer3 = await get(layer3Url, layer2Url);
  if (layer3.status !== 200) throw new Error('layer3 status ' + layer3.status);
  checkTurnstile(layer3.text, 'layer3');
  const config = extractInlineJSON(layer3.text, 'CONFIG');
  if (!config) throw new Error('CONFIG not found in layer3');
  // Movies carry a ready-to-use CONFIG.api. TV carries CONFIG.streamBase instead —
  // the client builds the per-episode data URL itself (mirrors player.js's apiFor).
  const apiUrl =
    config.api ||
    (config.streamBase && config.season != null && config.episode != null
      ? config.streamBase + '&season=' + encodeURIComponent(config.season) + '&episode=' + encodeURIComponent(config.episode) + '&stream_urls'
      : null);
  if (!apiUrl) throw new Error('CONFIG.api not found in layer3');

  const apiRes = await get(apiUrl, layer3.url || layer3Url);
  if (apiRes.status !== 200) throw new Error('api status ' + apiRes.status);
  checkTurnstile(apiRes.text, 'api');
  let apiJson;
  try {
    apiJson = JSON.parse(apiRes.text);
  } catch {
    throw new Error('api response not valid json');
  }
  if (String(apiJson.status_code) !== '200' || !apiJson.data) throw new Error('api status_code ' + apiJson.status_code);

  const candidates = await decryptStreamUrls(apiJson, ua);
  if (!candidates.length) throw new Error('no stream urls in api response');

  let lastErr = null;
  for (const raw of candidates) {
    let origin;
    try {
      origin = new URL(raw).origin;
    } catch {
      continue;
    }
    try {
      const token = await getHostToken(origin, ua);
      const stamped = applyStreamToken(raw, token);
      if (await quickServes(stamped, ua)) return stamped;
      lastErr = new Error('candidate did not serve: ' + origin);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('no candidate stream host served');
}

// Entry point for the fast (plain-fetch) path: walk from the embed page's HTML.
async function walkFromEmbed(embedText, embedUrl, ua, get) {
  const apiPath = extractPlayerIframeApi(embedText);
  if (!apiPath) throw new Error('player_iframe data-api not found in embed');
  const apiUrl = apiPath.startsWith('http') ? apiPath : new URL(embedUrl).origin + apiPath;

  const gate = await get(apiUrl, embedUrl);
  if (gate.status !== 200) throw new Error('vs_src status ' + gate.status);
  checkTurnstile(gate.text, 'vs_src');
  let gateJson;
  try {
    gateJson = JSON.parse(gate.text);
  } catch {
    throw new Error('vs_src response not valid json');
  }
  const layer2Url = gateJson?.src;
  if (!layer2Url) throw new Error('vs_src.src not found');

  const layer2 = await get(layer2Url, embedUrl);
  if (layer2.status !== 200) throw new Error('layer2 status ' + layer2.status);
  return walkFromLayer2(layer2.text, layer2.url || layer2Url, ua, get);
}

// The per-host playback token is a 4h JWT, but getHostToken hands back a cached one
// with as little as 60s of life left, and the resolve cache then serves that same
// master for up to RESOLVE_CACHE_TTL. Our own /hls token lives 6h. So there is a
// window where this relay happily authorises requests whose UPSTREAM credential is
// already dead, and then every segment 403s: fetchUpstream returns anything < 500
// immediately, so nothing retried and nothing refreshed, and the player burned its
// one-shot front escalation on what was only an expired token.
//
// Refresh once and retry. The important subtlety is the 403 STORM: once a token
// expires, every in-flight segment request arrives here at the same moment. Naively
// deleting the cache entry per request would hammer generate.php — an endpoint that
// is aggressively rate-limited and currently throttling this /24. So a request whose
// URL token is already older than the cached one just re-stamps with the cached
// token and makes no upstream call at all; only the first one through actually
// refetches. Net cost of an expiry event: one generate.php call.
async function refetchWithFreshToken(target, ua, signal) {
  let url;
  try {
    url = new URL(target);
  } catch {
    return null;
  }
  const urlToken = url.searchParams.get('token');
  if (!urlToken) return null; // nothing stamped, nothing to refresh
  const origin = url.origin;

  let token;
  const cached = hostTokenCache.get(origin);
  if (cached && cached.token !== urlToken) {
    token = cached.token; // somebody already refreshed this origin — reuse it
  } else {
    hostTokenCache.delete(origin);
    try {
      token = await getHostToken(origin, ua);
    } catch {
      return null; // cooling, or upstream refused — let the original status stand
    }
  }
  if (token === urlToken) return null; // same token back; a retry would be pointless

  url.searchParams.set('token', token);
  const next = url.href;
  let resp;
  try {
    resp = await fetchUpstream(next, ua, 1, signal); // one attempt, no amplification
  } catch {
    return null;
  }
  return { resp, target: next };
}

// Fetch a stream backend URL, retrying on 5xx / network error with a short backoff.
// Handles the per-request 502s the CDN throws at random. Returns the final Response
// (which may still be 5xx after all tries); throws only if every attempt errored.
async function fetchUpstream(target, ua, tries = HLS_TRIES, signal) {
  let resp = null;
  let lastErr = null;
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      resp = await fetch(target, {
        headers: { 'User-Agent': ua, Accept: '*/*', Referer: STREAM_REFERER, Origin: STREAM_BACKEND_ORIGIN },
        redirect: 'follow',
        signal,
      });
    } catch (err) {
      lastErr = err;
      resp = null;
    }
    if (resp && resp.status < 500) return resp; // success or non-retryable
    if (attempt < tries - 1) {
      if (resp) {
        try {
          await resp.body?.cancel();
        } catch {}
      }
      await sleep(150 * (attempt + 1));
    }
  }
  if (!resp) throw lastErr || new Error('upstream fetch failed');
  if (resp.status >= 500) {
    // Previously returned in silence: the only [hls] log site is in the CALLER's
    // catch, reachable only via the throw above, so a 5xx-after-retries produced
    // no log line at all. 1879 log lines contained zero [hls] entries.
    console.error(`[hls] upstream ${resp.status} after ${tries} tries ${new URL(target).pathname}`);
  }
  return resp; // 5xx after exhausting retries
}

// True if the resolved master actually serves (200) within the retry budget. Some
// freshly-minted stream tokens are born dead (consistent 502) — those need a fresh
// resolve, not just a fetch retry.
async function masterServes(target, ua) {
  try {
    const r = await fetchUpstream(target, ua, 2); // dead tokens 502 consistently; 2 is enough
    const ok = r.status === 200;
    try {
      await r.body?.cancel();
    } catch {}
    return ok;
  } catch {
    return false;
  }
}

// Per-resolve path tally. Counters are in-memory (reset on restart), but each
// resolve also emits a greppable `via=plain|browser` line to relay.log, so the
// long-run rate survives restarts:  grep -c 'via=plain' relay.log
let resolvedPlain = 0;
let resolvedBrowser = 0;
function recordResolve(via) {
  if (via === 'browser') resolvedBrowser++;
  else resolvedPlain++;
  const total = resolvedPlain + resolvedBrowser;
  const share = Math.round((100 * resolvedBrowser) / total);
  console.log(`[stats] via=${via} session: plain=${resolvedPlain} browser=${resolvedBrowser} browser_share=${share}%`);
}

// Plain fetch is the fast path. When any step of the embed-chain walk serves a
// Cloudflare Turnstile challenge (probabilistic per IP/reputation), fall back to a
// real headless browser that actually executes the challenge — see resolveMasterBrowser.
async function resolveMaster(embedUrl, referer, ua) {
  // Skip the (often-challenged) plain attempt when the operator knows this IP is
  // always Turnstile-gated. The browser path uses its own fingerprint-matched UA.
  if (process.env.RELAY_FORCE_BROWSER === '1') {
    const master = await resolveMasterBrowser(embedUrl, referer);
    recordResolve('browser');
    return master;
  }
  let lastErr;
  for (let i = 0; i < 3; i++) {
    try {
      const master = await resolveMasterOnce(embedUrl, referer, ua);
      recordResolve('plain');
      return master;
    } catch (e) {
      lastErr = e;
      const msg = String(e?.message || e);
      if (/Turnstile/i.test(msg)) {
        const master = await resolveMasterBrowser(embedUrl, referer);
        recordResolve('browser');
        return master;
      }
      // Only retry on genuine network errors. HTTP status errors (5xx, 429, etc.) from
      // any embed-chain host mean upstream is signaling overload/outage — retrying
      // hammers it harder and gets us rate-limited. Let those bubble up.
      if (/fetch failed|timeout|ECONNRESET|terminated/i.test(msg)) continue;
      throw e;
    }
  }
  throw lastErr;
}

async function resolveMasterOnce(embedUrl, referer, ua) {
  const embed = await fetchText(embedUrl, referer, ua);
  if (embed.status !== 200) throw new Error('embed status ' + embed.status);
  checkTurnstile(embed.text, 'embed');
  return walkFromEmbed(embed.text, embed.url || embedUrl, ua, (url, ref) => fetchText(url, ref, ua));
}

// --- headless-browser fallback: solve a Turnstile challenge on the embed chain --
// Any HTML step of the walk (embed, layer2, layer3) can in principle render a
// Cloudflare Turnstile widget in place of the expected page. A plain fetch can't
// run the challenge, so we drive a real Chromium; a residential IP + a clean
// browser fingerprint passes the non-interactive challenge in ~2s. Once past it,
// everything downstream (layer3, the data API, WASM decrypt, token, master) is
// identical to the plain-fetch path — see walkFromLayer2.

const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';

// Playwright-core doesn't download browsers; locate a cached Chromium build.
function resolveChromePath() {
  if (process.env.RELAY_CHROME_PATH) return process.env.RELAY_CHROME_PATH;
  const cache = path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright');
  let builds = [];
  try {
    builds = fs
      .readdirSync(cache)
      .filter((d) => /^chromium-\d+$/.test(d))
      .sort((a, b) => parseInt(b.slice(9), 10) - parseInt(a.slice(9), 10));
  } catch {}
  for (const b of builds) {
    for (const arch of ['chrome-mac-arm64', 'chrome-mac']) {
      const p = path.join(cache, b, arch, 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing');
      if (fs.existsSync(p)) return p;
    }
  }
  try {
    return chromium.executablePath();
  } catch {
    return undefined;
  }
}

// One long-lived browser + context (keeps any cf_clearance cookie warm so repeat
// resolves usually skip the challenge). Re-created automatically if it dies.
let ctxPromise = null;
async function getContext() {
  if (ctxPromise) return ctxPromise;
  ctxPromise = (async () => {
    const browser = await chromium.launch({
      headless: true,
      executablePath: resolveChromePath(),
      args: ['--disable-blink-features=AutomationControlled', '--disable-dev-shm-usage'],
    });
    browser.on('disconnected', () => {
      ctxPromise = null;
    });
    const ctx = await browser.newContext({
      userAgent: BROWSER_UA,
      locale: 'en-US',
      timezoneId: 'Europe/Dublin',
      viewport: { width: 1280, height: 800 },
    });
    await ctx.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });
    ctx._browser = browser;
    return ctx;
  })().catch((e) => {
    ctxPromise = null;
    throw e;
  });
  return ctxPromise;
}

// Serialize browser resolves: avoids parallel Turnstile solves racing on one IP.
let resolveChain = Promise.resolve();
function withBrowserLock(fn) {
  const run = resolveChain.then(fn, fn);
  resolveChain = run.then(
    () => {},
    () => {},
  );
  return run;
}

// Raw HTTP request through the browser context (shares any cf_clearance cookie
// from a Turnstile solve, runs no JS) — used for every step past the layer2 page.
async function ctxFetchText(ctx, url, referer) {
  const r = await ctx.request.get(url, { headers: { Referer: referer, 'User-Agent': BROWSER_UA }, timeout: 20000 });
  return { status: r.status(), text: await r.text(), url: r.url() };
}

async function resolveMasterBrowser(embedUrl, referer) {
  return withBrowserLock(async () => {
    const embed = await fetchText(embedUrl, referer);
    if (embed.status !== 200) throw new Error('embed status ' + embed.status);
    const embedFinalUrl = embed.url || embedUrl;
    const apiPath = extractPlayerIframeApi(embed.text);
    if (!apiPath) throw new Error('player_iframe data-api not found in embed');
    const apiUrl = apiPath.startsWith('http') ? apiPath : new URL(embedFinalUrl).origin + apiPath;

    const gate = await fetchText(apiUrl, embedFinalUrl);
    if (gate.status !== 200) throw new Error('vs_src status ' + gate.status);
    checkTurnstile(gate.text, 'vs_src');
    let gateJson;
    try {
      gateJson = JSON.parse(gate.text);
    } catch {
      throw new Error('vs_src response not valid json');
    }
    const layer2Url = gateJson?.src;
    if (!layer2Url) throw new Error('vs_src.src not found');

    const ctx = await getContext();
    const page = await ctx.newPage();
    let layer2Text;
    let layer2FinalUrl = layer2Url;
    try {
      await page.goto(layer2Url, { referer: embedFinalUrl, waitUntil: 'domcontentloaded', timeout: 30000 });
      // The challenge solves, then the page's own JS renders/keeps window.CFG.
      try {
        await page.waitForFunction(() => /window\.CFG\s*=/.test(document.documentElement.outerHTML), {
          timeout: 45000,
          polling: 500,
        });
      } catch {
        throw new Error('blocked by Turnstile challenge (browser solve timed out)');
      }
      // Read raw server HTML (not the live DOM) — same rationale as before: the
      // player's own JS can mutate/strip the inline config before we get to read it.
      const layer2Res = await ctx.request.get(layer2Url, { headers: { Referer: embedFinalUrl, 'User-Agent': BROWSER_UA } });
      layer2Text = await layer2Res.text();
      layer2FinalUrl = layer2Res.url() || layer2Url;
    } finally {
      await page.close().catch(() => {});
    }

    return walkFromLayer2(layer2Text, layer2FinalUrl, BROWSER_UA, (url, ref) => ctxFetchText(ctx, url, ref));
  });
}

// --- playlist rewriting: point child URLs back at this relay's /hls -------------
const TAGS_WITH_URI = /(#EXT-X-(?:KEY|MAP|MEDIA|I-FRAME-STREAM-INF)[^\n]*?URI=")([^"]+)(")/gi;

function rewritePlaylist(body, playlistUrl, token, uaIdx) {
  const base = new URL(playlistUrl);
  const uaSuffix = uaIdx === null || uaIdx === undefined ? '' : '&ua=' + uaIdx;
  // Relative URLs resolve against the playlist's URL (served from this relay),
  // so children stay on the relay regardless of public hostname.
  const proxied = (raw) => {
    let abs;
    try {
      abs = new URL(raw, base).href;
    } catch {
      return raw;
    }
    return '/hls?u=' + b64urlEncode(abs) + '&t=' + token + uaSuffix;
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

// --- resolve cache + in-flight de-dupe + per-front circuit breaker ------------
const resolveCache = new Map(); // key -> { upstream, server, expiresAt }
const inflightResolves = new Map(); // key -> Promise<{ upstream, server }>
const frontCooldownUntil = { 1: 0, 2: 0 };
let lastProbeAt = 0; // half-open probe throttle, see performResolve
let cacheHits = 0;
let dedupeHits = 0;

function cacheKey(type, id, s, e, srv) {
  return [type, id, s || '', e || '', srv || ''].join('|');
}
function cacheGet(key) {
  const v = resolveCache.get(key);
  if (!v) return null;
  if (Date.now() > v.expiresAt) {
    resolveCache.delete(key);
    return null;
  }
  return v;
}
function cachePut(key, upstream, server) {
  if (resolveCache.size >= RESOLVE_CACHE_MAX) {
    const oldest = resolveCache.keys().next().value; // Map keeps insertion order
    if (oldest !== undefined) resolveCache.delete(oldest);
  }
  resolveCache.set(key, { upstream, server, expiresAt: Date.now() + RESOLVE_CACHE_TTL * 1000 });
}

function frontIsOpen(n) {
  return Date.now() < frontCooldownUntil[n];
}
function tripFront(n, reason) {
  const until = Date.now() + BREAKER_COOLDOWN * 1000;
  if (until > frontCooldownUntil[n]) {
    frontCooldownUntil[n] = until;
    console.error(`[breaker] srv=${n} tripped for ${BREAKER_COOLDOWN}s: ${reason}`);
  }
}

// The actual walk, breaker-aware. Returns { upstream, server } or throws. Wrapped by
// handleResolve in the inflight map so concurrent identical /resolve calls share one walk.
async function performResolve({ id, pathSuffix, order, ua }) {
  let master = null;
  let server = null;
  let lastErr = null;
  let fallbackMaster = null;
  let fallbackServer = null;
  let anyFrontTried = false;
  // Half-open. Without this the breaker has no way back in under BREAKER_COOLDOWN: once
  // both fronts are cooling, every request is refused outright for the full 90s even if
  // upstream recovered in the first second, and recovery is only noticed when the timer
  // happens to lapse. Let one request through every PROBE seconds to find out. Rate
  // limited globally, so this cannot become the amplification the breaker exists to stop.
  const allCooling = order.every((n) => frontIsOpen(n));
  const probing = allCooling && Date.now() - lastProbeAt > BREAKER_PROBE * 1000;
  if (probing) {
    lastProbeAt = Date.now();
    console.error('[breaker] half-open probe — all fronts cooling, letting one request through');
  }
  for (const n of order) {
    if (frontIsOpen(n) && !probing) {
      const left = Math.ceil((frontCooldownUntil[n] - Date.now()) / 1000);
      console.error(`[breaker] srv=${n} skipped — ${left}s cooldown left`);
      continue;
    }
    anyFrontTried = true;
    const front = FRONTS[n];
    for (let t = 0; t < RESOLVE_TRIES; t++) {
      let m;
      try {
        m = await resolveMaster(front.origin + pathSuffix, front.origin + '/', ua);
      } catch (err) {
        lastErr = err;
        const msg = String(err?.message || err);
        console.error('[resolve]', id, 'srv=' + n, msg);
        // Trip on HTTP-status responses from any step (rate-limit / origin down). 404 is
        // title-not-available — doesn't reflect IP throttling, so don't trip on it.
        // `generate` is deliberately NOT in this list: the playback token is fetched from
        // the STREAM ORIGIN, which varies per title, while this breaker is per FRONT
        // (vidsrc / vsembed). Tripping the front for it took every other title down for
        // 90s because one host said no — 27 of the 30 trips in the log were exactly that.
        // Token failures are now cooled per origin in getHostToken, which also escalates
        // to a global backoff when several distinct origins refuse at once.
        const m2 = msg.match(/(?:embed|vs_src|layer2|layer3|api|wasm)\s+status(?:_code)?\s+(\d+)/i);
        if (m2 && m2[1] !== '404') tripFront(n, msg);
        if (/fetch failed|timeout|ECONNRESET|terminated/i.test(msg)) continue;
        break;
      }
      if (fallbackMaster === null) {
        fallbackMaster = m;
        fallbackServer = n;
      }
      if (await masterServes(m, ua)) {
        master = m;
        server = n;
        // A front that just served is not in trouble. Closing the breaker here is what
        // makes the probe above worth anything — otherwise recovery still waits out the
        // remaining cooldown even though we have proof upstream is answering.
        if (frontCooldownUntil[n] > Date.now()) {
          frontCooldownUntil[n] = 0;
          console.error(`[breaker] srv=${n} closed early — probe succeeded`);
        }
        break;
      }
      console.error('[resolve]', id, 'srv=' + n, `master born dead, re-resolving (${t + 1}/${RESOLVE_TRIES})`);
    }
    if (master !== null) break;
  }

  if (master === null && fallbackMaster !== null) {
    master = fallbackMaster;
    server = fallbackServer;
  }
  if (master === null) {
    if (!anyFrontTried) {
      const earliest = Math.min(...order.map((n) => frontCooldownUntil[n]));
      const retryAfter = Math.max(1, Math.ceil((earliest - Date.now()) / 1000));
      const err = new Error(`all fronts in cooldown (${retryAfter}s)`);
      err.retryAfter = retryAfter;
      throw err;
    }
    throw lastErr || new Error('resolve failed');
  }
  return { upstream: master, server };
}

function respondWithMaster(res, upstream, server) {
  const uaIdx = nextUaIndex();
  const token = mintToken();
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json');
  res.end(
    JSON.stringify({
      master: PUBLIC_URL + '/hls?u=' + b64urlEncode(upstream) + '&t=' + token + '&ua=' + uaIdx,
      upstream,
      server,
    }),
  );
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

  // Embed PATH is identical across fronts; only the host differs.
  let pathSuffix = '/embed/' + type + '/' + id;
  if (type === 'tv' && s && e) pathSuffix += '/' + s + '-' + e;

  // srv: '1' or '2' pins a single front; absent/other tries front 1 then front 2.
  const srv = url.searchParams.get('srv');
  const order = srv === '2' ? [2] : srv === '1' ? [1] : [1, 2];

  const key = cacheKey(type, id, s, e, srv);

  // Cache hit — no upstream traffic. Mint a fresh token + UA so each player session
  // is still internally consistent (one UA across its segment fetches).
  const cached = cacheGet(key);
  if (cached) {
    cacheHits++;
    console.log(`[cache] HIT ${key} -> srv=${cached.server}  (total hits=${cacheHits})`);
    return respondWithMaster(res, cached.upstream, cached.server);
  }

  // De-dupe concurrent identical requests — only one walk runs at a time, the rest
  // wait on its promise. Caps the thundering-herd footprint to one walk per key.
  let resolvePromise = inflightResolves.get(key);
  if (resolvePromise) {
    dedupeHits++;
    console.log(`[dedupe] WAIT ${key}  (total=${dedupeHits})`);
  } else {
    const ua = UAS[nextUaIndex()];
    resolvePromise = performResolve({ id, pathSuffix, order, ua })
      .then((result) => {
        cachePut(key, result.upstream, result.server);
        return result;
      })
      .finally(() => {
        inflightResolves.delete(key);
      });
    inflightResolves.set(key, resolvePromise);
  }

  let result;
  try {
    result = await resolvePromise;
  } catch (err) {
    if (err && err.retryAfter) {
      res.statusCode = 503;
      res.setHeader('Retry-After', String(err.retryAfter));
    } else {
      res.statusCode = 502;
    }
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ error: String(err?.message || err) }));
  }
  return respondWithMaster(res, result.upstream, result.server);
}

// Gives the failure rate a denominator. Nothing counted segments before, so the
// single most user-visible failure mode had no measurement at all.
let segOk = 0;
let segBad = 0;
setInterval(() => {
  if (segOk + segBad === 0) return;
  const pct = ((100 * segBad) / (segOk + segBad)).toFixed(2);
  console.log(`[segstats] ok=${segOk} bad=${segBad} bad_rate=${pct}%`);
}, 60000).unref();

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

  // Use the per-movie UA carried from /resolve (if valid), else fall back. carryUa
  // is the validated index re-appended to child URLs so the whole movie stays on one UA.
  const uaIdx = parseInt(url.searchParams.get('ua'), 10);
  const carryUa = Number.isInteger(uaIdx) && uaIdx >= 0 && uaIdx < UAS.length ? uaIdx : null;
  const reqUa = carryUa === null ? UA : UAS[carryUa];

  // Aborts the upstream fetch if the browser gives up mid-download (seek, tab
  // close, quality switch) instead of pulling the whole segment for nothing.
  const abort = new AbortController();
  res.on('close', () => abort.abort());

  // Retry per-request 502s so a flaky master or segment doesn't kill playback.
  let upstream;
  try {
    upstream = await fetchUpstream(target, reqUa, HLS_TRIES, abort.signal);
  } catch (err) {
    if (abort.signal.aborted) return;
    console.error('[hls] upstream fail', String(err?.message || err));
    res.statusCode = 502;
    return res.end('upstream fetch failed');
  }

  // An expired upstream token shows up here as 403/401 on everything. Try exactly
  // one refreshed fetch before giving up; see refetchWithFreshToken.
  if ((upstream.status === 401 || upstream.status === 403) && !abort.signal.aborted) {
    const fresh = await refetchWithFreshToken(target, reqUa, abort.signal);
    if (fresh) {
      try {
        await upstream.body?.cancel();
      } catch {}
      console.error(`[hls] token refresh after ${upstream.status} -> ${fresh.resp.status} ${new URL(target).origin}`);
      upstream = fresh.resp;
      target = fresh.target;
    }
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
    return res.end(rewritePlaylist(text, target, token, carryUa));
  }

  // Segment: MPEG-TS, often mislabeled text/html (page-N.html). Immutable -> long cache.
  // Stream straight through instead of buffering the whole ~1-2MB body first —
  // the browser starts receiving bytes as they arrive rather than waiting for
  // the full segment to land here, which is what was actually slowing down
  // buffer-ahead/preloading.
  const looksTs = /\.(ts|html?)($|\?)/i.test(targetPath);

  // An upstream error is NOT a segment. Until now the status was copied through and
  // then stamped with `Content-Type: video/mp2t` and `Cache-Control: immutable`
  // unconditionally — so a 403/404/5xx HTML error body was handed to the browser as
  // a year-immutable MPEG-TS fragment. An explicit max-age makes an error response
  // storable (RFC 9111 s3), and Chrome and Safari both store a 404 that carries one.
  // That turns any transient upstream blip into a PERMANENTLY broken segment at one
  // fixed timecode: it survives reloads, it works offline, every hls.js retry is
  // served the same poisoned body from cache, and it looks nothing like a network
  // problem. `looksTs` is computed from the URL path alone and every segment is
  // named page-N.html, so the mislabelling was guaranteed rather than incidental.
  //
  // Collapse every failure into one uncacheable 502: hls.js retries a 5xx, and no
  // browser stores a no-store response. Rewriting rather than forwarding matters —
  // 404 is the status both engines that matter here will happily keep.
  if (upstream.status !== 200) {
    segBad++;
    console.error(`[hls] segment upstream=${upstream.status} path=${targetPath}`);
    try {
      await upstream.body?.cancel();
    } catch {}
    res.statusCode = 502;
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Cache-Control', 'no-store');
    return res.end(`upstream ${upstream.status}`);
  }

  segOk++;
  res.statusCode = 200;
  res.setHeader('Content-Type', looksTs ? 'video/mp2t' : ct || 'application/octet-stream');
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  // Deliberately NOT forwarding upstream's Content-Length: fetch() transparently
  // decodes Content-Encoding (gzip/br), but the header still reports the
  // pre-decode wire length — forwarding it would understate the decoded byte
  // count we actually stream, corrupting HTTP framing on this keep-alive
  // connection. Omitting it lets Node fall back to chunked transfer-encoding,
  // which is correct regardless of whether upstream compressed the response.

  if (!upstream.body) return res.end();
  try {
    await pipeline(Readable.fromWeb(upstream.body), res);
  } catch (err) {
    if (!abort.signal.aborted) console.error('[hls] stream fail', String(err?.message || err));
  }
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
    if (url.pathname === '/tidal/token') return await handleTidalToken(req, res, SECRET);
    res.statusCode = 404;
    res.end('not found');
  } catch (err) {
    // A client disconnecting mid-request (seek, tab close) aborts the in-flight
    // fetch via the AbortSignal wired up in handleHls — expected and benign, not
    // a real server error. res is already closed at this point, nothing to send.
    if (err?.name === 'AbortError') return;
    console.error('[relay] unhandled', String(err?.stack || err));
    if (!res.headersSent) res.statusCode = 500;
    res.end('error');
  }
});

// Node defaults keepAliveTimeout to 5s; cloudflared keeps idle origin connections
// in its pool for ~90s and will reuse one. During steady playback the player sits
// idle for seconds at a time on a full buffer, so that 5s window is crossed
// constantly and cloudflared can send a request down a socket this process is
// closing. Go's transport retries an idempotent GET in that race, which is why it
// has been survivable rather than obvious — but it costs a round trip every time.
// headersTimeout must exceed keepAliveTimeout or Node cuts connections itself.
server.keepAliveTimeout = 120_000;
server.headersTimeout = 125_000;

server.listen(PORT, () => {
  console.log(`fiesta relay listening on :${PORT}`);
  console.log(`  public url : ${PUBLIC_URL || '(RELAY_PUBLIC_URL unset — /resolve will 500)'}`);
  console.log(`  token ttl  : ${TOKEN_TTL}s`);
  console.log(`  cors       : ${ALLOW_ORIGIN.length ? ALLOW_ORIGIN.join(', ') : 'reflect any origin'}`);
});

// Close the headless browser on shutdown (launchd sends SIGTERM on unload).
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    const ctx = await ctxPromise;
    if (ctx?._browser) await ctx._browser.close();
  } catch {}
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
