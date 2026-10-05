// E2E for package P13 (scrobbling): settings UI, ListenBrainz engine (api.listenbrainz.org mocked),
// offline queue, love-on-like, Last.fm signing backend.
//   node tools/e2e/music-p13.mjs [baseUrl=http://localhost:4213] [--shots=dir] [--token-file=path]
// Run with NODE_PATH pointing at a node_modules that has playwright(-core).
// Playback uses the real API harness behind the dev server (30 s PREVIEW is fine: the threshold is lowered).
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright-core')); } catch { ({ chromium } = require('playwright')); }

const base = process.argv.find((a) => a.startsWith('http')) || 'http://localhost:4213';
const shots = (process.argv.find((a) => a.startsWith('--shots=')) || '').slice(8);
const tokenFile = (process.argv.find((a) => a.startsWith('--token-file=')) || '').slice(13);
const userToken = tokenFile ? readFileSync(tokenFile, 'utf8').trim() : '';
const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const launchArgs = { args: ['--autoplay-policy=no-user-gesture-required'] };
const browser = await chromium.launch({ channel: 'chrome', ...launchArgs }).catch(() => chromium.launch(launchArgs));
const errors = [];

const CREDS_KEY = 'fiesta:music:secret:scrobble-creds';
const CFG_KEY = 'fiesta:music:scrobble-config';
const QUEUE_KEY = 'fiesta:music:secret:scrobble-queue';

async function newCtx({ seed } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  if (userToken) await ctx.route('**/api/music*', (r) => r.continue({ headers: { ...r.request().headers(), 'x-tidal-token': userToken } }));
  if (seed) await ctx.addInitScript((s) => {
    if (sessionStorage.getItem('p13-seeded')) return;
    sessionStorage.setItem('p13-seeded', '1');
    for (const [k, v] of Object.entries(s)) localStorage.setItem(k, JSON.stringify(v));
  }, seed);
  return ctx;
}
async function newPage(ctx) {
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  return page;
}
const dbg = (page) => page.waitForFunction(() => !!window.__music, null, { timeout: 20000 });
const ls = (page, key) => page.evaluate((k) => localStorage.getItem(k), key);

// ListenBrainz mock: records every call, behaviour switchable.
function mockListenBrainz(ctx, state) {
  state.calls = [];
  state.mode = 'ok';
  return ctx.route('https://api.listenbrainz.org/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const body = req.postData() ? JSON.parse(req.postData()) : null;
    state.calls.push({ path: url.pathname, method: req.method(), body, auth: req.headers()['authorization'], at: Date.now() });
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 200, headers: cors });
    if (state.mode === 'down' && url.pathname.includes('submit-listens')) return route.abort('internetdisconnected');
    if (url.pathname.endsWith('/validate-token')) return route.fulfill({ status: 200, headers: cors, json: { code: 200, valid: req.headers()['authorization'] === 'Token good-token', user_name: 'tester' } });
    if (url.pathname.includes('/metadata/lookup')) return route.fulfill({ status: 200, headers: cors, json: { recording_mbid: 'rec-mbid-1' } });
    return route.fulfill({ status: 200, headers: cors, json: { status: 'ok' } });
  });
}
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
const singles = (s) => s.calls.filter((c) => c.path.endsWith('/submit-listens') && c.body?.listen_type === 'single');
const nows = (s) => s.calls.filter((c) => c.path.endsWith('/submit-listens') && c.body?.listen_type === 'playing_now');

// A real track from the API harness (duration >= 100 s so a 2 % threshold is >= 2 s and still real).
async function pickTracks(page) {
  return page.evaluate(async () => {
    const r = await fetch('/api/music?action=search&q=' + encodeURIComponent('daft punk one more time'));
    const j = await r.json();
    return (j.tracks || []).filter((t) => t.duration >= 100).slice(0, 3);
  });
}

