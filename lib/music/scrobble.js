// Scrobbling: Last.fm signing proxy (needs LASTFM_API_KEY / LASTFM_API_SECRET).
// Owned by package P13. api/music.js dispatches `action=lastfm` here (GET or POST).
//
//   GET  ?action=lastfm                       -> {configured:true, apiKey} or 503 {error:'lastfm_not_configured'}
//   POST ?action=lastfm  {method, params}     -> signs with the secret (server side only) and forwards
//                                                to ws.audioscrobbler.com/2.0, returns Last.fm's JSON.
//   GET  ?action=lastfm&method=..&<params>    -> same for read-only methods (user.getRecentTracks ...)
//
// The secret never leaves the server. Only the methods listed in METHODS are forwarded.

const crypto = require('crypto');
const { httpError } = require('../tidal');

const ENDPOINT = 'https://ws.audioscrobbler.com/2.0/';
const METHODS = new Set([
  'auth.getToken', 'auth.getSession', 'auth.getMobileSession',
  'track.updateNowPlaying', 'track.scrobble', 'track.love', 'track.unlove',
  'user.getRecentTracks', 'user.getTopArtists',
]);
const PARAM_NAME = /^[A-Za-z0-9_.\[\]]{1,40}$/;
const MAX_PARAMS = 120;
const MAX_VALUE = 2000;
const MAX_BODY = 64 * 1024;

function keys() {
  const apiKey = process.env.LASTFM_API_KEY;
  const secret = process.env.LASTFM_API_SECRET;
  return apiKey && secret ? { apiKey, secret } : null;
}

/** Last.fm api_sig: params sorted by name, `name+value` joined, secret appended, md5 hex. */
function sign(params, secret) {
  const base = Object.keys(params)
    .filter((k) => k !== 'format' && k !== 'callback')
    .sort()
    .map((k) => k + params[k])
    .join('');
  return crypto.createHash('md5').update(base + secret, 'utf8').digest('hex');
}

function parseBody(s) {
  if (!s) return {};
  try { return JSON.parse(s); } catch { throw httpError(400, 'bad_body'); }
}

async function readBody(req) {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
    return parseBody(Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body));
  }
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw httpError(413, 'body_too_large');
    chunks.push(c);
  }
  return parseBody(Buffer.concat(chunks).toString('utf8'));
}

function cleanParams(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw httpError(400, 'bad_params');
  const names = Object.keys(raw);
  if (names.length > MAX_PARAMS) throw httpError(400, 'too_many_params');
  const out = {};
  for (const k of names) {
    if (!PARAM_NAME.test(k)) throw httpError(400, 'bad_param_name');
    // The server owns these; a caller cannot override them.
    if (k === 'api_key' || k === 'api_sig' || k === 'format' || k === 'callback' || k === 'method') continue;
    const v = raw[k];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') throw httpError(400, 'bad_param_value');
    const s = String(v);
    if (s.length > MAX_VALUE) throw httpError(400, 'param_too_long');
    out[k] = s;
  }
  return out;
}

async function lastfm(q, req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const creds = keys();
  if (!creds) throw httpError(503, 'lastfm_not_configured');

  let method = '';
  let params = {};
  if (req.method === 'POST') {
    const body = await readBody(req);
    method = typeof body.method === 'string' ? body.method : '';
    params = cleanParams(body.params || {});
  } else {
    method = typeof q.method === 'string' ? q.method : '';
    if (!method) return res.status(200).json({ configured: true, apiKey: creds.apiKey }); // the api key is public (it is in every auth URL)
    const rest = {};
    for (const k of Object.keys(q)) if (k !== 'action' && k !== 'method') rest[k] = q[k];
    params = cleanParams(rest);
  }
  if (!METHODS.has(method)) throw httpError(400, 'bad_method');
  // GET (cacheable, link-triggerable) may only reach read-only methods; writes need POST.
  if (req.method !== 'POST' && !method.startsWith('user.')) throw httpError(405, 'use_post');

  const signed = { ...params, method, api_key: creds.apiKey };
  const form = new URLSearchParams({ ...signed, api_sig: sign(signed, creds.secret), format: 'json' });

  let upstream;
  try {
    upstream = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'StreamFiesta/1.0' },
      body: form,
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    throw httpError(502, 'lastfm_unreachable');
  }
  let data;
  try { data = await upstream.json(); } catch { throw httpError(502, 'lastfm_bad_response'); }
  // Last.fm reports errors as {error: <number>, message}; pass them through untouched.
  return res.status(upstream.ok ? 200 : upstream.status).json(data);
}

module.exports = { lastfm, _sign: sign };
