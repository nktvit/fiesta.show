// E2E for package P9: music home, mixes, TIDAL playlists, Explore, radio, autoplay, listening tracker
// and the discovery backend actions.
//   node tools/e2e/music-p9.mjs [baseUrl=http://localhost:4209] [--api=http://localhost:3909] [--shots=dir] [--token-file=path]
// Run with playwright-core resolvable (NODE_PATH=<dir>/node_modules). Without a user token playback is the
// 30 s PREVIEW, which is all these checks need.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright-core')); } catch { ({ chromium } = require('playwright')); }

const base = process.argv.find((a) => a.startsWith('http')) || 'http://localhost:4209';
const api = (process.argv.find((a) => a.startsWith('--api=')) || '--api=http://localhost:3909').slice(6);
const shots = (process.argv.find((a) => a.startsWith('--shots=')) || '').slice(8);
const tokenFile = (process.argv.find((a) => a.startsWith('--token-file=')) || '').slice(13);
const userToken = tokenFile ? (await import('node:fs')).readFileSync(tokenFile, 'utf8').trim() : '';
const results = [];
const check = (name, ok, extra = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };

// ---- Backend ---------------------------------------------------------------------------------
async function get(q) {
  const r = await fetch(`${api}/api/music?${q}`);
  let body = null; try { body = await r.json(); } catch { /* not json */ }
  return { status: r.status, cc: r.headers.get('cache-control') || '', body };
}
const arr = Array.isArray;
const MIX_ID = '0012a485b7f1404666cc81b8889978'; // a TIDAL track-radio mix (stable enough: 404 is reported, not hidden)
const BIG_PLAYLIST = '870b1baa-a778-4e9e-9f02-2bc27775701b'; // "Hip-Hop Workout": > 200 songs
{
  let r = await get('action=track-mix&id=4493586');
  check('api track-mix: 200 JSON + Cache-Control + >= 10 tracks', r.status === 200 && !!r.cc && arr(r.body.tracks) && r.body.tracks.length >= 10 && !!r.body.mixId, `${r.status} ${r.cc} n=${r.body?.tracks?.length}`);
  check('api track-mix: seed track is not in its own radio', !r.body.tracks.some((t) => t.id === 4493586));
  r = await get('action=track-mix&id=4493586&mixOnly=1');
  check('api track-mix mixOnly: id without songs', r.status === 200 && !!r.body.mixId && r.body.tracks.length === 0 && !!r.cc);
  r = await get('action=track-mix&id=99999999999');
  check('api track-mix: unknown track -> 200 empty (degrades, not 500)', r.status === 200 && arr(r.body.tracks) && r.body.tracks.length === 0 && !!r.cc, `${r.status} ${r.cc}`);
  r = await get('action=artist-mix&id=1566');
  check('api artist-mix: 200 JSON + Cache-Control + >= 10 tracks', r.status === 200 && !!r.cc && arr(r.body.tracks) && r.body.tracks.length >= 10, `${r.status} ${r.cc} n=${r.body?.tracks?.length}`);
  r = await get(`action=mix&id=${MIX_ID}`);
  check('api mix: header + tracks', r.status === 200 && !!r.cc && !!r.body.mix.title && !!r.body.mix.cover && r.body.tracks.length >= 10, `${r.body?.mix?.title} n=${r.body?.tracks?.length}`);
  r = await get('action=playlist&id=36ea71a8-445e-41a4-82ab-6628c581535d');
  check('api playlist: header + tracks + total', r.status === 200 && !!r.cc && !!r.body.playlist.title && r.body.tracks.length > 0 && r.body.total >= r.body.tracks.length);
  const p0 = await get(`action=playlist&id=${BIG_PLAYLIST}&offset=0`);
  const p1 = await get(`action=playlist&id=${BIG_PLAYLIST}&offset=100`);
  check('api playlist: pages of 100', p0.body.tracks.length === 100 && p1.body.tracks.length === 100 && p0.body.total > 200 && p0.body.tracks[0].id !== p1.body.tracks[0].id, `total ${p0.body.total}`);
  r = await get('action=explore');
  check('api explore: link shelves + Cache-Control', r.status === 200 && !!r.cc && arr(r.body.sections) && r.body.sections.some((s) => s.kind === 'links' && s.items.length >= 10 && !!s.items[0].path), `${r.body?.sections?.length} shelves`);
  r = await get('action=page&path=pages/genre_hip_hop');
  check('api page: genre page shelves (playlists/albums/artists)', r.status === 200 && !!r.cc && ['playlists', 'albums', 'artists'].every((k) => r.body.sections.some((s) => s.kind === k)));
  for (const [name, q] of [
    ['track-mix', 'action=track-mix&id=abc'], ['artist-mix', 'action=artist-mix&id=1;2'], ['mix', 'action=mix&id=zz'],
    ['playlist', 'action=playlist&id=not-a-uuid'], ['page', 'action=page&path=../../etc/passwd'], ['page (other host path)', 'action=page&path=pages/a/b'],
  ]) check(`api ${name}: bad id -> 400`, (await get(q)).status === 400);
  check('api mix: unknown mix -> 404 (not a fake 200)', (await get('action=mix&id=0000000000000000000000000000ff')).status === 404);
  check('api playlist: huge offset is clamped, still 200', (await get(`action=playlist&id=${BIG_PLAYLIST}&offset=99999999`)).status === 200);
}

