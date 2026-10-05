// E2E for package P10: track row, track/card context menus, multi-select, keyboard shortcuts,
// shortcut rebinding (Settings > Shortcuts), command palette, track info, share.
//   node tools/e2e/music-p10.mjs [baseUrl=http://localhost:4210] [--shots=dir] [--token-file=path]
// Run with NODE_PATH pointing at a node_modules that has playwright(-core). Needs the API harness
// (PORT=3910 node tools/fiesta-proxy/local-test-server.mjs) behind the dev server's proxy. Without a
// user token playback is the 30 s PREVIEW, which is all these checks need.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright-core')); } catch { ({ chromium } = require('playwright')); }

const base = process.argv.find((a) => a.startsWith('http')) || 'http://localhost:4210';
// --downloads=on  expects the Download entries (MUSIC_DOWNLOADS_ENABLED = true); the default expects them hidden.
const downloadsOn = process.argv.includes('--downloads=on');
const shots = (process.argv.find((a) => a.startsWith('--shots=')) || '').slice(8);
const tokenFile = (process.argv.find((a) => a.startsWith('--token-file=')) || '').slice(13);
const userToken = tokenFile ? (await import('node:fs')).readFileSync(tokenFile, 'utf8').trim() : '';
const results = [];
const check = (name, ok, extra = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };
const shot = async (page, name) => { if (shots) await page.screenshot({ path: `${shots}/music-p10-${name}.png` }); };

const launchArgs = ['--autoplay-policy=no-user-gesture-required'];
const browser = await chromium.launch({ channel: 'chrome', args: launchArgs }).catch(() => chromium.launch({ args: launchArgs }));
const errors = [];
const newCtx = async (opts = {}) => {
  const c = await browser.newContext({ viewport: { width: 1280, height: 900 }, ...opts });
  if (userToken) await c.route('**/api/music*', (r) => r.continue({ headers: { ...r.request().headers(), 'x-tidal-token': userToken } }));
  return c;
};
const newPage = async (ctx) => {
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(e.message));
  return p;
};
const M = (page, fn, arg) => page.evaluate(fn, arg);
const wait = (page, ms) => page.waitForTimeout(ms);
const waitFor = async (page, fn, arg, timeout = 15000) => { try { await page.waitForFunction(fn, arg, { timeout }); return true; } catch { return false; } };
const dbg = (page) => page.waitForFunction(() => !!window.__music, null, { timeout: 15000 });
const press = async (page, key) => { await page.keyboard.press(key); await wait(page, 120); };

const ctx = await newCtx();
await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base }).catch(() => {});
const page = await newPage(ctx);
const QUERY = 'daft punk one more time';

async function fresh(path = '/music?musicdebug=1') {
  await page.goto(base + path, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('fiesta:music:')) localStorage.removeItem(k); });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await dbg(page);
}
async function search(q = QUERY) {
  await page.fill('input[name=q]', q);
  await page.press('input[name=q]', 'Enter');
  await page.waitForSelector('app-music-track-row', { timeout: 20000 });
}
const rows = () => page.locator('app-music-track-row');
const menu = () => page.locator('[role=menu]');
const menuLabels = () => menu().locator('[role=menuitem]').allInnerTexts().then((a) => a.map((s) => s.trim()));
const rowTitle = async (i) => ((await rows().nth(i).locator('button[data-cover]').getAttribute('aria-label')) || '').replace(/^(Play|Pause) /, '');
const closeMenu = async () => { if (await menu().count()) { await press(page, 'Escape'); await menu().waitFor({ state: 'detached', timeout: 3000 }).catch(() => {}); } };
const clickItem = async (id) => { await menu().waitFor({ timeout: 5000 }); await menu().locator(`[data-action="${id}"]`).click(); await wait(page, 150); };

// ═══ Track row ═══════════════════════════════════════════════════════════════
await fresh();
await search();
await shot(page, 'search');
const r0 = rows().first();
const count = await rows().count();
check('track row: like heart (app-music-like-button) and kebab "More options for <title>"',
  count >= 5 && (await r0.locator('app-music-like-button button').count()) === 1
  && ((await r0.locator('button[aria-label^="More options for "]').getAttribute('aria-label')) || '').endsWith(await rowTitle(0)));
check('track row: playing indicator absent until it is the current track', (await rows().nth(1).locator('[data-playing-indicator]').count()) === 0);
await r0.locator('button[data-cover]').click();
await page.waitForSelector('app-music-player-bar section', { timeout: 15000 });
await waitFor(page, () => window.__music.player.playing());
check('track row: current row shows the 3-bar indicator (animated while playing)', (await r0.locator('[data-playing-indicator][data-state=playing] svg animate').count()) >= 6);
await page.emulateMedia({ reducedMotion: 'reduce' });
const motionShown = await r0.locator('[data-playing-indicator] svg').evaluateAll((els) => els.map((e) => getComputedStyle(e).display));
check('track row: indicator is static under prefers-reduced-motion (animated svg hidden, static one shown)', motionShown.includes('none') && motionShown.includes('block'), motionShown.join(','));
await page.emulateMedia({ reducedMotion: 'no-preference' });
const kebabBox = await r0.locator('button[aria-label^="More options for "]').boundingBox();
check('track row: kebab touch target >= 40px', kebabBox && kebabBox.width >= 40 && kebabBox.height >= 40, `${kebabBox?.width}x${kebabBox?.height}`);