// ════════════════════════════════════════════════════════════════════════════
// 1. Settings UI
// ════════════════════════════════════════════════════════════════════════════
{
  const ctx = await newCtx();
  const lb = {};
  await mockListenBrainz(ctx, lb);
  const libreCalls = [];
  await ctx.route('https://libre.fm/2.0/**', async (route) => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 200, headers: cors });
    libreCalls.push(route.request().postData() || '');
    return route.fulfill({ status: 200, headers: cors, json: { session: { name: 'libreuser', key: 'LIBRE-SESSION-KEY' } } });
  });
  const page = await newPage(ctx);
  await page.goto(base + '/music/settings?tab=scrobbling&musicdebug=1', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#music-settings-scrobbling-title');
  await dbg(page);

  const slider = page.locator('input[name="scrobble-percent"]');
  check('threshold slider is 25-100 %, default 50', (await slider.getAttribute('min')) === '25' && (await slider.getAttribute('max')) === '100' && (await slider.inputValue()) === '50');
  await slider.evaluate((el) => { el.value = '80'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  check('moving the slider sets settings.scrobblePercent', (await page.evaluate(() => window.__music.settings.scrobblePercent())) === 80);
  check('the 4 minute cap is explained next to the slider', (await page.locator('#setting-scrobblePercent').innerText()).includes('4 minutes'));

  check('Last.fm shows "Not configured on this site" when the server has no key', await page.locator('[data-testid="lastfm-unconfigured"]').isVisible());
  check('no Last.fm connect controls without a server key', (await page.locator('[data-testid="lastfm-connect"], [data-testid="lastfm-password"]').count()) === 0);

  // ListenBrainz: bad token is refused, good token connects and enables.
  await page.fill('#scrobble-lb-token', 'bad-token');
  await page.click('[data-testid="lb-save"]');
  await page.waitForFunction(() => document.querySelector('[data-service="listenbrainz"]')?.textContent.includes('did not accept'));
  check('ListenBrainz refuses a token the server rejects (nothing saved)', !(await ls(page, CREDS_KEY)));
  await page.fill('#scrobble-lb-token', 'good-token');
  await page.click('[data-testid="lb-save"]');
  await page.waitForFunction(() => document.querySelector('[data-service="listenbrainz"]')?.textContent.includes('Connected as tester'));
  const credsRaw = await ls(page, CREDS_KEY);
  const cfgRaw = await ls(page, CFG_KEY);
  check('ListenBrainz token is validated, saved and the service switched on', credsRaw.includes('good-token') && JSON.parse(cfgRaw).enabled.listenbrainz === true);
  check('validate-token was called with the Token header', lb.calls.some((c) => c.path.endsWith('/validate-token') && c.auth === 'Token good-token'));

  // Maloja.
  await page.fill('#scrobble-maloja-url', 'maloja.example.org/');
  await page.fill('#scrobble-maloja-key', 'MALOJA-KEY-123');
  await page.click('[data-testid="maloja-save"]');
  await page.waitForFunction(() => (localStorage.getItem('fiesta:music:secret:scrobble-creds') || '').includes('MALOJA-KEY-123'));
  check('Maloja URL is normalised to https and the key saved', (await ls(page, CREDS_KEY)).includes('"url":"https://maloja.example.org"'));

  // Libre.fm: password sent hashed only, session saved.
  await page.fill('#scrobble-libre-user', 'libreuser');
  await page.fill('#scrobble-libre-pass', 'p@ssw0rd-secret');
  await page.click('[data-testid="libre-connect"]');
  await page.waitForFunction(() => (localStorage.getItem('fiesta:music:secret:scrobble-creds') || '').includes('LIBRE-SESSION-KEY'));
  check('Libre.fm signs in without sending or storing the password', libreCalls.length === 1 && !libreCalls[0].includes('p%40ssw0rd') && !libreCalls[0].includes('p@ssw0rd') && libreCalls[0].includes('authToken=') && libreCalls[0].includes('api_sig=') && !(await ls(page, CREDS_KEY)).includes('ssw0rd'));

  // Secrets only under fiesta:music:secret:*
  const leaks = await page.evaluate(() => {
    const secrets = ['good-token', 'MALOJA-KEY-123', 'LIBRE-SESSION-KEY'];
    return Object.keys(localStorage).filter((k) => !k.startsWith('fiesta:music:secret:') && secrets.some((s) => (localStorage.getItem(k) || '').includes(s)));
  });
  check('credentials live only under fiesta:music:secret:*', leaks.length === 0, leaks.join(','));
  const inBackup = await page.evaluate(() => window.__music.library && !!window.__music.library.constructor);
  check('library handle present (sanity)', inBackup);
  if (shots) await page.screenshot({ path: `${shots}/music-p13-settings.png`, fullPage: true });
  await ctx.close();
}

// ════════════════════════════════════════════════════════════════════════════
// 2. Last.fm with a configured server (status + auth endpoints mocked)
// ════════════════════════════════════════════════════════════════════════════
{
  const ctx = await newCtx();
  const proxied = [];
  await ctx.route('**/api/music?action=lastfm*', async (route) => {
    const req = route.request();
    if (req.method() === 'POST') {
      const body = JSON.parse(req.postData());
      proxied.push(body);
      if (body.method === 'auth.getToken') return route.fulfill({ json: { token: 'WEBTOKEN' } });
      if (body.method === 'auth.getSession') return route.fulfill({ json: { session: { name: 'lastuser', key: 'LASTFM-SESSION' } } });
      if (body.method === 'auth.getMobileSession') return route.fulfill({ json: { session: { name: 'pwuser', key: 'LASTFM-PW-SESSION' } } });
      return route.fulfill({ json: {} });
    }
    return route.fulfill({ json: { configured: true, apiKey: 'public-api-key' } });
  });
  const page = await newPage(ctx);
  await page.goto(base + '/music/settings?tab=scrobbling&musicdebug=1', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="lastfm-connect"]');
  check('Last.fm Connect button and username/password form appear when the server has a key', (await page.locator('[data-testid="lastfm-password"]').count()) === 1 && (await page.locator('[data-testid="lastfm-unconfigured"]').count()) === 0);
  await ctx.route('https://www.last.fm/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<title>last.fm (mock)</title>' }));
  const popupP = ctx.waitForEvent('page');
  await page.click('[data-testid="lastfm-connect"]');
  const popup = await popupP;
  await popup.waitForURL(/last\.fm/, { timeout: 10000 }).catch(() => {});
  check('web flow: auth.getToken through the proxy, then last.fm auth page with the public key and token', proxied[0]?.method === 'auth.getToken' && popup.url().startsWith('https://www.last.fm/api/auth/') && popup.url().includes('api_key=public-api-key') && popup.url().includes('token=WEBTOKEN'), `${proxied[0]?.method} ${popup.url()}`);
  await popup.close();
  await page.click('[data-testid="lastfm-finish"]');
  await page.waitForFunction(() => (localStorage.getItem('fiesta:music:secret:scrobble-creds') || '').includes('LASTFM-SESSION'));
  check('web flow: auth.getSession stores the session under the secret key', proxied.some((p) => p.method === 'auth.getSession' && p.params.token === 'WEBTOKEN'));
  check('no secret or signature is ever sent from the browser', proxied.every((p) => !JSON.stringify(p).includes('api_sig') && !JSON.stringify(p).includes('secret')));
  await page.click('[data-testid="lastfm-disconnect"]');
  await page.fill('#scrobble-last-user', 'pwuser');
  await page.fill('#scrobble-last-pass', 'hunter2-pass');
  await page.click('[data-testid="lastfm-password"]');
  await page.waitForFunction(() => (localStorage.getItem('fiesta:music:secret:scrobble-creds') || '').includes('LASTFM-PW-SESSION'));
  check('password login keeps the session, not the password', !(await ls(page, CREDS_KEY)).includes('hunter2') && !(await page.evaluate(() => Object.keys(localStorage).some((k) => (localStorage.getItem(k) || '').includes('hunter2')))));
  await ctx.close();
}