// ---- Browser ---------------------------------------------------------------------------------
const browser = await chromium.launch({ channel: 'chrome', args: ['--autoplay-policy=no-user-gesture-required'] })
  .catch(() => chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] }));
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
if (userToken) await ctx.route('**/api/music*', (r) => r.continue({ headers: { ...r.request().headers(), 'x-tidal-token': userToken } }));
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const M = (fn, arg) => page.evaluate(fn, arg);
const waitFor = async (fn, ms = 20000, arg) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = await page.evaluate(fn, arg).catch(() => null); if (v) return v; await page.waitForTimeout(250); }
  return page.evaluate(fn, arg).catch(() => null);
};
const shot = async (n) => { if (shots) await page.screenshot({ path: `${shots}/p9-${n}.png`, fullPage: true }); };

// 1. Empty history: Editors' picks + chips only.
await page.goto(base + '/music?musicdebug=1', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('app-music-home');
await page.waitForSelector('[data-section="picks"] app-music-album-card', { timeout: 15000 });
const pickCount = await page.locator('[data-section="picks"] app-music-album-card').count();
check("empty history: Editors' picks shows 6 albums", pickCount === 6, `${pickCount}`);
check('empty history: suggestion chips shown', (await page.locator('[data-section="chips"] button').count()) >= 6);
check('empty history: no personal sections', (await page.locator('[data-section="jumpBackIn"], [data-section="recent"], [data-section="mixes"], [data-section="songs"]').count()) === 0);
check('picks link to real album pages', ((await page.locator('[data-section="picks"] a[href^="/music/album/"]').first().getAttribute('href')) || '').match(/\/music\/album\/\d+/) !== null);
check('home title', /Stream Fiesta/.test(await page.title()));
await shot('home-empty');

// 2. Play 3 tracks (history logs a track after 10 s of play), natural end -> tracker completion.
await page.waitForFunction(() => !!window.__music);
const album = await (await fetch(`${api}/api/music?action=album&id=1550545`)).json();
const queue = album.tracks.slice(0, 5);
// Each of the first three tracks plays 11 s (history logs at 10 s) and then to its natural end (a completion, not a skip).
await M(({ q }) => window.__music.player.play(q[0], q), { q: queue });
for (let i = 0; i < 3; i++) {
  await waitFor(({ i }) => window.__music.player.index() === i && window.__music.player.position() >= 11, 40000, { i });
  if (i < 2) {
    await M(() => window.__music.player.seek(window.__music.player.duration() - 1.5));
    await waitFor(({ i }) => window.__music.player.index() === i + 1, 15000, { i });
  }
}
const hist = await M(() => window.__music.library.history().length);
check('three tracks logged to history', hist >= 3, `${hist}`);

// 3. Listening tracker: skip under 5 s, completion at the natural end.
const t3 = queue[2];
await M(({ t }) => window.__music.player.play(t, [t, ...[]]), { t: queue[3] });
await waitFor(() => window.__music.player.duration() > 0, 20000);
await page.waitForTimeout(1500); // < 5 s
await M(({ q }) => window.__music.player.play(q[4], q.slice(4)), { q: queue }); // replaces: a skip of queue[3] after ~1.5 s
await waitFor(() => window.__music.player.duration() > 0, 20000);
await M(() => window.__music.player.seek(window.__music.player.duration() - 2));
await waitFor(() => !window.__music.player.playing() || window.__music.player.position() < 5, 12000);
await page.waitForTimeout(2800); // tracker flushes after 2 s
const listening = await M(() => JSON.parse(localStorage.getItem('fiesta:music:listening') || 'null'));
const sig = (id) => listening?.tracks?.[String(id)];
check('tracker: a skip under 5 s records a skip', sig(queue[3].id)?.skipCount >= 1, JSON.stringify(sig(queue[3].id)));
check('tracker: a track played to its end records a completion', sig(queue[4].id)?.completionCount >= 1, JSON.stringify(sig(queue[4].id)));
check('tracker: artist affinity recorded (device-only key)', Object.keys(listening?.artists || {}).length >= 1);
await M(() => window.__music.player.stop());

// 4. Home with history.
await page.goto(base + '/music/album/1550545?musicdebug=1', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('app-music-track-row', { timeout: 15000 });
await page.goto(base + '/music?musicdebug=1', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('[data-section="jumpBackIn"]', { timeout: 15000 });
check('home: Jump back in lists the visited album', (await page.locator('[data-section="jumpBackIn"] app-music-album-card').count()) >= 1);
check('home: Recently played lists tracks', (await page.locator('[data-section="recent"] app-music-track-row').count()) >= 1);
await page.waitForSelector('[data-section="mixes"] app-music-playlist-card', { timeout: 30000 }).catch(() => {});
check("home: 'Mixes for you' shows track mixes", (await page.locator('[data-section="mixes"] app-music-playlist-card').count()) >= 1);
await page.waitForSelector('[data-section="songs"] app-music-track-row', { timeout: 30000 }).catch(() => {});
check('home: Recommended songs', (await page.locator('[data-section="songs"] app-music-track-row').count()) >= 1);
await page.waitForSelector('[data-section="albums"] app-music-album-card', { timeout: 30000 }).catch(() => {});
check('home: Recommended albums', (await page.locator('[data-section="albums"] app-music-album-card').count()) >= 1);
await page.waitForSelector('[data-section="artists"] app-music-artist-card', { timeout: 30000 }).catch(() => {});
check('home: Recommended artists', (await page.locator('[data-section="artists"] app-music-artist-card').count()) >= 1);
check("home: Editors' picks still shown", (await page.locator('[data-section="picks"] app-music-album-card').count()) === 6);
await shot('home-active');
for (const [key, sel] of [['jumpBackIn', 'jumpBackIn'], ['recent', 'recent'], ['mixes', 'mixes'], ['picks', 'picks']]) {
  await M(({ key }) => window.__music.settings.homeSections.set({ ...window.__music.settings.homeSections(), [key]: false }), { key });
  await page.waitForTimeout(300);
  check(`home: settings.homeSections.${key}=false hides the section`, (await page.locator(`[data-section="${sel}"]`).count()) === 0);
  await M(({ key }) => window.__music.settings.homeSections.set({ ...window.__music.settings.homeSections(), [key]: true }), { key });
}
await M(() => window.__music.settings.homeSections.set({ ...window.__music.settings.homeSections(), forYou: false }));
await page.waitForTimeout(300);
check('home: homeSections.forYou=false hides recommended songs/albums/artists',
  (await page.locator('[data-section="songs"], [data-section="albums"], [data-section="artists"]').count()) === 0);
await M(() => window.__music.settings.homeSections.set({ ...window.__music.settings.homeSections(), forYou: true }));

// 5. Mix page (from a home mix card).
const mixHref = await page.locator('[data-section="mixes"] a[href^="/music/mix/"]').first().getAttribute('href').catch(() => null);
await page.goto(base + (mixHref || `/music/mix/${MIX_ID}`) + '?musicdebug=1', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('[data-testid="mix-header"]', { timeout: 20000 });
await page.waitForSelector('app-music-track-row', { timeout: 20000 });
check('mix page: title, cover and tracks', (await page.locator('[data-testid="mix-header"] h1').innerText()).trim().length > 0
  && (await page.locator('[data-testid="mix-header"] img').count()) === 1 && (await page.locator('app-music-track-row').count()) >= 10);
check('mix page: document title', /\| Stream Fiesta$/.test(await page.title()) && !/^Mix \|/.test(await page.title()));
await page.getByRole('button', { name: 'Shuffle' }).click();
await waitFor(() => window.__music.player.track() !== null && window.__music.player.context()?.type === 'mix', 15000);
check('mix page: Shuffle plays the mix', await M(() => window.__music.player.context()?.type === 'mix' && window.__music.player.shuffle()));
await page.getByRole('button', { name: 'Play', exact: true }).first().click();
await M(() => window.__music.player.setShuffle(false));
await page.getByRole('button', { name: 'Play', exact: true }).first().click();
check('mix page: Play plays the mix in order (shuffle off)', await waitFor(() => window.__music.player.context()?.type === 'mix' && !window.__music.player.shuffle() && window.__music.player.index() === 0, 10000));
const likeBtn = page.locator('[data-testid="mix-header"] app-music-like-button button').first();
await likeBtn.click();
check('mix page: Like saves a mix favourite', (await M(() => window.__music.library.favorites().mixes.length)) === 1);
await likeBtn.click();
check('mix page: Like toggles off', (await M(() => window.__music.library.favorites().mixes.length)) === 0);
check('mix page: visit recorded for Jump back in', (await M(() => window.__music.library.activity().some((a) => a.kind === 'mix'))) === true);
await page.goto(base + '/music/mix/zz', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('text=This mix isn', { timeout: 10000 }).catch(() => {});
check('mix page: unknown mix shows a friendly message', (await page.locator('text=This mix isn').count()) === 1);
await M(() => window.__music?.player?.stop());

// 6. TIDAL playlist page.
await page.goto(base + `/music/playlist/${BIG_PLAYLIST}?musicdebug=1`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('[data-testid="playlist-header"]', { timeout: 20000 });
await page.waitForSelector('[data-testid="playlist-tracks"] app-music-track-row', { timeout: 20000 });
const first = await page.locator('[data-testid="playlist-tracks"] app-music-track-row').count();
check('playlist page: first page is 100 tracks', first === 100, `${first}`);
await page.getByRole('button', { name: 'Load more songs' }).click();
await waitFor(() => document.querySelectorAll('[data-testid="playlist-tracks"] app-music-track-row').length > 100, 15000);
const second = await page.locator('[data-testid="playlist-tracks"] app-music-track-row').count();
check('playlist page: Load more appends the next 100', second === 200, `${second}`);
await page.waitForSelector('[data-testid="playlist-recs"] app-music-track-row', { timeout: 30000 }).catch(() => {});
check('playlist page: Recommended songs shown', (await page.locator('[data-testid="playlist-recs"] app-music-track-row').count()) >= 1);
await page.getByRole('button', { name: 'Shuffle', exact: true }).first().click();
await waitFor(() => window.__music.player.context()?.type === 'playlist', 20000);
check('playlist page: Shuffle plays (all pages loaded first)', await M(() => window.__music.player.context()?.type === 'playlist' && window.__music.player.queue().length > 200), `queue ${await M(() => window.__music.player.queue().length)}`);
await M(() => window.__music.player.stop());
await page.getByRole('button', { name: 'Play', exact: true }).first().click();
check('playlist page: Play plays the playlist', await waitFor(() => window.__music.player.context()?.type === 'playlist' && !window.__music.player.shuffle(), 15000));
const plLike = page.locator('[data-testid="playlist-header"] app-music-like-button button').first();
await plLike.click();
check('playlist page: Like saves a playlist favourite', (await M(() => window.__music.library.favorites().playlists.length)) === 1);
await page.getByRole('button', { name: 'Save a copy' }).click();
await waitFor(() => window.__music.library.playlists().length === 1, 20000);
const copy = await M(() => { const p = window.__music.library.playlists()[0]; return { name: p?.name, n: p?.tracks.length }; });
check('playlist page: Save a copy creates a library playlist with all songs', copy.name === 'Hip-Hop Workout' && copy.n >= 200, JSON.stringify(copy));
check('playlist page: document title', /^Hip-Hop Workout \| Stream Fiesta$/.test(await page.title()), await page.title());
await shot('playlist');
await M(() => window.__music.player.stop());

// 7. Radio.
const radioSeed = queue[0];
const hist100 = await M(() => window.__music.library.history().slice(0, 100).map((h) => h.track.id));
await page.goto(base + '/music?musicdebug=1', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.__music);
await M(({ s }) => window.__music.player.startRadio({ kind: 'track', id: s.id, label: 'Radio: ' + s.title }), { s: radioSeed });
await waitFor(() => window.__music.player.queue().length >= 10, 20000);
const rq = await M(() => ({ ids: window.__music.player.queue().map((t) => t.id), label: window.__music.player.context()?.label, type: window.__music.player.context()?.type }));
check('radio: queue has >= 10 tracks', rq.ids.length >= 10, `${rq.ids.length}`);
check('radio: excludes the seed and the last 100 played', !rq.ids.includes(radioSeed.id) && !rq.ids.some((id) => hist100.includes(id)));
check("radio: context label 'Radio: <title>'", rq.type === 'radio' && rq.label === 'Radio: ' + radioSeed.title, rq.label);
const before = rq.ids.length;
await M(() => window.__music.player.playAt(window.__music.player.queue().length - 3));
await waitFor((n) => window.__music.player.queue().length > n, 20000, before);
const after = await M(() => window.__music.player.queue().length);
check('radio: refills automatically when <= 3 tracks remain', after > before, `${before} -> ${after}`);
const noDupes = await M(() => { const ids = window.__music.player.queue().map((t) => t.id); return new Set(ids).size === ids.length; });
check('radio: refill adds no duplicates', noDupes);
await M(() => window.__music.player.stopRadio());

// 8. Autoplay at the end of the queue.
const ap = queue[1];
await M(() => window.__music.settings.autoplay.set(true));
await M(({ t }) => window.__music.player.play(t, [t]), { t: ap });
await waitFor(() => window.__music.player.duration() > 0 && window.__music.player.playing(), 20000);
await M(() => window.__music.player.seek(window.__music.player.duration() - 1.5));
await waitFor(() => window.__music.player.queue().length > 1, 20000);
await page.waitForTimeout(2000);
const on = await M(() => ({ n: window.__music.player.queue().length, i: window.__music.player.index(), playing: window.__music.player.playing() }));
check('autoplay on: end of queue appends recommendations and keeps playing', on.n > 1 && on.i >= 1 && on.playing, JSON.stringify(on));
await M(() => window.__music.settings.autoplay.set(false));
await M(({ t }) => window.__music.player.play(t, [t]), { t: ap });
await waitFor(() => window.__music.player.duration() > 0 && window.__music.player.playing(), 20000);
await M(() => window.__music.player.seek(window.__music.player.duration() - 1.5));
await page.waitForTimeout(6000);
const off = await M(() => ({ n: window.__music.player.queue().length, playing: window.__music.player.playing() }));
check('autoplay off: playback stops at the end of the queue', off.n === 1 && !off.playing, JSON.stringify(off));
await M(() => window.__music.player.stop());

// 9. Explore.
await page.goto(base + '/music/explore?musicdebug=1', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('main h1:has-text("Explore")');
await page.waitForSelector('a[href*="page=pages"]', { timeout: 20000 });
const genres = await page.locator('a[href*="page=pages"]').count();
check('explore: genre/mood shelves render as links', genres >= 20, `${genres}`);
await page.locator('a:has-text("Hip-Hop")').first().click();
await page.waitForSelector('h1:has-text("Hip-Hop")', { timeout: 20000 });
await page.waitForSelector('app-music-playlist-card', { timeout: 20000 });
check('explore: drill-down shows the genre page shelves', /page=pages%2Fgenre_hip_hop|page=pages\/genre_hip_hop/.test(page.url()) && (await page.locator('app-music-playlist-card').count()) >= 5);
check('explore: drill-down document title', /^Hip-Hop \| Explore Music \| Stream Fiesta$/.test(await page.title()), await page.title());
await shot('explore-genre');
await page.goto(base + '/music/explore?page=' + encodeURIComponent('https://evil.example/x'), { waitUntil: 'domcontentloaded' });
await page.waitForSelector('a[href*="page=pages"]', { timeout: 20000 });
check('explore: a non-whitelisted ?page= is ignored (root shown)', (await page.locator('a[href*="page=pages"]').count()) >= 20);
const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await ctx2.route('**/api/music?*action=explore*', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ title: 'Explore', sections: [] }) }));
const p2 = await ctx2.newPage();
await p2.goto(base + '/music/explore', { waitUntil: 'domcontentloaded' });
await p2.waitForSelector('[data-testid="explore-unavailable"]', { timeout: 15000 });
check("explore: friendly \"isn't available right now\" state when TIDAL denies pages", /Explore isn't available right now/.test(await p2.locator('[data-testid="explore-unavailable"]').innerText()));
await ctx2.close();

// 10. Mobile layout.
const mob = await browser.newContext({ viewport: { width: 390, height: 800 }, isMobile: true, hasTouch: true });
const mp = await mob.newPage();
await mp.goto(base + '/music', { waitUntil: 'domcontentloaded' });
await mp.waitForSelector('[data-section="picks"] app-music-album-card', { timeout: 15000 });
check('mobile: home has no horizontal page scroll', await mp.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
await mp.goto(base + `/music/playlist/${BIG_PLAYLIST}`, { waitUntil: 'domcontentloaded' });
await mp.waitForSelector('[data-testid="playlist-header"]', { timeout: 20000 });
check('mobile: playlist page has no horizontal page scroll', await mp.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
await mob.close();

check('no uncaught page errors', errors.length === 0, errors.slice(0, 2).join(' | '));
await browser.close();
const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