// ═══ Track menu: right-click, kebab, long-press ═══════════════════════════════
await rows().nth(2).click({ button: 'right', position: { x: 200, y: 20 } });
await menu().waitFor({ timeout: 3000 }).catch(() => {});
const labels = await menuLabels();
check('right-click opens the track menu with every item', ['Play next', 'Add to queue', 'Like', 'Add to playlist…', 'Start radio', 'Go to artist', 'Go to album', 'Track info', 'Share', 'Hide track'].every((l) => labels.includes(l)), labels.join(' | '));
check(downloadsOn ? 'Download is shown (switch on)' : 'Download is hidden while the public-downloads switch is off (default)', labels.includes('Download') === downloadsOn);
await shot(page, 'track-menu');
await closeMenu();
await rows().nth(2).locator('button[aria-label^="More options for "]').click();
await menu().waitFor({ timeout: 3000 }).catch(() => {});
check('kebab opens the same menu (aria-expanded true on the kebab)', JSON.stringify(await menuLabels()) === JSON.stringify(labels) && (await rows().nth(2).locator('button[aria-label^="More options for "]').getAttribute('aria-expanded')) === 'true');
await closeMenu();
await rows().nth(2).locator('button[aria-label^="More options for "]').focus();
check('closing the menu returns focus to the kebab', await page.evaluate(() => document.activeElement?.getAttribute('aria-label')?.startsWith('More options for ')));
const longPress = async (loc, sel) => loc.evaluate(async (el, s) => {
  const target = s ? el.querySelector(s) : el;
  const r = target.getBoundingClientRect();
  const init = { bubbles: true, pointerType: 'touch', pointerId: 7, isPrimary: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0 };
  target.dispatchEvent(new PointerEvent('pointerdown', init));
  await new Promise((res) => setTimeout(res, 650));
  target.dispatchEvent(new PointerEvent('pointerup', init));
}, sel);
await longPress(rows().nth(3), 'p.truncate, span.min-w-0');
check('long-press (500 ms, touch) on the row opens the same menu', (await menu().count()) === 1 && (await menuLabels()).includes('Track info'));
await closeMenu();
const shortPress = await rows().nth(3).evaluate(async (el) => {
  const r = el.getBoundingClientRect();
  const init = { bubbles: true, pointerType: 'touch', pointerId: 8, isPrimary: true, clientX: r.left + 100, clientY: r.top + 20, button: 0 };
  el.querySelector('div').dispatchEvent(new PointerEvent('pointerdown', init));
  await new Promise((res) => setTimeout(res, 200));
  el.querySelector('div').dispatchEvent(new PointerEvent('pointerup', init));
  return document.querySelectorAll('[role=menu]').length;
});
check('a short touch (200 ms) does not open the menu', shortPress === 0);

// ═══ Track menu actions ═══════════════════════════════════════════════════════
const t3 = await rowTitle(3);
const qBefore = await M(page, () => ({ n: window.__music.player.queue().length, i: window.__music.player.index() }));
await rows().nth(3).locator('button[aria-label^="More options for "]').click();
await clickItem('play-next');
const afterNext = await M(page, () => { const p = window.__music.player; return { n: p.queue().length, next: p.queue()[p.index() + 1]?.title }; });
check('Play next inserts the track right after the current one', afterNext.n === qBefore.n + 1 && afterNext.next === t3, `${qBefore.n} -> ${afterNext.n}, next="${afterNext.next}"`);
const t4 = await rowTitle(4);
await rows().nth(4).locator('button[aria-label^="More options for "]').click();
await clickItem('queue');
const afterAdd = await M(page, () => { const p = window.__music.player; return { n: p.queue().length, last: p.queue().at(-1)?.title }; });
check('Add to queue appends the track', afterAdd.n === afterNext.n + 1 && afterAdd.last === t4, `last="${afterAdd.last}"`);

await rows().nth(1).locator('button[aria-label^="More options for "]').click();
const likeLabel1 = (await menuLabels())[2];
await clickItem('like');
const likedTitle = await rowTitle(1);
const isLiked = () => M(page, (t) => window.__music.library.favorites().tracks.some((x) => x.title === t), likedTitle);
check('Like adds to favourites (menu said "Like")', likeLabel1 === 'Like' && (await isLiked()));
await rows().nth(1).locator('button[aria-label^="More options for "]').click();
const likeLabel2 = (await menuLabels())[2];
await clickItem('like');
check('menu now says "Unlike"; choosing it removes the like', likeLabel2 === 'Unlike' && !(await isLiked()));

await rows().nth(1).locator('button[aria-label^="More options for "]').click();
await clickItem('playlist');
check('Add to playlist… sets ui.addToPlaylist with that track', await M(page, (t) => window.__music.ui.addToPlaylist()?.[0]?.title === t, likedTitle));
await M(page, () => window.__music.ui.closeAddToPlaylist());

await rows().nth(1).locator('button[aria-label^="More options for "]').click();
await clickItem('radio');
await wait(page, 600);
const radio = await M(page, () => ({ radio: window.__music.player.radio(), toasts: window.__music.toast.toasts().map((t) => t.message) }));
check('Start radio calls player.startRadio (radio set, or a "Couldn\'t start radio" toast while P9 recommender is a stub)', radio.radio !== null || radio.toasts.some((m) => /radio/i.test(m)), JSON.stringify(radio));

