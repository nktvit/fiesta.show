// Dev helper: store your TIDAL web-player token for full-length playback.
//
//   1. listen.tidal.com (logged in) -> DevTools -> Network -> play a song
//   2. click a request to api.tidal.com/v1/tracks/.../playbackinfo, copy the
//      value after `authorization: Bearer ` (Request Headers)
//   3. npm run tidal:token            (reads your clipboard)
//      npm run tidal:token -- <token> (or pass it / pipe it on stdin)
//
// It validates the token and writes TIDAL_DEV_ACCESS_TOKEN to .env.local
// (gitignored). The token lasts about 4 hours; the music API ignores it in
// production (DEPLOY_ENV=production). It never prints the token.

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const FILE = path.join(ROOT, '.env.local');

function readInput() {
  if (process.argv[2]) return process.argv[2];
  if (!process.stdin.isTTY) return fs.readFileSync(0, 'utf8');
  try { return execSync('pbpaste', { encoding: 'utf8' }); } catch { return ''; }
}

const token = readInput().trim().replace(/^authorization:\s*/i, '').replace(/^Bearer\s+/i, '').replace(/^["']|["']$/g, '');
const parts = token.split('.');
if (parts.length !== 3) {
  console.error('That is not a token (expected three dot-separated parts starting with eyJ).');
  console.error('Copy the value after "authorization: Bearer " from a REQUEST header of api.tidal.com.');
  process.exit(1);
}
let claims;
try { claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString()); } catch { claims = null; }
if (!claims || !claims.uid || !claims.exp) {
  console.error('This looks like an app/anonymous token, not a logged-in user token (no uid).');
  process.exit(1);
}
const left = claims.exp * 1000 - Date.now();
if (left <= 0) {
  console.error('That token has already expired. Copy a fresh one.');
  process.exit(1);
}

const line = `TIDAL_DEV_ACCESS_TOKEN=${token}`;
let env = fs.existsSync(FILE) ? fs.readFileSync(FILE, 'utf8') : '';
env = /^TIDAL_DEV_ACCESS_TOKEN=.*$/m.test(env)
  ? env.replace(/^TIDAL_DEV_ACCESS_TOKEN=.*$/m, line)
  : env.replace(/\n?$/, '\n') + line + '\n';
fs.writeFileSync(FILE, env);
console.log(`Saved TIDAL_DEV_ACCESS_TOKEN to .env.local (country ${claims.cc || '?'}, valid ${(left / 3600000).toFixed(1)} h).`);
console.log('Restart the local API server (node tools/fiesta-proxy/local-test-server.mjs) to pick it up.');
