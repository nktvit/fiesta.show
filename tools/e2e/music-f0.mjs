// E2E for package F0 (music foundation): routes + subnav, the player engine
// (shuffle/repeat, volume, speed, persistence, preload/gapless, sleep timer,
// skip-unavailable, Media Session), the library store and the new API actions.
//   node tools/e2e/music-f0.mjs [baseUrl=http://localhost:4200] [--shots=dir] [--token-file=path]
// Drives the app through `?musicdebug=1` (window.__music). Passes with 30 s
// previews (no TIDAL user token) as well as with full tracks.
// Run from a dir whose node_modules has playwright(-core) (or set NODE_PATH).
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright-core')); } catch { ({ chromium } = require('playwright')); }

const base = process.argv.find((a) => a.startsWith('http')) || 'http://localhost:4200';
const shots = (process.argv.find((a) => a.startsWith('--shots=')) || '').slice(8);
const tokenFile = (process.argv.find((a) => a.startsWith('--token-file=')) || '').slice(13);
const userToken = tokenFile ? (await import('node:fs')).readFileSync(tokenFile, 'utf8').trim() : '';
const results = [];
const check = (name, ok, extra = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };

const browser = await chromium.launch({ channel: 'chrome', args: ['--autoplay-policy=no-user-gesture-required'] })
  .catch(() => chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] }));
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
if (userToken) await ctx.route('**/api/music*', (r) => r.continue({ headers: { ...r.request().headers(), 'x-tidal-token': userToken } }));

// Spy on the Media Session before the app boots.
await ctx.addInitScript(() => {
  window.__ms = { actions: [], positions: 0 };
  if (!('mediaSession' in navigator)) return;
  const ms = navigator.mediaSession;
  const setAction = ms.setActionHandler.bind(ms);
  ms.setActionHandler = (a, h) => { if (h) window.__ms.actions.push(a); return setAction(a, h); };
  const setPos = ms.setPositionState?.bind(ms);
  if (setPos) ms.setPositionState = (s) => { window.__ms.positions++; return setPos(s); };
});

const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

const api = (qs, init) => page.evaluate(async ([q, i]) => {
  const r = await fetch('/api/music?' + q, i);
  const type = r.headers.get('content-type') || '';
  return { status: r.status, type, acao: r.headers.get('access-control-allow-origin'), body: type.includes('json') ? await r.json() : null };
}, [qs, init || null]);
const wait = (ms) => page.waitForTimeout(ms);
const until = async (fn, arg, ms = 20000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await page.evaluate(fn, arg)) return true; await wait(200); }
  return false;
};
const boot = async (path = '/music') => {
  await page.goto(base + path + (path.includes('?') ? '&' : '?') + 'musicdebug=1', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__music, null, { timeout: 30000 });
};