await rows().nth(1).locator('button[aria-label^="More options for "]').click();
await clickItem('artist');
check('Go to artist navigates to /music/artist/:id', await waitFor(page, () => /\/music\/artist\/\d+/.test(location.pathname)), page.url());
await page.goBack(); await page.waitForSelector('app-music-track-row', { timeout: 15000 });
await rows().nth(1).locator('button[aria-label^="More options for "]').click();
await clickItem('album');
check('Go to album navigates to /music/album/:id', await waitFor(page, () => /\/music\/album\/\d+/.test(location.pathname)), page.url());
await page.waitForSelector('app-music-track-row', { timeout: 15000 });

await rows().nth(1).locator('button[aria-label^="More options for "]').click();
await clickItem('info');
const info = await page.locator('[role=dialog]:has-text("Track info")').innerText().catch(() => '');
check('Track info sets ui.trackInfo and shows title, artist, album, duration, quality and ids', await M(page, () => window.__music.ui.trackInfo() !== null) && /Title/.test(info) && /Duration/.test(info) && /Quality/.test(info) && /Track ID/.test(info) && /Album ID/.test(info));
await shot(page, 'track-info');
await press(page, 'Escape');
check('Escape closes the track info dialog', await M(page, () => window.__music.ui.trackInfo() === null));

