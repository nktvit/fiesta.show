// TIDAL session keeper for the relay (GET /tidal/token).
//
// Holds the owner's TIDAL web-session refresh token on this box and hands out a
// fresh access token to Vercel's api/music.js, so nobody pastes a token by hand.
// Vercel only asks for it when the request carries the owner's unlock key, so
// the public site never streams from this subscription.
//
//   GET /tidal/token   Authorization: Bearer <RELAY_SECRET>
//     -> 200 { access_token, expires_at (ms), country }
//     -> 401 unauthorized | 503 not_configured | 502 refresh_failed
//
// State lives in ./tidal-session.json (mode 0600), written by
// scripts/tidal-relay-setup.mjs on the owner's Mac:
//   { client_id, refresh_token, access_token?, expires_at?, country? }
// The refresh token is rewritten whenever TIDAL rotates it.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(HERE, 'tidal-session.json');
const TOKEN_URL = 'https://auth.tidal.com/v1/oauth2/token';
// Refresh this long before the access token expires.
const SKEW_MS = 5 * 60 * 1000;

let refreshing = null; // one refresh in flight at a time

function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return null;
  }
}

function save(state) {
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
  fs.renameSync(tmp, FILE);
}

async function refresh(state) {
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: state.client_id,
      refresh_token: state.refresh_token,
      grant_type: 'refresh_token',
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) {
    console.error('[tidal-session] refresh failed', r.status, j.error || '', j.error_description || '');
    const e = new Error('refresh_failed');
    e.status = 502;
    throw e;
  }
  const next = {
    ...state,
    access_token: j.access_token,
    expires_at: Date.now() + (j.expires_in || 3600) * 1000,
    country: (j.user && j.user.countryCode) || state.country || '',
    // TIDAL may or may not rotate the refresh token; keep whichever is current.
    refresh_token: j.refresh_token || state.refresh_token,
  };
  save(next);
  return next;
}

async function currentSession() {
  const state = load();
  if (!state || !state.client_id || !state.refresh_token) {
    const e = new Error('not_configured');
    e.status = 503;
    throw e;
  }
  if (state.access_token && state.expires_at - Date.now() > SKEW_MS) return state;
  if (!refreshing) refreshing = refresh(state).finally(() => { refreshing = null; });
  return refreshing;
}

export async function handleTidalToken(req, res, secret) {
  const auth = req.headers.authorization || '';
  const got = Buffer.from(auth.startsWith('Bearer ') ? auth.slice(7) : '');
  const want = Buffer.from(secret || '');
  if (!want.length || got.length !== want.length || !timingSafeEqual(got, want)) {
    res.statusCode = 401;
    return res.end('unauthorized');
  }
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  try {
    const s = await currentSession();
    res.statusCode = 200;
    return res.end(JSON.stringify({ access_token: s.access_token, expires_at: s.expires_at, country: s.country || '' }));
  } catch (e) {
    res.statusCode = e.status || 502;
    return res.end(JSON.stringify({ error: e.message }));
  }
}