// ════════════════════════════════════════════════════════════════════════════
// 3. Engine: playing_now, one single, paused time does not count
// ════════════════════════════════════════════════════════════════════════════
const seed = {
  [CREDS_KEY]: { listenbrainz: { token: 'good-token' } },
  [CFG_KEY]: { enabled: { listenbrainz: true, maloja: false, librefm: false, lastfm: false }, loveOnLike: false },
};
let tracks = [];
{
  const ctx = await newCtx({ seed });
  const lb = {};
  await mockListenBrainz(ctx, lb);
  const page = await newPage(ctx);
  await page.goto(base + '/music?musicdebug=1', { waitUntil: 'domcontentloaded' });
  await dbg(page);
  tracks = await pickTracks(page);
  check('the API harness returns playable tracks (search)', tracks.length > 0, tracks[0] ? `${tracks[0].title} ${tracks[0].duration}s` : 'none - is the API harness running with TIDAL_* env?');
  if (!tracks.length) { console.log('cannot continue engine checks'); await browser.close(); process.exit(1); }
  const t = tracks[0];
  await page.evaluate(() => window.__music.settings.scrobblePercent.set(2));
  const threshold = Math.min(t.duration * 0.02, 240);
  await page.evaluate(([tr, q]) => window.__music.player.play(tr, q), [t, tracks]);
  await page.waitForFunction(() => window.__music.player.playing() && window.__music.player.position() > 0.5, null, { timeout: 25000 });
  await sleep(500);
  check('playing_now is sent at track start with the metadata', nows(lb).length === 1
    && nows(lb)[0].body.payload[0].track_metadata.track_name.startsWith(t.title)
    && nows(lb)[0].body.payload[0].track_metadata.artist_name.length > 0
    && !('listened_at' in nows(lb)[0].body.payload[0]), JSON.stringify(nows(lb)[0]?.body?.payload?.[0]?.track_metadata?.track_name));
  check('requests carry the Token authorization header', nows(lb)[0]?.auth === 'Token good-token');
  // Pause well before the threshold, wait longer than the threshold in wall time: nothing may scrobble.
  await sleep(1000);
  await page.evaluate(() => window.__music.player.pause());
  const played = await page.evaluate(() => window.__music.player.position());
  const wait = Math.ceil(threshold) + 4;
  await sleep(wait * 1000);
  check(`paused time does not count (${wait}s paused, threshold ${threshold.toFixed(1)}s, played ~${played.toFixed(1)}s): no scrobble`, singles(lb).length === 0);
  await page.evaluate(() => window.__music.player.resume ? window.__music.player.resume() : window.__music.player.toggle());
  await page.waitForFunction(() => window.__music.player.playing(), null, { timeout: 10000 });
  const resumedAt = Date.now();
  const deadline = Date.now() + (threshold + 15) * 1000;
  while (!singles(lb).length && Date.now() < deadline) await sleep(250);
  check('playing past the threshold sends a single listen', singles(lb).length === 1);
  const s = singles(lb)[0];
  const pl = s?.body?.payload?.[0];
  check('the single carries listened_at (track start) and the track metadata', !!pl && Math.abs(pl.listened_at - Math.floor(Date.now() / 1000)) < 120 && pl.track_metadata.track_name.startsWith(t.title) && pl.track_metadata.release_name === t.album, JSON.stringify(pl?.track_metadata?.release_name));
  await sleep(3500);
  check('exactly one single (no duplicate while the track keeps playing)', singles(lb).length === 1);
  // Seek must not add credit: a new track starts a new run.
  const needed = singles(lb)[0] ? (singles(lb)[0].at - resumedAt) / 1000 : 0;
  check('scrobble came after the remaining played time, not instantly on resume', needed > 0.5, `${needed.toFixed(1)}s after resume`);
  if (shots) await page.screenshot({ path: `${shots}/music-p13-engine.png` });
  await ctx.close();
}

