#!/usr/bin/env node
// relayctl - keep the Mac mini relay in sync with this repo.
//
//   npm run relay:status            compare the mini with the repo; health check
//   npm run relay:pull              bring edits made ON the mini (e.g. by the autofix agent) into the repo
//   npm run relay:deploy            repo -> mini: backup, syntax-check, swap, restart, health-check, roll back on failure
//   npm run relay:deploy -- --dry-run | --force
//
// The repo is the source of truth. The mini also has an autofix agent
// (scripts/autofix-watchdog.sh, `claude -p`) that edits relay.mjs IN PLACE when the
// upstream video sources change - intentional, so we never block it. Instead every
// deploy records what it wrote (.relayctl.json on the mini). If the mini's file
// no longer matches that record, the mini has changed since: deploy refuses to
// overwrite it until you `relay:pull` the change into git (review it, commit it).
//
// Env: RELAY_SSH_HOST (default `mm`), RELAY_DIR, RELAY_NODE (node used for --check).
// Secrets never pass through here: .env.local, tidal-session.json and logs are not managed.

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOST = process.env.RELAY_SSH_HOST || 'mm';
const DIR = process.env.RELAY_DIR || '/Users/ms/Server/relay.fiesta.show';
const NODE = process.env.RELAY_NODE || '/Users/ms/.nvm/versions/node/v22.17.0/bin/node';
const LABEL = 'show.fiesta.relay';
const STATE = '.relayctl.json';

// Deployed by `deploy`. `restart`: the running relay must be restarted for it to take effect.
export const MANAGED = [
  { file: 'relay.mjs', restart: true, check: true },
  { file: 'tidal-session.mjs', restart: true, check: true },
  { file: 'scripts/autofix-watchdog.sh', restart: false, check: false, exec: true },
];
// Tracked and compared, never written by `deploy` (changing them needs npm install / launchctl reload).
export const REFERENCE = [
  { file: 'package.json' },
  { file: 'package-lock.json' },
  { file: 'launchd/show.fiesta.relay.plist', remotePath: '/Users/ms/Library/LaunchAgents/show.fiesta.relay.plist' },
  { file: 'launchd/show.fiesta.relay.autofix.plist', remotePath: '/Users/ms/Library/LaunchAgents/show.fiesta.relay.autofix.plist' },
];

/**
 * What a file's state means. `base` is the hash recorded at the last deploy/pull.
 *   in-sync        repo == mini
 *   repo-ahead     mini still equals what we last wrote; the repo moved on  -> deploy updates it
 *   mini-ahead     the repo still equals the last sync; the mini was edited -> pull it first
 *   diverged       both moved                                              -> resolve by hand
 *   unknown-base   never synced and they differ                            -> pull or --force
 *   missing        not on the mini yet                                     -> deploy creates it
 */
export function classify({ local, remote, base }) {
  if (remote == null) return 'missing';
  if (local === remote) return 'in-sync';
  if (!base) return 'unknown-base';
  if (remote === base) return 'repo-ahead';
  if (local === base) return 'mini-ahead';
  return 'diverged';
}

export const DEPLOYABLE = new Set(['in-sync', 'repo-ahead', 'missing']);

// Staged copy keeps its extension: `node --check` refuses a file called x.mjs.relayctl-new.
export const staged = (f) => f.replace(/(\.[^./]+)$/, '.relayctl-new$1');

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const localPath = (f) => path.join(HERE, f);
// (`remote` on a surveyed row is the remote file's hash, so the path field is `remotePath`.)
const remotePath = (e) => e.remotePath || `${DIR}/${e.file}`;

