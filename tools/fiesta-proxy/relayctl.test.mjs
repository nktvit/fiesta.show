// node --test tools/fiesta-proxy/relayctl.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { classify, DEPLOYABLE, MANAGED } from './relayctl.mjs';

const A = 'aaa', B = 'bbb', C = 'ccc';

test('identical files are in sync, whatever the record says', () => {
  assert.equal(classify({ local: A, remote: A, base: null }), 'in-sync');
  assert.equal(classify({ local: A, remote: A, base: B }), 'in-sync');
});

test('repo edited since the last deploy: safe to deploy', () => {
  assert.equal(classify({ local: B, remote: A, base: A }), 'repo-ahead');
});

test('mini edited since the last sync (the autofix agent): must pull first', () => {
  assert.equal(classify({ local: A, remote: B, base: A }), 'mini-ahead');
});

test('both changed: diverged', () => {
  assert.equal(classify({ local: B, remote: C, base: A }), 'diverged');
});

test('never synced and different: unknown base, not deployable', () => {
  assert.equal(classify({ local: A, remote: B, base: null }), 'unknown-base');
  assert.equal(DEPLOYABLE.has('unknown-base'), false);
});

test('missing on the mini is deployable', () => {
  assert.equal(classify({ local: A, remote: null, base: null }), 'missing');
  assert.equal(DEPLOYABLE.has('missing'), true);
});

test('only safe states are deployable', () => {
  for (const s of ['in-sync', 'repo-ahead', 'missing']) assert.ok(DEPLOYABLE.has(s), s);
  for (const s of ['mini-ahead', 'diverged', 'unknown-base']) assert.ok(!DEPLOYABLE.has(s), s);
});

test('the relay and its music module restart the service; the watchdog does not', () => {
  const by = Object.fromEntries(MANAGED.map((m) => [m.file, m]));
  assert.equal(by['relay.mjs'].restart, true);
  assert.equal(by['tidal-session.mjs'].restart, true);
  assert.equal(by['scripts/autofix-watchdog.sh'].restart, false);
});

test('staged copies keep their extension so `node --check` can parse them', async () => {
  const { staged } = await import('./relayctl.mjs');
  assert.equal(staged('relay.mjs'), 'relay.relayctl-new.mjs');
  assert.equal(staged('scripts/autofix-watchdog.sh'), 'scripts/autofix-watchdog.relayctl-new.sh');
  assert.ok(staged('tidal-session.mjs').endsWith('.mjs'));
});