// Share: clipboard fallback, then Web Share.
await page.evaluate(() => { Object.defineProperty(navigator, 'share', { value: undefined, configurable: true }); });
await rows().nth(1).locator('button[aria-label^="More options for "]').click();
await clickItem('share');
const clip = await page.evaluate(() => navigator.clipboard.readText()).catch(() => '');
const toastMsgs = await M(page, () => window.__music.toast.toasts().map((t) => t.message));
check('Share without navigator.share copies the absolute Fiesta URL and toasts "Link copied"', new RegExp('^' + base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/music/track/\\d+$').test(clip) && toastMsgs.includes('Link copied'), clip);
await page.evaluate(() => { window.__shared = null; Object.defineProperty(navigator, 'share', { value: async (d) => { window.__shared = d; }, configurable: true }); });
await rows().nth(1).locator('button[aria-label^="More options for "]').click();
await clickItem('share');
const shared = await M(page, () => window.__shared);
check('Share with navigator.share uses the Web Share API with the Fiesta URL', shared && /\/music\/track\/\d+$/.test(shared.url) && shared.title.length > 0, JSON.stringify(shared));

// Hide track (and undo).
await page.goBack(); await page.waitForSelector('app-music-track-row', { timeout: 15000 }).catch(() => {});
if (!(await rows().count())) await search();
const hideTitle = await rowTitle(1);
await rows().nth(1).locator('button[aria-label^="More options for "]').click();
await clickItem('hide');
const blocked = await M(page, (t) => window.__music.library.blocked().tracks.some((x) => x.title === t), hideTitle);
check('Hide track blocks it (library.block) and offers Undo', blocked && (await M(page, () => window.__music.toast.toasts().some((t) => t.action?.label === 'Undo'))));
await M(page, () => { const t = window.__music.toast.toasts().find((x) => x.message === 'Track hidden'); if (t) window.__music.toast.act(t.id); });
check('Undo unblocks it', !(await M(page, (t) => window.__music.library.blocked().tracks.some((x) => x.title === t), hideTitle)));

// ═══ Card menus ═══════════════════════════════════════════════════════════════
await page.goto(base + '/music/artist/8847?musicdebug=1', { waitUntil: 'domcontentloaded' });
await dbg(page);
await page.waitForSelector('app-music-album-card', { timeout: 20000 });
const card = page.locator('app-music-album-card').first();
await card.hover();
const cardKebab = card.locator('app-music-card-menu-button button');
check('album card has a "More options for <title>" kebab', ((await cardKebab.getAttribute('aria-label')) || '').startsWith('More options for '));
await cardKebab.click();
await menu().waitFor({ timeout: 3000 }).catch(() => {});
const cardLabels = await menuLabels();
check('album card menu: Play, Shuffle, Add to queue, Like, Add to playlist…, Start radio, Share, Pin, Hide', ['Play', 'Shuffle', 'Add to queue', 'Like', 'Add to playlist…', 'Start radio', 'Share', 'Pin', 'Hide album'].every((l) => cardLabels.includes(l)) && cardLabels.includes('Download') === downloadsOn, cardLabels.join(' | '));
await shot(page, 'card-menu');
// The menu is already open here, so the page is pinned: body.style.top holds -<scroll offset>.
const pinned = () => M(page, () => ({ cls: document.body.classList.contains('music-overlay-open'), top: document.body.style.top }));
const before = await pinned();
await page.mouse.move(640, 450);
await page.mouse.wheel(0, 400);
await wait(page, 300);
const afterWheel = await pinned();
check('menu open: page is locked (body.music-overlay-open) and does not scroll, the menu stays open',
  (await menu().count()) === 1 && before.cls && afterWheel.cls && before.top === afterWheel.top, JSON.stringify({ before, afterWheel }));
await page.keyboard.press('Escape');
await wait(page, 450);
const y0 = -parseFloat(before.top || '0');
check('closing the menu releases the page lock and restores the scroll position',
  (await menu().count()) === 0 && !(await pinned()).cls && Math.abs((await M(page, () => window.scrollY)) - y0) <= 1, JSON.stringify({ y0, y: await M(page, () => window.scrollY) }));
await card.hover();
await cardKebab.click();
await menu().waitFor({ timeout: 3000 }).catch(() => {});
await page.mouse.click(5, 5);
await wait(page, 200);
check('clicking outside closes the menu', (await menu().count()) === 0);
await card.hover();
await cardKebab.click();
await menu().waitFor({ timeout: 3000 }).catch(() => {});
const qn = await M(page, () => window.__music.player.queue().length);
await clickItem('queue');
check('album card "Add to queue" fetches the album tracks into the queue', await waitFor(page, (n) => window.__music.player.queue().length > n, qn));
await cardKebab.click(); await clickItem('like');
check('album card Like adds the album to favourites', await M(page, () => window.__music.library.favorites().albums.length === 1));
await cardKebab.click(); await clickItem('pin');
check('album card Pin pins the album', await M(page, () => window.__music.library.pins().length === 1));
await cardKebab.click(); await clickItem('playlist');
check('album card Add to playlist… opens the dialog with the album tracks', await waitFor(page, () => (window.__music.ui.addToPlaylist()?.length ?? 0) > 3));
await M(page, () => window.__music.ui.closeAddToPlaylist());
await cardKebab.click(); await clickItem('play');
check('album card Play starts playback from the album', await waitFor(page, () => window.__music.player.track() !== null && window.__music.player.context()?.type === 'album'));
// The other card kinds, opened through the same global host.
const kindLabels = await (async () => {
  const out = {};
  for (const k of ['artist', 'playlist', 'mix', 'userPlaylist']) {
    await page.evaluate(([kk]) => {
      const items = {
        artist: { kind: 'artist', data: { id: 8847, name: 'Daft Punk', picture: '' } },
        playlist: { kind: 'playlist', data: { uuid: '11111111-1111-1111-1111-111111111111', title: 'P', description: '', cover: '', creator: '', tracks: 1, duration: 1, lastUpdated: '' } },
        mix: { kind: 'mix', data: { id: 'abcdef12', title: 'M', subTitle: '', cover: '', type: 'x' } },
        userPlaylist: { kind: 'userPlaylist', data: { id: 'u', name: 'U', description: '', tracks: [], createdAt: 1, updatedAt: 1 } },
      };
      window.__music.ui.openContextMenu(items[kk], { x: 300, y: 200 }, undefined, 'card');
    }, [k]);
    await menu().waitFor({ timeout: 3000 }).catch(() => {});
    out[k] = await menuLabels();
    await closeMenu();
  }
  return out;
})();
const base5 = ['Play', 'Shuffle', 'Add to queue', 'Add to playlist…', 'Start radio', 'Share', 'Pin'];
check('artist / playlist / mix card menus carry Play, Shuffle, Add to queue, Like, Add to playlist…, Radio, Share, Pin (+ Hide for artists)',
  ['artist', 'playlist', 'mix'].every((k) => base5.every((l) => kindLabels[k].includes(l)) && kindLabels[k].includes('Like')) && kindLabels.artist.includes('Hide artist'), JSON.stringify(kindLabels));
check('visitor-playlist card menu has no Like and no Hide (they cannot be liked or blocked)', !kindLabels.userPlaylist.includes('Like') && !kindLabels.userPlaylist.some((l) => l.startsWith('Hide')) && kindLabels.userPlaylist.includes('Play'));

// ═══ Keyboard shortcuts (/music) ═══════════════════════════════════════════════
await fresh();
await M(page, async () => {
  const r = await fetch('/api/music?action=search&q=daft%20punk%20one%20more%20time').then((x) => x.json());
  await window.__music.player.play(r.tracks[0], r.tracks.slice(0, 8));
});
await waitFor(page, () => window.__music.player.playing() && window.__music.player.position() > 1, null, 20000);
await page.locator('body').click({ position: { x: 5, y: 400 } });
const st = () => M(page, () => { const p = window.__music.player; return { playing: p.playing(), pos: p.position(), vol: p.volume(), muted: p.muted(), shuffle: p.shuffle(), repeat: p.repeat(), title: p.track()?.title, index: p.index() }; });
const s0 = await st();
await press(page, 'Space');
check('Space toggles play/pause', (await st()).playing === false);
await press(page, 'Space');
check('Space resumes', (await st()).playing === true);
const pBefore = (await st()).pos;
await press(page, 'ArrowRight');
const pAfter = (await st()).pos;
check('ArrowRight seeks +10 s', pAfter - pBefore >= 8 && pAfter - pBefore <= 13, `${pBefore.toFixed(1)} -> ${pAfter.toFixed(1)}`);
await press(page, 'ArrowLeft');
const pBack = (await st()).pos;
check('ArrowLeft seeks -10 s', pAfter - pBack >= 8 && pAfter - pBack <= 12, `${pAfter.toFixed(1)} -> ${pBack.toFixed(1)}`);
await press(page, 'Shift+ArrowRight');
await wait(page, 400);
const s1 = await st();
check('Shift+ArrowRight plays the next track', s1.index === s0.index + 1 && s1.title !== s0.title, `${s0.title} -> ${s1.title}`);
await wait(page, 1200);
await press(page, 'Shift+ArrowLeft');
await wait(page, 500);
check('Shift+ArrowLeft goes to the previous track', (await st()).index === s0.index, `index ${(await st()).index}`);
await M(page, () => window.__music.player.setVolume(0.5));
await press(page, 'ArrowUp');
const v1 = (await st()).vol;
await press(page, 'ArrowDown'); await press(page, 'ArrowDown');
const v2 = (await st()).vol;
check('ArrowUp/ArrowDown change volume by 5 %', Math.abs(v1 - 0.55) < 0.011 && Math.abs(v2 - 0.45) < 0.011, `${v1} / ${v2}`);
await press(page, 'm');
const m1 = (await st()).muted; await press(page, 'm');
check('M toggles mute', m1 === true && (await st()).muted === false);
await press(page, 's');
const sh1 = (await st()).shuffle; await press(page, 's');
check('S toggles shuffle', sh1 === true && (await st()).shuffle === false);
await press(page, 'r');
check('R cycles repeat (off -> all)', (await st()).repeat === 'all'); await press(page, 'r'); await press(page, 'r');
check('R cycles back to off after all, one', (await st()).repeat === 'off');
await press(page, 'q');
const q1 = await M(page, () => window.__music.ui.panel());
await press(page, 'q');
check('Q opens then closes the queue panel', q1 === 'queue' && (await M(page, () => window.__music.ui.panel())) === null);
await press(page, 'l');
const l1 = await M(page, () => window.__music.ui.panel());
await press(page, 'l');
check('L toggles the lyrics panel', l1 === 'lyrics' && (await M(page, () => window.__music.ui.panel())) === null);
await press(page, 'q');
await press(page, 'Escape');
check('Escape closes the open overlay', (await M(page, () => window.__music.ui.panel())) === null);
await press(page, '/');
check("'/' focuses the search box", await page.evaluate(() => document.activeElement?.getAttribute('name') === 'q'));
await page.keyboard.type('mqs');
const typed = await M(page, () => ({ v: document.querySelector('input[name=q]').value, muted: window.__music.player.muted(), panel: window.__music.ui.panel(), shuffle: window.__music.player.shuffle() }));
check('shortcuts are not triggered while typing in an input', typed.v.endsWith('mqs') && !typed.muted && typed.panel === null && !typed.shuffle, JSON.stringify(typed));
await press(page, 'Escape');
check('Escape in the search box leaves the field', await page.evaluate(() => document.activeElement?.getAttribute('name') !== 'q'));
const pre = await M(page, () => window.__music.settings.visualizerPreset());
await press(page, ']');
const p1 = await M(page, () => window.__music.settings.visualizerPreset());
await press(page, '[');
const p2 = await M(page, () => window.__music.settings.visualizerPreset());
await press(page, '\\');
check("']' / '[' step the visualizer preset and '\\' is handled", p1 !== pre && p2 === pre, `${pre} -> ${p1} -> ${p2}`);
await press(page, '?');
check("'?' opens the shortcuts help", await M(page, () => window.__music.ui.shortcutsHelpOpen()) && (await page.locator('[role=dialog]:has-text("Keyboard shortcuts") kbd').count()) > 10);
await shot(page, 'help');
await press(page, 'Escape');
check('Escape closes the help', !(await M(page, () => window.__music.ui.shortcutsHelpOpen())));
await page.keyboard.press('Control+k'); await wait(page, 200);
check('Ctrl+K opens the command palette', await M(page, () => window.__music.ui.paletteOpen()));
await press(page, 'Escape');
await page.keyboard.press('Meta+k'); await wait(page, 200);
check('Cmd+K opens the command palette too', await M(page, () => window.__music.ui.paletteOpen()));
await press(page, 'Escape');
check('Escape closes the palette', !(await M(page, () => window.__music.ui.paletteOpen())));

// Routes: not on /movie/* and /tv; active elsewhere only while a track is loaded.
const nav = async (path) => { await page.evaluate((p) => { history.pushState({}, '', p); window.dispatchEvent(new PopStateEvent('popstate', { state: {} })); }, path); await wait(page, 400); };
await page.locator('body').click({ position: { x: 5, y: 400 } });
await M(page, () => window.__music.player.resume());
await nav('/tv');
const tv0 = (await st()).playing;
await press(page, 'Space');
check('shortcuts are NOT active on /tv', page.url().endsWith('/tv') && (await st()).playing === tv0);
await nav('/movie/550');
const mv0 = (await st()).playing;
await press(page, 'Space'); await press(page, 'm');
check('shortcuts are NOT active on /movie/:id', page.url().includes('/movie/550') && (await st()).playing === mv0 && (await st()).muted === false);
await nav('/about');
const ab0 = (await st()).playing;
await press(page, 'Space');
check('shortcuts ARE active on other pages while a track is loaded', (await st()).playing === !ab0);
await nav('/music');

// ═══ Settings > Shortcuts ═════════════════════════════════════════════════════
await fresh('/music/settings?tab=shortcuts&musicdebug=1');
await page.waitForSelector('[data-shortcut-row]', { timeout: 15000 });
const rowIds = await page.locator('[data-shortcut-row]').evaluateAll((els) => els.map((e) => e.getAttribute('data-shortcut-row')));
const keysOk = await page.locator('[data-shortcut-keys]').evaluateAll((els) => els.every((e) => e.querySelector('kbd')));
check('Settings > Shortcuts lists every action with its key', rowIds.length === 19 && keysOk && rowIds.includes('playPause') && rowIds.includes('visualizerCycle'), `${rowIds.length} rows`);
const keyText = (id) => page.locator(`[data-shortcut-keys="${id}"]`).innerText().then((s) => s.replace(/\s+/g, ' ').trim());
check('defaults shown: Space, Shift →, Ctrl/⌘ K, ?', (await keyText('playPause')) === 'Space' && /(Shift|⇧)\s*→/.test(await keyText('nextTrack')) && /(Ctrl|⌘)\s*K/.test(await keyText('palette')) && (await keyText('help')) === '?', await keyText('nextTrack'));
await shot(page, 'settings-shortcuts');
await page.locator('button[aria-label="Change shortcut for Toggle shuffle"]').click();
check('Change enters capture mode', (await page.locator('[data-shortcut-row="shuffle"]').innerText()).includes('Press a key'));
await page.keyboard.press('Shift');
await page.keyboard.press('x'); await wait(page, 150);
check('Change captures a new key (Toggle shuffle -> X)', (await keyText('shuffle')) === 'X');
check('rebinding persists in fiesta:music:shortcuts', await page.evaluate(() => JSON.parse(localStorage.getItem('fiesta:music:shortcuts') || '{}').shuffle?.key === 'x'));
await page.locator('button[aria-label="Change shortcut for Toggle repeat"]').click();
await page.keyboard.press('x'); await wait(page, 150);
const msg = (await page.locator('[data-shortcut-message]').innerText()).trim();
check('a conflicting key is reported (amber) and not applied', /already used by "Toggle shuffle"/.test(msg) && (await page.locator('[data-shortcut-message].text-amber-400').count()) === 1, msg);
await page.keyboard.press('Escape'); await wait(page, 100);
check('Escape cancels the capture; the conflicting action keeps its key', !(await page.locator('[data-shortcut-row="repeat"]').innerText()).includes('Press a key') && (await keyText('repeat')) === 'R');
await page.reload({ waitUntil: 'domcontentloaded' }); await dbg(page);
await page.waitForSelector('[data-shortcut-row]');
check('the binding survives a reload', (await keyText('shuffle')) === 'X');
await page.locator('body').click({ position: { x: 5, y: 600 } });
await page.keyboard.press('x'); await wait(page, 150);
const xShuffle = await M(page, () => window.__music.player.shuffle());
await page.keyboard.press('s'); await wait(page, 150);
check('new key works (X toggles shuffle on /music/settings), the old key (S) no longer does', xShuffle === true && (await M(page, () => window.__music.player.shuffle())) === true);
await page.locator('button[aria-label="Reset shortcut for Toggle shuffle"]').click(); await wait(page, 100);
check('per-action Reset restores the default key', (await keyText('shuffle')) === 'S');
await page.locator('button[aria-label="Change shortcut for Mute / Unmute"]').click();
await page.keyboard.press('n'); await wait(page, 100);
await page.getByRole('button', { name: 'Reset to defaults' }).click(); await wait(page, 100);
check('Reset to defaults restores everything', (await keyText('mute')) === 'M' && !(await page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('fiesta:music:shortcuts') || '{}')).length)));

