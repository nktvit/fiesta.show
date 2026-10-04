// One-time setup: hand the Mac mini relay your TIDAL web session so full-length
// music playback renews itself (no more pasting tokens).
//
// TIDAL's web player keeps its refresh token ENCRYPTED in local storage, so it
// has to be caught in flight. Two ways (DevTools -> Network, tick "Preserve log",
// filter "token"):
//
//   A. Wait for the player's own refresh (it fires ~1 min before the access
//      token expires, tab open): right-click the POST to .../oauth2/token with
//      `grant_type=refresh_token` -> Copy -> Copy as cURL, then:
//        npm run tidal:relay-setup
//
//   B. Right now: log out of listen.tidal.com and log back in. Find the POST to
//      .../oauth2/token with `grant_type=authorization_code`.
//        - Payload tab: note the `client_id` value
//        - Response tab: right-click -> Copy the JSON (it has `refresh_token`)
//        npm run tidal:relay-setup -- --client-id=<the client_id>
//
// Either way the script reads your clipboard, pulls client_id and refresh_token
// out of what you copied (form data or JSON), writes them to
// the relay box over SSH (host alias `mm`, mode 0600) and asks the relay for a
// token to prove it works. Nothing secret is printed. It does NOT test the
// token from this Mac: if TIDAL rotates refresh tokens, a test here would
// spend the one it just sent.

import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';

const HOST = process.env.RELAY_SSH_HOST || 'mm';
const DIR = process.env.RELAY_DIR || '/Users/ms/Server/relay.fiesta.show';

const text = process.stdin.isTTY ? execSync('pbpaste', { encoding: 'utf8' }) : fs.readFileSync(0, 'utf8');
// Form data (`name=value`, as in a copied cURL) or JSON (`"name":"value"`).
const pick = (...names) => {
  for (const name of names) {
    const form = text.match(new RegExp(`${name}=([^&'"\\s\\\\]+)`));
    if (form) return decodeURIComponent(form[1]);
    // JSON (`"name": "value"`) or the way DevTools shows a response tree
    // (`name`, newline, `:`, newline, `"value"`).
    const json = text.match(new RegExp(`\\b${name}"?\\s*:\\s*"([^"]+)"`));
    if (json) return json[1];
  }
  return '';
};
const cliClientId = (process.argv.find((a) => a.startsWith('--client-id=')) || '').slice(12);
const client_id = cliClientId || pick('client_id', 'clientId');
const refresh_token = pick('refresh_token', 'refreshToken');

if (!client_id || !refresh_token) {
  console.error('Could not find client_id and refresh_token in your clipboard.');
  console.error('Copy the oauth2/token POST ("Copy as cURL"), or its JSON response plus --client-id=<id>. See the top of this file.');
  console.error(`Found: client_id ${client_id ? 'yes' : 'NO'}, refresh_token ${refresh_token ? 'yes' : 'NO'}.`);
  process.exit(1);
}

// Which host issued this refresh token (if the copied request shows it).
const urlMatch = text.match(/https:\/\/(?:auth|login)\.tidal\.com\/[^\s'"]*token/);
const token_url = (process.argv.find((a) => a.startsWith('--token-url=')) || '').slice(12) || (urlMatch ? urlMatch[0] : undefined);
const payload = JSON.stringify({ client_id, refresh_token, ...(token_url ? { token_url } : {}) });
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