// ════════════════════════════════════════════════════════════════════════════
// 4. Offline queue
// ════════════════════════════════════════════════════════════════════════════
{
  const ctx = await newCtx({ seed });
  const lb = {};
  await mockListenBrainz(ctx, lb);
  lb.mode = 'down';
  const page = await newPage(ctx);
  await page.goto(base + '/music?musicdebug=1', { waitUntil: 'domcontentloaded' });
  await dbg(page);
  await page.evaluate(() => window.__music.settings.scrobblePercent.set(2));
  await page.evaluate(([tr, q]) => window.__music.player.play(tr, q), [tracks[0], tracks]);
  await page.waitForFunction(() => localStorage.getItem('fiesta:music:secret:scrobble-queue') && JSON.parse(localStorage.getItem('fiesta:music:secret:scrobble-queue')).length === 1, null, { timeout: 40000 });
  const q = JSON.parse(await ls(page, QUEUE_KEY));
  check('a failed submission is queued in fiesta:music:secret:scrobble-queue', q.length === 1 && q[0].service === 'listenbrainz' && q[0].kind === 'scrobble' && q[0].meta.title.startsWith(tracks[0].title));
  await page.evaluate(() => window.__music.player.pause());
  lb.mode = 'ok';
  const before = singles(lb).length;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('fiesta:music:secret:scrobble-queue') || '[]').length === 0, null, { timeout: 10000 });
  check('the queue is retried on the online event and then emptied', singles(lb).length === before + 1 && JSON.parse(await ls(page, QUEUE_KEY)).length === 0);
  check('the retried listen is the same track and start time', singles(lb).at(-1).body.payload[0].listened_at === q[0].ts);
  await ctx.close();
}