// ═══ Command palette ══════════════════════════════════════════════════════════
await fresh();
await M(page, async () => {
  const r = await fetch('/api/music?action=search&q=daft%20punk%20one%20more%20time').then((x) => x.json());
  await window.__music.player.play(r.tracks[0], r.tracks.slice(0, 8));
});
await page.locator('body').click({ position: { x: 5, y: 400 } });
const combo = () => page.locator('[role=dialog] input[role=combobox]');
const opts = () => page.locator('[role=option]');
const optTexts = () => opts().allInnerTexts().then((a) => a.map((s) => s.replace(/\s+/g, ' ').trim()));
await page.keyboard.press('Control+k');
await combo().waitFor({ timeout: 5000 });
check('Ctrl+K opens a combobox dialog with the input focused', (await page.locator('[role=dialog]:has(input[role=combobox])').count()) === 1 && await page.evaluate(() => document.activeElement?.getAttribute('role') === 'combobox'));
await shot(page, 'palette');
await combo().fill('go to lib');
await wait(page, 150);
const o1 = await optTexts();
check('typing filters commands fuzzily ("go to lib" -> Go to Library first)', o1[0]?.startsWith('Go to Library'), o1.slice(0, 3).join(' | '));
await combo().fill('tgl shuf'); await wait(page, 150);
check('fuzzy: "tgl shuf" finds Toggle shuffle', (await optTexts()).some((t) => t.startsWith('Toggle shuffle')));
await combo().fill('sleep 30'); await wait(page, 150);
check('"sleep 30" finds Sleep timer 30 min', (await optTexts())[0]?.startsWith('Sleep timer 30 min'));
await combo().fill('open lyr'); await wait(page, 150);
check('"open lyr" finds Open lyrics…', (await optTexts())[0]?.startsWith('Open lyrics…'));
await combo().fill('go to'); await wait(page, 150);
await page.keyboard.press('ArrowDown'); await wait(page, 80);
const ad = await combo().getAttribute('aria-activedescendant');
check('ArrowDown moves the active option (aria-activedescendant)', ad === 'music-palette-option-1' && (await page.locator('#music-palette-option-1[aria-selected=true]').count()) === 1, ad);
await combo().fill('go to lib'); await wait(page, 150);
await page.keyboard.press('Enter'); await wait(page, 500);
check('Enter runs the command (Go to Library -> /music/library) and closes the palette', page.url().includes('/music/library') && !(await M(page, () => window.__music.ui.paletteOpen())), page.url());
await page.keyboard.press('Control+k'); await combo().waitFor();
const sh0 = await M(page, () => window.__music.player.shuffle());
await combo().fill('toggle shuffle'); await page.keyboard.press('Enter'); await wait(page, 500);
check('"Toggle shuffle" runs the playback command', (await M(page, () => window.__music.player.shuffle())) === !sh0);
await page.keyboard.press('Control+k'); await combo().waitFor();
await combo().fill('sleep timer 30'); await page.keyboard.press('Enter'); await wait(page, 500);
check('"Sleep timer 30 min" arms the sleep timer', await M(page, () => window.__music.player.sleep().endsAt !== null));
await page.keyboard.press('Control+k'); await combo().waitFor();
await combo().fill('open lyrics'); await page.keyboard.press('Enter'); await wait(page, 500);
check('"Open lyrics…" opens the lyrics panel', (await M(page, () => window.__music.ui.panel())) === 'lyrics');
await page.keyboard.press('Escape'); await wait(page, 100);
// Live search.
await page.keyboard.press('Control+k'); await combo().waitFor();
await combo().fill('daft punk');
const gotTracks = await waitFor(page, () => document.querySelectorAll('[role=group][aria-label=Tracks] [role=option]').length > 0, null, 20000);
const secs = await page.locator('[role=group]').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
check('typing a query also shows live music results (Tracks / Albums / Artists)', gotTracks && secs.includes('Tracks') && secs.includes('Albums') && secs.includes('Artists'), secs.join(','));
await shot(page, 'palette-search');
const trackIdx = await page.locator('[role=group][aria-label=Tracks] [role=option]').first().getAttribute('id');
const trackTitle = (await page.locator('[role=group][aria-label=Tracks] [role=option]').first().locator('span.truncate').first().innerText()).trim();
const target = +trackIdx.replace('music-palette-option-', '');
for (let i = 0; i < target; i++) await page.keyboard.press('ArrowDown');
await page.keyboard.press('Enter'); await wait(page, 800);
check('Enter on a track result plays it', (await M(page, () => window.__music.player.track()?.title)) === trackTitle, trackTitle);
await page.keyboard.press('Control+k'); await combo().waitFor();
await combo().fill('daft punk');
await waitFor(page, () => document.querySelectorAll('[role=group][aria-label=Artists] [role=option]').length > 0, null, 20000);
await page.locator('[role=group][aria-label=Artists] [role=option]').first().click(); await wait(page, 600);
check('choosing an artist result navigates to /music/artist/:id', /\/music\/artist\/\d+/.test(page.url()), page.url());
// Settings mode.
await page.keyboard.press('Control+k'); await combo().waitFor();
await combo().fill('>'); await wait(page, 200);
const settingOpts = await optTexts();
const statusText = (await page.locator('[role=listbox]').innerText()).trim();
if (settingOpts.length) {
  const first = settingOpts[0];
  await combo().fill('> ' + first.split(' ')[0]); await wait(page, 200);
  await page.keyboard.press('Enter'); await wait(page, 600);
  check("'>' prefix searches the settings registry and navigates to /music/settings?tab=…", /\/music\/settings\?tab=\w+/.test(page.url()), page.url());
} else {
  check("'>' prefix switches to settings mode (registry is still P11's empty stub: empty state shown)", /No settings/i.test(statusText), statusText);
  console.log('NOTE  MUSIC_SETTINGS_REGISTRY is empty at test time, so settings-result navigation to /music/settings?tab=… could not be exercised end to end.');
  await page.keyboard.press('Escape');
}
await page.keyboard.press('Control+k'); await combo().waitFor();
await page.keyboard.press('Escape'); await wait(page, 150);
check('Escape closes the palette (dialog gone)', (await combo().count()) === 0 && !(await M(page, () => window.__music.ui.paletteOpen())));

