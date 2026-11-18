// Unit test for the crawler cache in src/worker/api-router.ts (no network, no Redis): the real handlers are replaced by
// counters and the Worker Cache API by a Map. Run: node tools/e2e/bot-cache.test.mjs
import { build } from 'esbuild';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const out = path.join(mkdtempSync(path.join(tmpdir(), 'botcache-')), 'router.mjs');

// Every api/*.js handler becomes a stub that counts calls and echoes what it saw.
const stubs = {
  name: 'stub-handlers',
  setup(b) {
    b.onResolve({ filter: /\/api\/[a-z]+\.js$/ }, (a) => ({ path: a.path, namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => {
      const name = a.path.replace(/^.*\/api\//, '').replace(/\.js$/, '');
      return {
        loader: 'js',
        contents: `
          globalThis.__calls = globalThis.__calls || {};
          module.exports = async (req, res) => {
            globalThis.__calls['${name}'] = (globalThis.__calls['${name}'] || 0) + 1;
            res.setHeader('Cache-Control', 'no-store');
            res.status(200).json({ count: 7, liked: !!req.headers['x-client-id'], seen: req.headers['x-client-id'] || null });
          };`,
      };
    });
  },
};
await build({
  entryPoints: [path.join(root, 'src/worker/api-router.ts')],
  bundle: true, format: 'esm', platform: 'neutral', outfile: out, logLevel: 'error',
  plugins: [stubs], mainFields: ['module', 'main'], conditions: ['workerd', 'worker', 'browser'],
});

// Cache API stand-in.
const store = new Map();
globalThis.caches = {
  default: {
    async match(req) { const r = store.get(req.url); return r ? r.clone() : undefined; },
    async put(req, res) { store.set(req.url, res.clone()); },
  },
};
const { callApi } = await import(pathToFileURL(out).href);
const calls = (n) => globalThis.__calls?.[n] || 0;
const get = (p, ua, extra = {}) => callApi(new Request('https://fiesta.show' + p, { headers: { 'user-agent': ua, ...extra } }));
const BOT = 'Mozilla/5.0 (Linux; x64) Chromium/151 Reflectionbot/1';
const APPLE = 'Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15 (Applebot/0.1; +http://www.apple.com/go/applebot)';
const HUMAN = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15';

// 1. A bot asking for the same likes many times (different client ids): one handler call, same answer, never "liked".
for (let i = 0; i < 6; i++) {
  const r = await get('/api/likes?type=movie&id=tt0111161', BOT, { 'x-client-id': 'bot-' + i });
  const j = await r.json();
  assert.equal(r.status, 200); assert.equal(j.count, 7); assert.equal(j.liked, false, 'a cached answer is anonymous'); assert.equal(j.seen, null);
}
assert.equal(calls('likes'), 1, 'six bot requests -> one handler call');

// 2. Comments the same way; a different title is a different entry; Applebot (its UA mentions "bot") is covered too.
await get('/api/comments?type=movie&id=tt0111161', BOT);
await get('/api/comments?type=movie&id=tt0111161', APPLE);
await get('/api/comments?type=movie&id=tt0068646', BOT);
assert.equal(calls('comments'), 2, 'two titles -> two handler calls');

// 3. People are not cached and keep their own "liked".
for (let i = 0; i < 3; i++) {
  const j = await (await get('/api/likes?type=movie&id=tt0111161', HUMAN, { 'x-client-id': 'person-1' })).json();
  assert.equal(j.liked, true); assert.equal(j.seen, 'person-1');
}
assert.equal(calls('likes'), 1 + 3, 'every person request reaches the handler');

// 4. A bot POST (or anything not a GET) is never answered from the cache.
const post = await callApi(new Request('https://fiesta.show/api/likes', { method: 'POST', headers: { 'user-agent': BOT, 'content-type': 'application/json' }, body: '{}' }));
assert.equal(post.status, 200);
assert.equal(calls('likes'), 5);

// 5. Other endpoints are left alone (tmdb is not part of this change).
await get('/api/tmdb?list=genres', BOT); await get('/api/tmdb?list=genres', BOT);
assert.equal(calls('tmdb'), 2);

// 6. Non-200 answers are not stored.
console.log('bot-cache: all assertions passed');