// ════════════════════════════════════════════════════════════════════════════
// 5. Love on like
// ════════════════════════════════════════════════════════════════════════════
{
  const ctx = await newCtx({ seed });
  const lb = {};
  await mockListenBrainz(ctx, lb);
  const page = await newPage(ctx);
  await page.goto(base + '/music/settings?tab=scrobbling&musicdebug=1', { waitUntil: 'domcontentloaded' });
  await dbg(page);
  const like = () => page.evaluate((t) => { const m = window.__music; return m.library.toggleFavorite({ kind: 'track', data: t }); }, tracks[0]);
  const feedback = () => lb.calls.filter((c) => c.path.endsWith('/feedback/recording-feedback'));
  await like();
  await sleep(1000);
  check('love-on-like off: liking sends nothing', feedback().length === 0);
  await page.evaluate((t) => window.__music.library.toggleFavorite({ kind: 'track', data: t }), tracks[0]); // unlike
  await page.click('#setting-scrobbleLove button[role="switch"]');
  check('love-on-like switch persists', JSON.parse(await ls(page, CFG_KEY)).loveOnLike === true);
  await like();
  await page.waitForFunction(() => true);
  const t0 = Date.now();
  while (!feedback().length && Date.now() - t0 < 8000) await sleep(200);
  await sleep(800);
  check('liking a track calls the love endpoint once', feedback().length === 1 && feedback()[0].body.recording_mbid === 'rec-mbid-1' && feedback()[0].body.score === 1);
  await ctx.close();
}