// ═══ Multi-select ═════════════════════════════════════════════════════════════
await fresh();
await search();
const cbVisible = async (i) => rows().nth(i).locator('input[type=checkbox]').evaluate((e) => getComputedStyle(e.closest('label')).opacity);
await rows().nth(0).hover();
check('checkbox appears on row hover (hidden when not hovered)', (await cbVisible(0)) === '1' && (await cbVisible(5)) === '0');
await rows().nth(0).locator('input[type=checkbox]').focus();
check('checkbox is reachable and visible on keyboard focus', (await cbVisible(0)) === '1');
const bar = page.locator('section[aria-label="Selected tracks"]');
const ctrl = process.platform === 'darwin' ? 'Meta' : 'Control';
await rows().nth(0).locator('p').first().click({ modifiers: [ctrl] });
check('Ctrl/Cmd-click toggles selection and shows the bar ("1 selected")', (await bar.locator('[data-selection-count]').innerText()).trim() === '1 selected');
check('once selected, every row shows its checkbox', (await cbVisible(6)) === '1');
await rows().nth(3).locator('p').first().click({ modifiers: ['Shift'] });
check('Shift-click selects the range (4 selected)', (await bar.locator('[data-selection-count]').innerText()).trim() === '4 selected');
await rows().nth(1).locator('p').first().click({ modifiers: [ctrl] });
check('Ctrl/Cmd-click again deselects one (3 selected)', (await bar.locator('[data-selection-count]').innerText()).trim() === '3 selected');
await shot(page, 'selection');
const barButtons = await bar.locator('button').allInnerTexts();
check('selection bar has Play, Play next, Add to queue, Like, Add to playlist, Clear (Download only when the switch is on)', ['Play', 'Play next', 'Add to queue', 'Like', 'Add to playlist', 'Clear'].every((b) => barButtons.map((s) => s.trim()).includes(b)) && barButtons.map((s) => s.trim()).includes('Download') === downloadsOn, barButtons.join('|'));
await rows().nth(2).click({ button: 'right', position: { x: 200, y: 20 } });
await menu().waitFor({ timeout: 3000 }).catch(() => {});
const bulk = await menuLabels();
check('right-click on a selected row opens the bulk menu', bulk.includes('Like all') && bulk.includes('Clear selection') && !bulk.includes('Track info'), bulk.join('|'));
await closeMenu();
await bar.getByRole('button', { name: 'Add to playlist' }).click();
check('selection bar Add to playlist passes all selected tracks', (await M(page, () => window.__music.ui.addToPlaylist()?.length)) === 3);
await M(page, () => window.__music.ui.closeAddToPlaylist());
const likes0 = await M(page, () => window.__music.library.favorites().tracks.length);
await bar.getByRole('button', { name: 'Like', exact: true }).click(); await wait(page, 150);
check('selection bar Like likes them all and clears the selection', (await M(page, () => window.__music.library.favorites().tracks.length)) === likes0 + 3 && (await bar.count()) === 0);
await rows().nth(0).locator('p').first().click({ modifiers: [ctrl] });
await rows().nth(2).locator('p').first().click({ modifiers: [ctrl] });
const qSel = await M(page, () => window.__music.player.queue().length);
await bar.getByRole('button', { name: 'Add to queue' }).click(); await wait(page, 150);
check('selection bar Add to queue appends the selected tracks', (await M(page, () => window.__music.player.queue().length)) === qSel + 2);
await rows().nth(0).locator('p').first().click({ modifiers: [ctrl] });
await rows().nth(1).locator('p').first().click({ modifiers: [ctrl] });
const pn0 = await rowTitle(0);
await bar.getByRole('button', { name: 'Play next' }).click(); await wait(page, 150);
check('selection bar Play next inserts them after the current track', await M(page, (t) => { const p = window.__music.player; return p.queue()[p.index() + 1]?.title === t; }, pn0));
await rows().nth(0).locator('p').first().click({ modifiers: [ctrl] });
await bar.getByRole('button', { name: 'Clear', exact: true }).click(); await wait(page, 100);
check('Clear empties the selection and hides the bar', (await bar.count()) === 0);
await rows().nth(0).locator('p').first().click({ modifiers: [ctrl] });
await press(page, 'Escape');
check('Escape also clears the selection', (await bar.count()) === 0);
// Touch: long-press the cover enters select mode.
await longPress(rows().nth(4), 'button[data-cover]');
await wait(page, 150);
check('long-press on the cover (touch) enters select mode', (await bar.locator('[data-selection-count]').innerText().catch(() => '')).trim() === '1 selected' && (await menu().count()) === 0);
await bar.getByRole('button', { name: 'Clear', exact: true }).click();
// Play button still plays with no selection.
await rows().nth(1).locator('button[data-cover]').click();
check('the cover play button still plays (and does not select)', await waitFor(page, () => window.__music.player.playing()) && (await bar.count()) === 0);