// ── 1. Routes ───────────────────────────────────────────────────────────────
// Titles as shipped by the packages (F0 had stub titles); the generic site title means the page set none.
const routes = [
  ['/music/explore', /^Explore/], ['/music/library', /^(Your )?Library/i], ['/music/library/playlist/x', /./],
  ['/music/recent', /^Recently played$/], ['/music/settings', /^Music settings$/], ['/music/shared', /^Shared playlist/i],
  ['/music/track/1', /./], ['/music/mix/x', /./], ['/music/playlist/x', /./],
];
let routeOk = 0;
const routeFails = [];
for (const [path, title] of routes) {
  await page.goto(base + path, { waitUntil: 'domcontentloaded' });
  const ok = await page.waitForSelector('nav[aria-label="Music sections"]', { timeout: 15000 }).then(() => true).catch(() => false);
  const h1 = await page.locator('main h1').first().waitFor({ timeout: 15000 }).then(() => true).catch(() => false);
  // Let the page's own data request settle so an error/not-found title has been applied.
  await page.waitForTimeout(1500);
  const t = await page.title();
  const m = t.match(/^(.*) \| Stream Fiesta$/);
  if (ok && h1 && m && title.test(m[1])) routeOk++;
  else routeFails.push(`${path} (${t})`);
}
check('every music route renders with subnav, h1 and a "<Thing> | Stream Fiesta" title', routeOk === routes.length, routeFails.join(', '));
await page.goto(base + '/music/settings?tab=data', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('app-music-settings-data', { timeout: 15000 }).catch(() => {});
check('settings ?tab= deep link selects the section (Settings stays active in the subnav)', (await page.locator('app-music-settings-data h2').count()) === 1
  && (await page.locator('nav[aria-label="Music sections"] a[aria-current="page"]').first().textContent().catch(() => ''))?.trim() === 'Settings');
await page.goto(base + '/music/foo', { waitUntil: 'domcontentloaded' });
await page.waitForURL((u) => new URL(u).pathname === '/', { timeout: 15000 }).catch(() => {});
check('unknown /music/foo redirects to /', new URL(page.url()).pathname === '/', page.url());
await page.goto(base + '/music?q=', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('nav[aria-label="Music sections"] a[aria-current="page"]', { timeout: 15000 }).catch(() => {});
check('/music shows subnav (Home active) and home suggestions',
  (await page.locator('nav[aria-label="Music sections"] a[aria-current="page"]').first().textContent().catch(() => ''))?.trim() === 'Home'
  && (await page.locator('app-music-home button:has-text("Daft Punk")').count()) === 1);
if (shots) await page.screenshot({ path: `${shots}/f0-music-home.png` });

// ── 2. API ──────────────────────────────────────────────────────────────────
await boot('/music');
const search = await api('action=search&q=' + encodeURIComponent('daft punk discovery'));
const tracks = (search.body?.tracks || []).filter((t) => t.albumId);
check('search returns tracks with the new fields (isrc, artists, releaseDate)', tracks.length >= 5 && 'isrc' in tracks[0] && Array.isArray(tracks[0].artists) && 'releaseDate' in tracks[0], `${tracks.length} tracks`);
const albumRes = await api('action=album&id=' + tracks[0].albumId);
const album = albumRes.body?.tracks || [];
check('album returns album with type/artistId', !!albumRes.body?.album?.type && 'artistId' in (albumRes.body?.album || {}), albumRes.body?.album?.type);
const m1 = await api(`action=manifest&id=${tracks[0].id}&quality=LOSSLESS`);
const rgKeys = ['trackReplayGain', 'trackPeakAmplitude', 'albumReplayGain', 'albumPeakAmplitude'].filter((k) => typeof m1.body?.[k] === 'number');
check('manifest includes TIDAL ReplayGain/peak fields', rgKeys.length === 4, rgKeys.join(','));
const mh = await api(`action=manifest&id=${tracks[0].id}&quality=HI_RES_LOSSLESS`);
check('manifest accepts quality=HI_RES_LOSSLESS', mh.status === 200 && !!mh.body?.quality, `${mh.status} -> ${mh.body?.quality}`);
const b64 = (s) => Buffer.from(s).toString('base64url');
const img = await api('action=img&u=' + b64(tracks[0].cover));
check('img proxies a resources.tidal.com cover as image/jpeg with ACAO *', img.status === 200 && img.type.startsWith('image/jpeg') && img.acao === '*', `${img.status} ${img.type} ${img.acao}`);
const bad = await api('action=img&u=' + b64('https://example.com/x.jpg'));
check('img refuses a non-TIDAL host with 400', bad.status === 400, String(bad.status));
const stubs = ['suggest', 'search-type', 'track', 'tracks', 'album-extras', 'artist-bio', 'similar-artists', 'similar-albums',
  'artist-albums', 'artist-toptracks', 'artist-links', 'aoty', 'mix', 'track-mix', 'artist-mix', 'playlist', 'explore', 'page', 'lastfm'];
const stubRes = [];
for (const a of stubs) {
  const r = await api('action=' + a);
  // Every F0 stub is now implemented: no 501, and a missing/invalid id is a 4xx, never a 5xx.
  // lastfm answers 503 not_configured until LASTFM_API_KEY/SECRET are set (owner).
  const fine = r.status !== 501 && (r.status < 500 || (a === 'lastfm' && r.status === 503));
  stubRes.push(fine ? '' : `${a}:${r.status}`);
}
const notStub = stubRes.filter(Boolean);
check('every former lib/music/* stub action is implemented (no 501, no 5xx without params)', notStub.length === 0, notStub.join(' '));
const post = await api('action=lastfm', { method: 'POST' });
const postBad = await api('action=search&q=x', { method: 'POST' });
check('POST is accepted for lastfm only', post.status !== 405 && postBad.status === 405, `${post.status}/${postBad.status}`);

// ── 3. Engine ───────────────────────────────────────────────────────────────
const list = album.length >= 4 ? album.slice(0, 6) : tracks.slice(0, 6);
const ids = list.map((t) => t.id);
await page.evaluate((l) => window.__music.player.play(l[0], l), list);
const started = await until(() => window.__music.player.playing() && window.__music.player.position() > 0.5, null, 25000);
check('player plays a list via __music', started, String(await page.evaluate(() => window.__music.player.track()?.title)));
check('Media Session handlers include seekforward/seekbackward/seekto/stop',
  await page.evaluate(() => ['seekforward', 'seekbackward', 'seekto', 'stop', 'play', 'pause', 'nexttrack', 'previoustrack'].every((a) => window.__ms.actions.includes(a))),
  String(await page.evaluate(() => window.__ms.actions.join(','))));
check('setPositionState is called on track start', await page.evaluate(() => window.__ms.positions > 0), String(await page.evaluate(() => window.__ms.positions)));

// Shuffle / repeat.
const sh = await page.evaluate((orig) => {
  const p = window.__music.player;
  p.playAt(1);
  const cur = orig[1];
  p.toggleShuffle();
  const a = p.queue().map((t) => t.id);
  const first = a[0] === cur && p.index() === 0;
  p.toggleShuffle();
  const b = p.queue().map((t) => t.id);
  return { first, sameSet: [...a].sort().join() === [...orig].sort().join(), restored: b.join() === orig.join(), idx: p.index() };
}, ids);
check('toggleShuffle puts the current track first; toggling again restores the order', sh.first && sh.sameSet && sh.restored && sh.idx === 1, JSON.stringify(sh));
const rep = await page.evaluate(() => { const p = window.__music.player; const out = [p.repeat()]; for (let i = 0; i < 3; i++) { p.cycleRepeat(); out.push(p.repeat()); } return out.join('>'); });
check('cycleRepeat goes off -> all -> one -> off', rep === 'off>all>one>off', rep);

// Queue editing.
const qe = await page.evaluate((extra) => {
  const p = window.__music.player;
  const before = p.queue().length; const idx = p.index(); const cur = p.track().id;
  p.addToQueue([extra[0]]);
  const added = p.queue().length === before + 1 && p.queue()[p.queue().length - 1].id === extra[0].id;
  p.playNext([extra[1]]);
  const next = p.queue()[p.index() + 1].id === extra[1].id;
  p.removeAt(0);
  const shifted = p.index() === idx - 1 && p.track().id === cur;
  p.move(p.queue().length - 1, 0);
  const moved = p.index() === idx && p.track().id === cur;
  return { added, next, shifted, moved };
}, tracks.slice(-2));
check('addToQueue/playNext/removeAt/move keep queue() and index() right', qe.added && qe.next && qe.shifted && qe.moved, JSON.stringify(qe));
await page.evaluate((l) => window.__music.player.play(l[0], l), list);
await until(() => window.__music.player.playing(), null, 20000);

// Volume + speed (persist across reload).
const vol = await page.evaluate(() => {
  const p = window.__music.player; const s = window.__music.settings;
  p.setVolume(0.3); const lin = p.activeElement().volume;
  s.exponentialVolume.set(true); p.setVolume(0.3); const exp = p.activeElement().volume;
  s.exponentialVolume.set(false); p.setVolume(0.3);
  p.toggleMute(); const muted = p.activeElement().muted;
  p.setPlaybackRate(1.5); const rate = p.activeElement().playbackRate;
  p.setPreservesPitch(false); const pitch = p.activeElement().preservesPitch;
  s.flush();
  return { lin, exp, muted, rate, pitch };
});
check('setVolume(0.3) sets the element volume (0.027 exponential); toggleMute mutes', Math.abs(vol.lin - 0.3) < 1e-6 && Math.abs(vol.exp - 0.027) < 1e-6 && vol.muted, JSON.stringify(vol));
check('setPlaybackRate(1.5) applies; preservesPitch toggles', vol.rate === 1.5 && vol.pitch === false);

// History after 10 s of play (at 1.5x that's ~7 s of wall time).
await page.evaluate(() => { window.__music.player.toggleMute(); window.__music.player.setPlaybackRate(1); });
await page.evaluate(() => window.__music.player.setPlaybackRate(1.5));
const hist = await until((id) => window.__music.library.history().some((h) => h.track.id === id), ids[0], 20000);
check('history gains the track after 10 s of play', hist && (await page.evaluate(() => JSON.parse(localStorage.getItem('fiesta:music:history') || '[]').length)) > 0);

// Library like.
const fav = await page.evaluate((t) => {
  const l = window.__music.library; const item = { kind: 'track', data: t };
  const was = l.isFavorite(item); l.toggleFavorite(item);
  const stored = JSON.parse(localStorage.getItem('fiesta:music:library') || '{}');
  return { was, now: l.isFavorite(item), stored: (stored.favorites?.tracks || []).some((x) => x.id === t.id) };
}, list[0]);
check('library.toggleFavorite persists under fiesta:music:library; isFavorite flips', !fav.was && fav.now && fav.stored, JSON.stringify(fav));

// Reload restores queue/index/position paused (+ volume/speed persisted).
await page.evaluate(() => { const p = window.__music.player; p.playAt(2); });
await until(() => window.__music.player.index() === 2 && window.__music.player.playing(), null, 20000);
await page.evaluate(() => window.__music.player.seek(12));
await until(() => window.__music.player.position() > 13, null, 20000);
await page.evaluate(() => window.__music.player.pause());
await wait(300);
const beforeReload = await page.evaluate(() => ({ title: window.__music.player.track().title, pos: Math.floor(window.__music.player.position()), idx: window.__music.player.index(), len: window.__music.player.queue().length }));
await boot('/music');
await page.waitForSelector('app-music-player-bar section', { timeout: 15000 }).catch(() => {});
const after = await page.evaluate(() => ({ title: window.__music.player.track()?.title, pos: Math.floor(window.__music.player.position()), idx: window.__music.player.index(), len: window.__music.player.queue().length, playing: window.__music.player.playing(), vol: window.__music.settings.volume(), muted: window.__music.settings.muted(), rate: window.__music.settings.playbackRate(), el: window.__music.player.activeElement().playbackRate }));
const barTitle = (await page.locator('app-music-player-bar a span.truncate').first().textContent().catch(() => '') || '').trim();
const playBtn = await page.locator('app-music-player-bar button[aria-label="Play"]').count();
check('reload restores queue, index and position paused (bar shows title + Play)',
  beforeReload.pos >= 12 && after.title === beforeReload.title && after.idx === beforeReload.idx && after.len === beforeReload.len && Math.abs(after.pos - beforeReload.pos) <= 1 && !after.playing && barTitle === beforeReload.title && playBtn === 1,
  `${JSON.stringify(beforeReload)} -> ${JSON.stringify(after)} bar="${barTitle}"`);
check('volume, mute and speed persist across reload', Math.abs(after.vol - 0.3) < 1e-6 && after.muted === false && after.rate === 1.5 && after.el === 1.5, JSON.stringify(after));
if (shots) await page.screenshot({ path: `${shots}/f0-restored.png` });
await page.evaluate(() => { window.__music.player.setPlaybackRate(1); window.__music.player.setVolume(1); window.__music.player.setPreservesPitch(true); });

// Resume from the restored position.
await page.click('app-music-player-bar button[aria-label="Play"]');
const resumed = await until((p) => window.__music.player.playing() && window.__music.player.position() >= p && window.__music.player.position() < p + 10, beforeReload.pos, 20000);
check('Play after reload resumes from the saved position', resumed, String(await page.evaluate(() => window.__music.player.position())));

// Preload + gapless.
await page.evaluate(() => {
  const p = window.__music.player;
  window.__gap = { ended: 0, playing: 0, starts: [] };
  for (const el of p.elements()) {
    el.addEventListener('ended', () => { window.__gap.ended = performance.now(); window.__gap.playing = 0; });
    el.addEventListener('playing', () => { if (window.__gap.ended && !window.__gap.playing) window.__gap.playing = performance.now(); });
  }
  p.on('trackstart', (e) => window.__gap.starts.push(e.track.id));
  window.__music.settings.gapless.set(true);
});
const nextId = await page.evaluate(() => { const p = window.__music.player; return p.queue()[p.index() + 1]?.id; });
await page.evaluate(() => { const p = window.__music.player; p.seek(Math.max(0, p.duration() - 30)); });
const preloaded = await until((id) => { const d = window.__music.player.debugState(); return d.standbyTrackId === id && d.standbyReady; }, nextId, 20000);
check('within 45 s of the end the standby deck preloads the next track', preloaded, JSON.stringify(await page.evaluate(() => window.__music.player.debugState())));
await wait(1500);
await page.evaluate(() => { const p = window.__music.player; p.seek(p.duration() - 1.5); });
const switched = await until((id) => window.__music.player.track()?.id === id && window.__gap.playing > 0, nextId, 20000);
const gap = await page.evaluate(() => window.__gap.playing - window.__gap.ended);
check('gapless: the next track starts < 300 ms after ended', switched && gap >= 0 && gap < 300, `${Math.round(gap)} ms`);

// Repeat one replays; repeat all wraps.
await page.evaluate(() => window.__music.player.setRepeat('one'));
await until(() => window.__music.player.playing(), null, 10000);
const r1 = await page.evaluate(() => { const p = window.__music.player; window.__r1 = { id: p.track().id, starts: 0 }; p.on('trackstart', () => window.__r1.starts++); p.seek(p.duration() - 1.5); return p.track().id; });
const replayed = await until(() => window.__r1.starts > 0, null, 15000);
const r1after = await page.evaluate(() => ({ id: window.__music.player.track().id, pos: window.__music.player.position() }));
check('repeat one replays the same track on ended', replayed && r1after.id === r1 && r1after.pos < 5, JSON.stringify(r1after));
await page.evaluate(() => { const p = window.__music.player; p.setRepeat('all'); p.playAt(p.queue().length - 1); });
await until(() => window.__music.player.playing() && window.__music.player.index() === window.__music.player.queue().length - 1 && window.__music.player.position() > 0.3, null, 20000);
await page.evaluate(() => { const p = window.__music.player; p.seek(p.duration() - 1.5); });
const wrapped = await until(() => window.__music.player.index() === 0 && window.__music.player.playing(), null, 20000);
check('repeat all wraps from the last track to the first', wrapped, String(await page.evaluate(() => window.__music.player.index())));
await page.evaluate(() => window.__music.player.setRepeat('off'));

// Sleep timer.
await page.evaluate(() => window.__music.player.setSleepTimer(0.05));
const slept = await until(() => !window.__music.player.playing() && window.__music.player.sleep().endsAt === null, null, 8000);
check('setSleepTimer(0.05) pauses after ~3 s', slept);
await page.evaluate(() => { const p = window.__music.player; p.playAt(0); });
await until(() => window.__music.player.playing() && window.__music.player.index() === 0 && window.__music.player.position() > 0.3, null, 20000);
await page.evaluate(() => { const p = window.__music.player; p.setSleepTimer('end-of-track'); p.seek(p.duration() - 1.5); });
await wait(4000);
const eot = await page.evaluate(() => ({ idx: window.__music.player.index(), playing: window.__music.player.playing(), armed: window.__music.player.sleep().endOfTrack }));
check("sleep 'end-of-track' pauses on ended instead of advancing", eot.idx === 0 && !eot.playing && !eot.armed, JSON.stringify(eot));

// Forced manifest failure -> amber toast + auto-advance; all failing -> stop after one pass.
const failId = list[1].id;
await page.route(`**/api/music?action=manifest&id=${failId}&*`, (r) => r.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"not_found"}' }));
await page.evaluate((l) => window.__music.player.play(l[1], l), list);
const advanced = await until((id) => window.__music.player.track()?.id === id && window.__music.player.playing(), list[2].id, 20000);
const toastText = (await page.locator('app-music-toast-host p.text-amber-400').first().textContent().catch(() => '') || '').trim();
check('a failing manifest shows the amber toast and auto-advances', advanced && /skipping/i.test(toastText), toastText);
if (shots) await page.screenshot({ path: `${shots}/f0-toast.png` });
await page.route('**/api/music?action=manifest*', (r) => r.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"not_found"}' }));
let manifestCalls = 0;
page.on('request', (r) => { if (r.url().includes('action=manifest')) manifestCalls++; });
await page.evaluate((l) => window.__music.player.play(l[0], l.slice(0, 4)), list);
await wait(4000);
const stopped = await page.evaluate(() => ({ err: window.__music.player.error(), playing: window.__music.player.playing() }));
check('a queue of all-failing tracks stops after one pass', stopped.err === 'unavailable' && !stopped.playing && manifestCalls <= 6, `${JSON.stringify(stopped)} calls=${manifestCalls}`);
await page.unroute('**/api/music?action=manifest*');
await page.unroute(`**/api/music?action=manifest&id=${failId}&*`);

// Overlay shells: side panel + dialog open, trap focus, close on Escape.
await page.evaluate(() => window.__music.ui.openPanel('queue'));
const panelOk = await page.waitForSelector('app-music-queue-panel section[role="dialog"][aria-modal="true"]', { timeout: 10000 }).then(() => true).catch(() => false);
const locked = await page.evaluate(() => document.body.classList.contains('music-overlay-open'));
await page.keyboard.press('Escape');
await wait(300);
const panelClosed = await page.evaluate(() => window.__music.ui.panel() === null && !document.body.classList.contains('music-overlay-open'));
check('side panel opens as a modal dialog, locks scroll, Escape closes', panelOk && locked && panelClosed, `${panelOk}/${locked}/${panelClosed}`);
await page.evaluate(() => window.__music.ui.openTrackInfo(window.__music.player.queue()[0]));
const dlg = await page.waitForSelector('app-music-track-info section[role="dialog"]', { timeout: 10000 }).then(() => true).catch(() => false);
await page.goBack();
await wait(500);
const backClosed = await page.evaluate(() => window.__music.ui.trackInfo() === null);
check('dialog opens; Back closes it without leaving the page', dlg && backClosed && new URL(page.url()).pathname === '/music', page.url());

check('no uncaught page errors', errors.length === 0, errors.slice(0, 3).join(' | '));

await browser.close();
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
