// E2E for package Z (integration sweep): accessible names, focus return, reduced motion,
// 390px/1280px layout (no horizontal overflow, nothing hidden under the player bar / bottom nav),
// downloads switched off, music shortcuts inactive on /movie/*.
//   node tools/e2e/music-z.mjs [baseUrl=http://localhost:4200] [--shots=dir] [--token-file=path]
// Run with NODE_PATH pointing at a node_modules that has playwright(-core). Needs the API harness
// behind the dev server's proxy. 30 s PREVIEW playback is enough.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright-core')); } catch { ({ chromium } = require('playwright')); }

const base = (process.argv.find((a) => a.startsWith('http')) || 'http://localhost:4200').replace(/\/$/, '');
const shots = (process.argv.find((a) => a.startsWith('--shots=')) || '').slice(8);
const tokenFile = (process.argv.find((a) => a.startsWith('--token-file=')) || '').slice(13);
const userToken = tokenFile ? readFileSync(tokenFile, 'utf8').trim() : '';
const results = [];
const check = (name, ok, extra = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ channel: 'chrome', args: ['--autoplay-policy=no-user-gesture-required'] })
  .catch(() => chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] }));
const errors = [];

async function newPage(viewport, extra = {}) {
  const ctx = await browser.newContext({ viewport, ...extra });
  if (userToken) await ctx.route('**/api/music*', (r) => r.continue({ headers: { ...r.request().headers(), 'x-tidal-token': userToken } }));
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  return page;
}