function ssh(script) {
  return execFileSync('ssh', ['-o', 'ConnectTimeout=10', '-o', 'BatchMode=yes', HOST, 'bash -s'], {
    input: script,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}
const scpTo = (from, to) => execFileSync('scp', ['-q', from, `${HOST}:${to}`]);
const scpFrom = (from, to) => execFileSync('scp', ['-q', `${HOST}:${from}`, to]);

function remoteHashes() {
  const all = [...MANAGED, ...REFERENCE];
  const lines = all.map((e) => `h=$(shasum -a 256 '${remotePath(e)}' 2>/dev/null | cut -d' ' -f1); echo "H ${e.file} \${h:--}"`);
  const out = ssh([`cd '${DIR}'`, ...lines, `echo "STATE_BEGIN"; cat '${STATE}' 2>/dev/null; echo; echo "STATE_END"`].join('\n'));
  const hashes = {};
  for (const l of out.split('\n')) {
    const m = l.match(/^H (\S+) (\S+)$/);
    if (m) hashes[m[1]] = m[2] === '-' ? null : m[2];
  }
  const state = out.split('STATE_BEGIN')[1]?.split('STATE_END')[0]?.trim();
  let base = {};
  try { base = JSON.parse(state).files || {}; } catch { /* first run */ }
  return { hashes, base };
}

function localHash(e) {
  try { return sha(fs.readFileSync(localPath(e.file))); } catch { return null; }
}

function survey() {
  const { hashes, base } = remoteHashes();
  return [...MANAGED.map((e) => ({ ...e, kind: 'managed' })), ...REFERENCE.map((e) => ({ ...e, kind: 'reference' }))].map((e) => {
    const local = localHash(e);
    const remote = hashes[e.file] ?? null;
    return { ...e, local, remote, base: base[e.file] || null, state: classify({ local, remote, base: base[e.file] || null }) };
  });
}

function writeState(files) {
  const { hashes } = remoteHashes();
  const record = { at: new Date().toISOString(), files: Object.fromEntries(files.map((e) => [e.file, hashes[e.file]])) };
  ssh(`cat > '${DIR}/${STATE}.tmp' <<'JSON'\n${JSON.stringify(record)}\nJSON\nmv '${DIR}/${STATE}.tmp' '${DIR}/${STATE}'`);
}

function printTable(rows) {
  const pad = (s, n) => String(s).padEnd(n);
  for (const r of rows) {
    const note = {
      'in-sync': '', 'repo-ahead': 'repo is newer -> `relay:deploy` will update it', 'missing': 'not on the mini yet -> deploy creates it',
      'mini-ahead': 'MINI WAS EDITED since the last sync (autofix agent or by hand) -> `relay:pull`, review, commit',
      diverged: 'BOTH changed -> `relay:pull` into a branch and merge by hand',
      'unknown-base': 'never synced and they differ -> `relay:pull` (or `relay:deploy --force`)',
    }[r.state];
    console.log(`  ${pad(r.state, 13)} ${pad(r.kind, 9)} ${pad(r.file, 40)} ${note}`);
  }
}

function health() {
  const out = ssh([
    `cd '${DIR}'`,
    `P=$(sed -n 's/^RELAY_PORT=//p' .env.local | tr -d "\\"'"); P=\${P:-8787}`,
    `echo "pid $(pgrep -f '${DIR}/relay.mjs' | head -1)"`,
    `echo "healthz $(curl -s -m 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:$P/healthz)"`,
    // No Authorization header: a relay with the music route answers 401, an old one 404.
    `echo "tidal_route $(curl -s -m 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:$P/tidal/token)"`,
  ].join('\n'));
  const get = (k) => (out.match(new RegExp(`^${k} (\\S*)`, 'm')) || [])[1] || '';
  return { pid: get('pid'), healthz: get('healthz'), tidalRoute: get('tidal_route') };
}

function cmdStatus() {
  const rows = survey();
  console.log(`relay @ ${HOST}:${DIR}\n`);
  printTable(rows);
  const h = health();
  console.log(`\n  service: pid ${h.pid || '?'} | /healthz ${h.healthz} | /tidal/token route ${h.tidalRoute === '404' ? '404 (MISSING - music falls back to previews)' : h.tidalRoute}`);
  if (rows.some((r) => r.state === 'mini-ahead' || r.state === 'diverged')) {
    const log = ssh(`grep -E '^(=====|TRIGGER|Result)' '${DIR}/.autofix/autofix.log' 2>/dev/null | tail -4`).trim();
    if (log) console.log(`\n  recent autofix activity:\n    ${log.split('\n').join('\n    ')}`);
  }
  const drift = rows.filter((r) => r.kind === 'managed' && r.state !== 'in-sync');
  console.log(drift.length ? `\n${drift.length} managed file(s) not in sync.` : '\nAll managed files in sync.');
  process.exit(drift.length || h.healthz !== '200' ? 1 : 0);
}

function cmdPull() {
  const rows = survey();
  const changed = rows.filter((r) => r.remote && r.remote !== r.local);
  if (!changed.length) { console.log('Nothing to pull: the repo already matches the mini.'); writeState(rows.filter((r) => r.kind === 'managed' || r.remote)); return; }
  for (const r of changed) {
    fs.mkdirSync(path.dirname(localPath(r.file)), { recursive: true });
    scpFrom(remotePath(r), localPath(r.file));
    console.log(`  pulled ${r.file}  (${r.state})`);
  }
  writeState(rows.filter((r) => r.remote));
  console.log('\nReview with `git diff`, then commit. The mini is now recorded as in sync with these files.');
}

function cmdDeploy(args) {
  const dry = args.includes('--dry-run');
  const force = args.includes('--force');
  const rows = survey();
  const managed = rows.filter((r) => r.kind === 'managed');
  const blocked = managed.filter((r) => !DEPLOYABLE.has(r.state));
  console.log(`relay @ ${HOST}:${DIR}\n`);
  printTable(managed);
  if (blocked.length && !force) {
    console.error(`\nRefusing to deploy: ${blocked.map((r) => r.file).join(', ')} changed on the mini since the last sync.`);
    console.error('Run `npm run relay:pull`, review and commit the change, then deploy. (--force overwrites the mini and keeps a backup.)');
    process.exit(3);
  }
  const todo = managed.filter((r) => r.state !== 'in-sync' || (force && r.local !== r.remote));
  if (!todo.length) { console.log('\nNothing to deploy.'); return; }
  const restart = todo.some((r) => r.restart);
  if (dry) { console.log(`\nDry run: would deploy ${todo.map((r) => r.file).join(', ')}${restart ? ' and restart the relay' : ''}.`); return; }

  const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  // 1. Stage + syntax-check everything before touching a live file.
  for (const r of todo) {
    scpTo(localPath(r.file), `${DIR}/${staged(r.file)}`);
    if (r.check) {
      try { ssh(`'${NODE}' --check '${DIR}/${staged(r.file)}'`); } catch (e) {
        ssh(todo.map((t) => `rm -f '${DIR}/${staged(t.file)}'`).join('\n'));
        console.error(`\nAborted: ${r.file} failed the syntax check on the mini. Nothing was changed.\n${String(e.stderr || e.message).split('\n').slice(0, 6).join('\n')}`);
        process.exit(2);
      }
    }
  }
  // 2. Back up and swap (atomic renames).
  ssh(todo.map((r) => [
    `[ -f '${DIR}/${r.file}' ] && cp -p '${DIR}/${r.file}' '${DIR}/${r.file}.bak-${ts}'`,
    r.exec ? `chmod +x '${DIR}/${staged(r.file)}'` : ':',
    `mv '${DIR}/${staged(r.file)}' '${DIR}/${r.file}'`,
  ].join('; ')).join('\n'));
  console.log(`\nSwapped in: ${todo.map((r) => r.file).join(', ')} (backups: *.bak-${ts})`);

  // 3. Restart + verify, roll back on failure.
  if (restart) {
    ssh(`launchctl kickstart -k gui/$(id -u)/${LABEL}`);
    let h = { healthz: '', tidalRoute: '' };
    for (let i = 0; i < 10 && h.healthz !== '200'; i++) {
      execFileSync('sleep', ['2']);
      try { h = health(); } catch { /* still starting */ }
    }
    const ok = h.healthz === '200' && h.tidalRoute !== '404';
    if (!ok) {
      console.error(`\nHealth check FAILED (healthz ${h.healthz}, /tidal/token ${h.tidalRoute}). Rolling back...`);
      ssh(todo.map((r) => `[ -f '${DIR}/${r.file}.bak-${ts}' ] && mv '${DIR}/${r.file}.bak-${ts}' '${DIR}/${r.file}'`).join('\n') + `\nlaunchctl kickstart -k gui/$(id -u)/${LABEL}`);
      console.error('Restored the previous files and restarted. Investigate, then redeploy.');
      process.exit(2);
    }
    console.log(`Relay restarted and healthy (pid ${h.pid}, /healthz ${h.healthz}, /tidal/token ${h.tidalRoute}).`);
  }
  // 4. Record what we wrote; keep the 10 newest backups per file.
  writeState(managed);
  ssh(todo.map((r) => `ls -t '${DIR}/${r.file}'.bak-* 2>/dev/null | tail -n +11 | xargs rm -f`).join('\n'));
  console.log('Recorded as deployed. Done.');
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const [cmd, ...args] = process.argv.slice(2);
  const run = { status: cmdStatus, pull: cmdPull, deploy: () => cmdDeploy(args) }[cmd];
  if (!run) { console.error('usage: relayctl.mjs status | pull | deploy [--dry-run] [--force]'); process.exit(64); }
  try { run(); } catch (e) { console.error(`relayctl: ${String(e.stderr || e.message || e).trim().split('\n')[0]}`); process.exit(2); }
}