// ═══ Phone layout ═════════════════════════════════════════════════════════════
const mctx = await newCtx({ viewport: { width: 390, height: 780 }, hasTouch: true, isMobile: true });
const mp = await newPage(mctx);
await mp.goto(base + '/music?musicdebug=1&q=' + encodeURIComponent(QUERY), { waitUntil: 'domcontentloaded' });
await dbg(mp);
await mp.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('fiesta:music:')) localStorage.removeItem(k); });
await mp.fill('input[name=q]', QUERY); await mp.press('input[name=q]', 'Enter');
await mp.waitForSelector('app-music-track-row', { timeout: 20000 });
await mp.locator('app-music-track-row').first().locator('button[aria-label^="More options for "]').tap();
await mp.locator('[role=menu]').waitFor({ timeout: 3000 }).catch(() => {});
await mp.waitForTimeout(450); // the sheet slides up for ~260 ms
const sheet = await mp.locator('[role=menu]').evaluate((e) => { const r = e.getBoundingClientRect(); const items = [...e.querySelectorAll('[role=menuitem]')].map((i) => i.getBoundingClientRect().height); return { bottom: Math.round(r.bottom), vh: innerHeight, left: Math.round(r.left), w: Math.round(r.width), minH: Math.min(...items) }; });
check('phone: the menu is a bottom action sheet with >= 40px items', sheet.bottom === sheet.vh && sheet.left === 0 && sheet.w === 390 && sheet.minH >= 40, JSON.stringify(sheet));
await shot(mp, 'phone-sheet');
await mp.keyboard.press('Escape');
const hs = await mp.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
check('phone: no horizontal page scroll with the new row', hs);
await mctx.close();

// ═══ Wrap up ═════════════════════════════════════════════════════════════════
const real = errors.filter((e) => !/NG0|movie|tmdb|apikey|Failed to fetch|ResizeObserver|Http failure|Unauthorized/i.test(e));
check('no uncaught page errors', real.length === 0, real.slice(0, 3).join(' || '));
await browser.close();
const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