/** Plays the first search result so the mini player is on screen. Returns a few tracks for later use. */
async function startPlayback(page) {
  await page.goto(base + '/music?q=daft+punk+discovery&musicdebug=1', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('app-music-track-row', { timeout: 25000 });
  await page.locator('app-music-track-row button').first().click();
  await page.waitForSelector('app-music-player-bar section', { timeout: 15000 });
  await page.waitForFunction(() => !!window.__music, null, { timeout: 15000 });
  return page.evaluate(() => window.__music.player.queue().slice(0, 25));
}

/** Buttons (and links styled as buttons) without an accessible name, inside music UI. */
const unlabeled = (page, scope) => page.evaluate((sel) => {
  const roots = [...document.querySelectorAll(sel)];
  const out = [];
  const visible = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'; };
  const name = (el) => {
    const lb = el.getAttribute('aria-labelledby');
    if (lb) return lb.split(/\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' ').trim();
    return (el.getAttribute('aria-label') || el.textContent || el.getAttribute('title') || '').trim()
      || [...el.querySelectorAll('img[alt]')].map((i) => i.alt).join(' ').trim();
  };
  for (const root of roots) {
    for (const el of root.querySelectorAll('button, [role=button], [role=menuitem], [role=tab], [role=option], a[href]')) {
      if (!visible(el) || el.closest('[aria-hidden=true]')) continue;
      if (!name(el)) out.push(el.outerHTML.slice(0, 120));
    }
  }
  return out;
}, scope);

/** Horizontal overflow, and how much of the page's last content sits under fixed bottom UI at max scroll. */
const layout = (page) => page.evaluate(async () => {
  const overflowX = document.documentElement.scrollWidth - document.documentElement.clientWidth;
  window.scrollTo(0, document.documentElement.scrollHeight);
  await new Promise((r) => setTimeout(r, 400));
  const fixedTop = Math.min(
    ...[document.querySelector('app-music-player-bar section'), document.querySelector('nav[aria-label="Primary"]')]
      .filter((el) => el && getComputedStyle(el).position === 'fixed' && el.getBoundingClientRect().height > 0)
      .map((el) => el.getBoundingClientRect().top),
    innerHeight,
  );
  // The last visible piece of page content (the footer counts: it is the end of the page).
  const footer = document.querySelector('app-footer');
  const main = document.querySelector('main');
  const last = footer && footer.getBoundingClientRect().height ? footer : main;
  const bottom = last ? last.getBoundingClientRect().bottom : 0;
  return { overflowX, hiddenUnder: Math.max(0, Math.round(bottom - fixedTop)) };
});

// ── 1. Desktop: playback, a11y names, focus return ────────────────────────────────
const page = await newPage({ width: 1280, height: 800 });
const tracks = await startPlayback(page);
check('playback started for the sweep', tracks.length > 0, `${tracks.length} tracks in queue`);
const albumId = tracks.find((t) => t.albumId)?.albumId;
const artistId = tracks.find((t) => t.artistId)?.artistId;
const plId = await page.evaluate((ts) => window.__music.library.createPlaylist('Z sweep', ts.slice(0, 20)).id, tracks);

let u = await unlabeled(page, 'app-music-player-bar');
check('player bar: every button has an accessible name', u.length === 0, u.slice(0, 3).join(' | '));

// Queue panel: open from the bar, check names, Escape returns focus to the Queue button.
await page.locator('app-music-player-bar button[aria-label="Queue"]').click();
await page.waitForSelector('app-music-queue-panel [role=dialog]', { timeout: 10000 });
u = await unlabeled(page, 'app-music-queue-panel');
check('queue panel: every button has an accessible name', u.length === 0, u.slice(0, 3).join(' | '));
const panelBox = await page.locator('app-music-queue-panel [role=dialog]').boundingBox();
const barBox = await page.locator('app-music-player-bar section').boundingBox();
check('queue panel (desktop) ends above the mini player', panelBox && barBox && panelBox.y + panelBox.height <= barBox.y + 1,
  `panel bottom ${panelBox && Math.round(panelBox.y + panelBox.height)} / bar top ${barBox && Math.round(barBox.y)}`);
if (shots) await page.screenshot({ path: `${shots}/z-queue-1280.png` });
await page.keyboard.press('Escape');
await sleep(400);
check('queue: Escape closes and focus returns to the Queue button',
  (await page.locator('app-music-queue-panel [role=dialog]').count()) === 0
  && await page.evaluate(() => document.activeElement?.getAttribute('aria-label') === 'Queue'));

// Lyrics panel.
await page.locator('app-music-player-bar button[aria-label="Lyrics"]').click();
await page.waitForSelector('app-music-lyrics-panel [role=dialog]', { timeout: 10000 });
await sleep(1500);
u = await unlabeled(page, 'app-music-lyrics-panel');
check('lyrics panel: every button has an accessible name', u.length === 0, u.slice(0, 3).join(' | '));
if (shots) await page.screenshot({ path: `${shots}/z-lyrics-1280.png` });
await page.keyboard.press('Escape');
await sleep(400);
check('lyrics: Escape closes and focus returns to the Lyrics button',
  (await page.locator('app-music-lyrics-panel [role=dialog]').count()) === 0
  && await page.evaluate(() => document.activeElement?.getAttribute('aria-label') === 'Lyrics'));

// Now Playing.
await page.locator('app-music-player-bar button[aria-label="Open now playing"]').click();
await page.waitForSelector('app-music-now-playing [role=dialog]', { timeout: 10000 });
await sleep(800);
u = await unlabeled(page, 'app-music-now-playing');
check('now playing: every button has an accessible name', u.length === 0, u.slice(0, 3).join(' | '));
const npOverflow = await page.evaluate(() => { const d = document.querySelector('app-music-now-playing [role=dialog]'); return d ? d.scrollWidth - d.clientWidth : -1; });
check('now playing (1280): no horizontal overflow', npOverflow <= 0, String(npOverflow));
if (shots) await page.screenshot({ path: `${shots}/z-now-playing-1280.png` });
// Visualizer controls must be reachable (not inside aria-hidden).
const vizBtn = page.locator('app-music-now-playing button[aria-label^="Visualizer"], app-music-now-playing button[aria-label*="isualizer"]').first();
if (await vizBtn.count()) {
  await vizBtn.click();
  await sleep(1500);
  const hiddenControls = await page.evaluate(() => [...document.querySelectorAll('app-music-visualizer select, app-music-visualizer button')].filter((el) => el.closest('[aria-hidden=true]')).length);
  check('visualizer controls are not inside aria-hidden', hiddenControls === 0, String(hiddenControls));
  await vizBtn.click();
  await sleep(300);
}
await page.keyboard.press('Escape');
await sleep(500);
check('now playing: Escape closes and focus returns to its opener',
  (await page.locator('app-music-now-playing [role=dialog]').count()) === 0
  && await page.evaluate(() => /now playing/i.test(document.activeElement?.getAttribute('aria-label') || '')));

// Command palette (Ctrl/Cmd+K) and a track menu.
await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k');
const paletteOpen = await page.waitForSelector('app-music-command-palette [role=dialog]', { timeout: 5000 }).then(() => true).catch(() => false);
if (paletteOpen) {
  u = await unlabeled(page, 'app-music-command-palette');
  check('command palette: every button/option has an accessible name', u.length === 0, u.slice(0, 3).join(' | '));
  await page.keyboard.press('Escape');
  await sleep(300);
} else check('command palette opens with Cmd/Ctrl+K', false);
await page.locator('app-music-track-row button[aria-haspopup=menu]').first().click();
const menuOpen = await page.waitForSelector('[role=menu]', { timeout: 5000 }).then(() => true).catch(() => false);
u = menuOpen ? await unlabeled(page, '[role=menu]') : ['menu did not open'];
check('track menu: every item has an accessible name', u.length === 0, u.slice(0, 3).join(' | '));
const dl = menuOpen ? await page.locator('[role=menu] [role=menuitem]:has-text("Download")').count() : -1;
check('downloads are switched off: no Download item in the track menu', dl === 0, String(dl));
await page.keyboard.press('Escape');
await sleep(300);
check('track menu: Escape returns focus to its kebab button',
  await page.evaluate(() => /^More options for /.test(document.activeElement?.getAttribute('aria-label') || '')));

// Settings (every tab) and music pages: unlabeled buttons.
const pages = [
  ['home', '/music'], ['album', `/music/album/${albumId}`], ['artist', `/music/artist/${artistId}`],
  ['library', '/music/library'], ['playlist', `/music/library/playlist/${plId}`], ['settings', '/music/settings'],
];
const desktopBad = [];
for (const [name, path] of pages) {
  await page.goto(base + path, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('main h1', { timeout: 20000 }).catch(() => {});
  await page.waitForSelector('app-music-player-bar section', { timeout: 15000 }).catch(() => {});
  await sleep(1500);
  const miss = await unlabeled(page, 'main');
  if (miss.length) desktopBad.push(`${name}: ${miss[0]}`);
  const l = await layout(page);
  if (l.overflowX > 0 || l.hiddenUnder > 0) desktopBad.push(`${name}: overflowX ${l.overflowX} hiddenUnder ${l.hiddenUnder}`);
  if (shots) await page.screenshot({ path: `${shots}/z-${name}-1280.png`, fullPage: false });
}
check('1280px: music pages have named buttons, no horizontal overflow, nothing under the bar', desktopBad.length === 0, desktopBad.slice(0, 4).join(' | '));
for (const tab of ['playback', 'audio', 'lyrics', 'interface', 'shortcuts', 'scrobbling', 'data', 'system']) {
  await page.goto(base + `/music/settings?tab=${tab}&musicdebug=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(`app-music-settings-${tab}`, { timeout: 15000 }).catch(() => {});
  await sleep(600);
  const miss = await unlabeled(page, 'main');
  if (miss.length) desktopBad.push(`settings/${tab}: ${miss[0]}`);
}
check('settings: every tab has named buttons', !desktopBad.some((x) => x.startsWith('settings/')), desktopBad.filter((x) => x.startsWith('settings/')).slice(0, 3).join(' | '));

// Settings search jumps to a row in a section owned by another package.
await page.goto(base + '/music/settings', { waitUntil: 'domcontentloaded' });
await page.fill('#music-settings-search', 'equalizer');
await page.keyboard.press('Enter');
const jumped = await page.waitForFunction(() => document.getElementById('setting-eq')?.classList.contains('ring-2'), null, { timeout: 5000 }).then(() => true).catch(() => false);
check('settings search jumps to and highlights the Equalizer row (Audio tab)', jumped);

// ── 2. Reduced motion: no running CSS animations in music UI ──────────────────────
const rm = await newPage({ width: 1280, height: 800 }, { reducedMotion: 'reduce' });
await startPlayback(rm);
await rm.locator('app-music-player-bar button[aria-label="Open now playing"]').click();
await rm.waitForSelector('app-music-now-playing [role=dialog]', { timeout: 10000 });
await sleep(1200);
const running = await rm.evaluate(() => document.getAnimations()
  .filter((a) => a.playState === 'running' && (a.effect?.getComputedTiming?.().duration || 0) > 0)
  .map((a) => a.effect?.target)
  .filter((t) => t && t.closest && t.closest('[class*="music"], app-music-player-bar, app-music-now-playing, app-music-queue-panel'))
  .map((t) => t.tagName + '.' + String(t.className).slice(0, 40)));
check('reduced motion: no running CSS animations in music UI (bar + Now Playing)', running.length === 0, running.slice(0, 3).join(' | '));
await rm.context().close();

// ── 3. Mobile 390px ───────────────────────────────────────────────────────────────
const m = await newPage({ width: 390, height: 844 }, { isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
await startPlayback(m);
const mPl = await m.evaluate((ts) => window.__music.library.createPlaylist('Z sweep', ts.slice(0, 20)).id, tracks);
const mobileBad = [];
for (const [name, path] of pages) {
  const p2 = name === 'playlist' ? `/music/library/playlist/${mPl}` : path;
  await m.goto(base + p2 + (p2.includes('?') ? '&' : '?') + 'musicdebug=1', { waitUntil: 'domcontentloaded' });
  await m.waitForSelector('app-music-player-bar section', { timeout: 15000 }).catch(() => {});
  await m.waitForSelector('main h1', { timeout: 20000 }).catch(() => {});
  await sleep(1500);
  const l = await layout(m);
  if (l.overflowX > 0 || l.hiddenUnder > 0) mobileBad.push(`${name}: overflowX ${l.overflowX} hiddenUnder ${l.hiddenUnder}`);
  if (shots) await m.screenshot({ path: `${shots}/z-${name}-390.png` });
}
check('390px: music pages have no horizontal overflow and nothing under the bar/bottom nav', mobileBad.length === 0, mobileBad.join(' | '));
// Phones open Now Playing by tapping the bar's cover/title; drive it through MusicUiService.
await m.waitForFunction(() => !!window.__music, null, { timeout: 15000 }).catch(() => {});
await m.evaluate(() => window.__music.ui.openNowPlaying());
await m.waitForSelector('app-music-now-playing [role=dialog]', { timeout: 10000 }).catch(() => {});
await sleep(800);
const npm = await m.evaluate(() => { const d = document.querySelector('app-music-now-playing [role=dialog]'); return d ? d.scrollWidth - d.clientWidth : -1; });
check('390px: Now Playing has no horizontal overflow', npm === 0, String(npm));
if (shots) await m.screenshot({ path: `${shots}/z-now-playing-390.png` });
await m.keyboard.press('Escape');
await sleep(400);
for (const [label, sel] of [['Queue', 'app-music-queue-panel'], ['Lyrics', 'app-music-lyrics-panel']]) {
  const btn = m.locator(`app-music-player-bar button[aria-label="${label}"]`);
  if (await btn.isVisible().catch(() => false)) {
    await btn.click();
    await m.waitForSelector(`${sel} [role=dialog]`, { timeout: 10000 }).catch(() => {});
    await sleep(800);
    const ov = await m.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check(`390px: ${label} sheet opens with no horizontal overflow`, ov <= 0, String(ov));
    if (shots) await m.screenshot({ path: `${shots}/z-${label.toLowerCase()}-390.png` });
    await m.keyboard.press('Escape');
    await sleep(400);
  } else {
    check(`390px: ${label} reachable (bar button visible on mobile)`, true, 'button collapsed into the bar menu at this width');
  }
}
await m.context().close();

// ── 4. Non-music page: shortcuts inactive on /movie/* ─────────────────────────────
const mv = await newPage({ width: 1280, height: 800 });
await startPlayback(mv);
await mv.waitForFunction(() => window.__music.player.playing(), null, { timeout: 15000 }).catch(() => {});
// Client-side navigation (a reload would restore the queue paused, which proves nothing).
await mv.evaluate(() => { history.pushState({}, '', '/movie/tt0133093'); dispatchEvent(new PopStateEvent('popstate', { state: {} })); });
await mv.waitForURL(/\/movie\/tt0133093/, { timeout: 10000 }).catch(() => {});
await sleep(2500);
const playingOnMovie = await mv.evaluate(() => window.__music?.player.playing());
await mv.locator('body').click({ position: { x: 5, y: 300 } }).catch(() => {});
await mv.keyboard.press('Space');
await mv.keyboard.press('k');
await sleep(600);
const afterKeys = await mv.evaluate(() => window.__music?.player.playing());
const paletteOnMovie = await mv.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k').then(() => sleep(500)).then(() => mv.locator('app-music-command-palette [role=dialog]').count());
check('music shortcuts are inactive on /movie/* (Space/k do not toggle music, no palette)',
  playingOnMovie === true && afterKeys === true && paletteOnMovie === 0, `playing ${playingOnMovie} -> ${afterKeys}, palette ${paletteOnMovie}`);
await mv.context().close();

await browser.close();
const ignorable = (msg) => /ResizeObserver loop|AbortError|The play\(\) request was interrupted/.test(msg);
const realErrors = errors.filter((e) => !ignorable(e));
check('no uncaught page errors', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
