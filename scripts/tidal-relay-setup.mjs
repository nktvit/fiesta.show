// One-time setup: hand the Mac mini relay your TIDAL web session so full-length
// music playback renews itself (no more pasting tokens).
//
//   1. listen.tidal.com (logged in) -> DevTools -> Network -> filter "token"
//   2. Reload the page. Find the POST to auth.tidal.com/v1/oauth2/token whose
//      payload has `grant_type=refresh_token`.
//   3. Right-click it -> Copy -> Copy as cURL
//   4. npm run tidal:relay-setup           (reads your clipboard)
//
// It pulls client_id and refresh_token out of what you copied, writes them to
// the relay box over SSH (host alias `mm`, mode 0600) and asks the relay for a
// token to prove it works. Nothing secret is printed. It does NOT test the
// token from this Mac: if TIDAL rotates refresh tokens, a test here would
// spend the one it just sent.

import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';

const HOST = process.env.RELAY_SSH_HOST || 'mm';
const DIR = process.env.RELAY_DIR || '/Users/ms/Server/relay.fiesta.show';

const text = process.stdin.isTTY ? execSync('pbpaste', { encoding: 'utf8' }) : fs.readFileSync(0, 'utf8');
const pick = (name) => {
  const m = text.match(new RegExp(`${name}=([^&'"\\s\\\\]+)`));
  return m ? decodeURIComponent(m[1]) : '';
};
const client_id = pick('client_id');
const refresh_token = pick('refresh_token');

if (!client_id || !refresh_token) {
  console.error('Could not find client_id and refresh_token in your clipboard.');
  console.error('Copy the POST to auth.tidal.com/v1/oauth2/token that has grant_type=refresh_token ("Copy as cURL").');
  console.error(`Found: client_id ${client_id ? 'yes' : 'NO'}, refresh_token ${refresh_token ? 'yes' : 'NO'}.`);
  process.exit(1);
}

const payload = JSON.stringify({ client_id, refresh_token });
execFileSync('ssh', [HOST, `umask 077 && cat > ${DIR}/tidal-session.json`], { input: payload, stdio: ['pipe', 'inherit', 'inherit'] });
console.log(`Stored the session on ${HOST} (client_id ${client_id.length} chars, refresh_token ${refresh_token.length} chars).`);

// Ask the relay (on the box itself) for a token.
const probe = `cd ${DIR} && S=$(sed -n 's/^RELAY_SECRET=//p' .env.local | tr -d "\\"'") && P=$(sed -n 's/^RELAY_PORT=//p' .env.local | tr -d "\\"'") && curl -s -m 25 -H "Authorization: Bearer $S" http://127.0.0.1:\${P:-8787}/tidal/token`;
let out = '';
try { out = execFileSync('ssh', [HOST, probe], { encoding: 'utf8' }); } catch { /* handled below */ }
try {
  const j = JSON.parse(out);
  if (!j.access_token) throw new Error(j.error || 'no token');
  console.log(`OK: the relay got a TIDAL access token (country ${j.country || '?'}, valid ${Math.round((j.expires_at - Date.now()) / 60000)} min). It renews itself from now on.`);
} catch (e) {
  console.error(`The relay could not get a token (${(out || '').slice(0, 80) || e.message}).`);
  console.error('If the relay has not been updated yet, that is expected; otherwise re-copy a fresh request and rerun.');
  process.exit(2);
}