// ════════════════════════════════════════════════════════════════════════════
// 6. Last.fm backend (lib/music/scrobble.js), in-process with a stubbed upstream
// ════════════════════════════════════════════════════════════════════════════
{
  const scrobble = require('../../lib/music/scrobble.js');
  const mkRes = () => { const r = { headers: {}, statusCode: 200, body: undefined };
    r.setHeader = (k, v) => { r.headers[k] = v; }; r.status = (c) => { r.statusCode = c; return r; }; r.json = (b) => { r.body = b; return r; }; return r; };
  const call = async (req, q = {}) => { const res = mkRes(); try { await scrobble.lastfm(q, req, res); } catch (e) { res.statusCode = e.status; res.body = { error: e.code }; } return res; };
  const saved = { k: process.env.LASTFM_API_KEY, s: process.env.LASTFM_API_SECRET, f: globalThis.fetch };
  delete process.env.LASTFM_API_KEY; delete process.env.LASTFM_API_SECRET;
  const none = await call({ method: 'POST', body: { method: 'track.love', params: {} } });
  check("lastfm without env keys: 503 {error:'lastfm_not_configured'} and no-store", none.statusCode === 503 && none.body.error === 'lastfm_not_configured' && none.headers['Cache-Control'] === 'no-store');
  const noneGet = await call({ method: 'GET' });
  check('lastfm status GET without keys is also 503', noneGet.statusCode === 503);

  // Placeholder values that only exist in this test process (not credentials).
  process.env.LASTFM_API_KEY = 'testkey'; process.env.LASTFM_API_SECRET = 'testsecret';
  let sent = null;
  globalThis.fetch = async (url, init) => { sent = { url, body: new URLSearchParams(String(init.body)), headers: init.headers }; return new Response(JSON.stringify({ ok: 1 }), { status: 200 }); };
  const bad = await call({ method: 'POST', body: { method: 'user.getFriends', params: {} } });
  check('methods outside the allow-list are a 400 and nothing is forwarded', bad.statusCode === 400 && sent === null);
  const ok = await call({ method: 'POST', body: { method: 'track.scrobble', params: { artist: 'A', track: 'T', timestamp: '1', sk: 'SK', api_key: 'attacker', api_sig: 'x' } } });
  const p = sent && Object.fromEntries(sent.body);
  const { api_sig, format, ...rest } = p || {};
  const expected = createHash('md5').update(Object.keys(rest).sort().map((k) => k + rest[k]).join('') + 'testsecret').digest('hex');
  check('POST is signed server-side and forwarded to ws.audioscrobbler.com/2.0', ok.statusCode === 200 && sent.url === 'https://ws.audioscrobbler.com/2.0/' && api_sig === expected && format === 'json' && rest.api_key === 'testkey');
  check('caller cannot override api_key/api_sig; the secret is not in the forwarded request', rest.api_key === 'testkey' && !JSON.stringify(p).includes('testsecret') && ok.headers['Cache-Control'] === 'no-store');
  for (const m of ['auth.getToken', 'auth.getSession', 'auth.getMobileSession', 'track.updateNowPlaying', 'track.love', 'track.unlove', 'user.getRecentTracks', 'user.getTopArtists']) {
    sent = null;
    const r = await call({ method: 'POST', body: { method: m, params: {} } });
    if (r.statusCode !== 200 || sent?.body.get('method') !== m) { check('allow-listed method ' + m, false); }
  }
  check('all nine allow-listed methods are forwarded', true);
  const status = await call({ method: 'GET' });
  check('GET with keys reports configured + the public api key only', status.statusCode === 200 && status.body.configured === true && status.body.apiKey === 'testkey' && !JSON.stringify(status.body).includes('testsecret'));
  globalThis.fetch = async () => new Response(JSON.stringify({ error: 9, message: 'Invalid session key' }), { status: 403 });
  const err = await call({ method: 'POST', body: { method: 'track.love', params: {} } });
  check('Last.fm errors are passed through', err.statusCode === 403 && err.body.error === 9);
  if (saved.k === undefined) delete process.env.LASTFM_API_KEY; else process.env.LASTFM_API_KEY = saved.k;
  if (saved.s === undefined) delete process.env.LASTFM_API_SECRET; else process.env.LASTFM_API_SECRET = saved.s;
  globalThis.fetch = saved.f;
}

check('no uncaught page errors', errors.length === 0, errors.slice(0, 2).join(' | '));
await browser.close();
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
