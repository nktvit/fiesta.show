// E2E for the music tab: search -> play -> keep playing across navigation ->
// seek -> next -> mobile layout.
//   node tools/e2e/music.mjs [baseUrl=http://localhost:4200] [--shots=dir]
//   --token-file=path   file holding a TIDAL user token; sent as X-Tidal-Token on
//                       every /api/music call so a deployed preview (which has
//                       no shared token, on purpose) plays FULL tracks.
// Locally, `npm run tidal:token` does the same through .env.local. With no
// user token the test still passes but plays 30 s previews (badge: Preview).
// Run from a dir whose node_modules has playwright(-core).
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright-core')); } catch { ({ chromium } = require('playwright')); }

const base = process.argv.find((a) => a.startsWith('http')) || 'http://localhost:4200';
const shots = (process.argv.find((a) => a.startsWith('--shots=')) || '').slice(8);
const tokenFile = (process.argv.find((a) => a.startsWith('--token-file=')) || '').slice(13);
const userToken = tokenFile ? (await import('node:fs')).readFileSync(tokenFile, 'utf8').trim() : '';
const withToken = async (c) => {
  if (userToken) await c.route('**/api/music*', (r) => r.continue({ headers: { ...r.request().headers(), 'x-tidal-token': userToken } }));
};
const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };

const browser = await chromium.launch({ channel: 'chrome', args: ['--autoplay-policy=no-user-gesture-required'] }).catch(() => chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] }));
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
await withToken(ctx);
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

const pos = () => page.evaluate(() => +(document.querySelector('input[aria-label="Seek"]')?.value ?? -1));
const waitPos = async (pred, ms = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const p = await pos(); if (pred(p)) return p; await page.waitForTimeout(250); } return await pos(); };

await page.goto(base + '/music', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('h1:has-text("Music")');
check('music page renders with suggestions', (await page.locator('button:has-text("Daft Punk")').count()) > 0);

await page.fill('input[name=q]', 'daft punk one more time');
await page.press('input[name=q]', 'Enter');
await page.waitForSelector('app-music-track-row', { timeout: 20000 });
check('search shows songs and puts ?q= in the URL', page.url().includes('q=daft') && (await page.locator('app-music-track-row').count()) >= 5);
check('artist link resolves to /music/artist/:id', ((await page.locator('app-music-track-row a[href^="/music/artist/"]').first().getAttribute('href')) || '').match(/\/music\/artist\/\d+/) !== null);
if (shots) await page.screenshot({ path: `${shots}/music-search.png` });

await page.locator('app-music-track-row button').first().click();
await page.waitForSelector('app-music-player-bar section', { timeout: 15000 });
const p1 = await waitPos((p) => p >= 3);
check('player bar appears and playback advances', p1 >= 3, `position ${p1}s`);
const badge = (await page.locator('app-music-player-bar span.uppercase').first().textContent().catch(() => '') || '').trim();
check('quality badge shown', badge.length > 0, badge);

// Keep playing while navigating client-side to the album.
await page.locator('app-music-track-row a[href^="/music/album/"]').first().click();
await page.waitForSelector('h1', { timeout: 15000 });
const before = await pos();
await page.waitForTimeout(2500);
const after = await pos();
check('album page opens', /\/music\/album\/\d+/.test(page.url()) && (await page.locator('app-music-track-row').count()) >= 5);
check('playback continues across navigation (no restart)', after > before && before >= p1, `${before}s -> ${after}s`);
if (shots) await page.screenshot({ path: `${shots}/music-album.png` });

// Seek via the slider.
await page.evaluate(() => { const el = document.querySelector('input[aria-label="Seek"]'); el.value = Math.min(200, +el.max - 5); el.dispatchEvent(new Event('input', { bubbles: true })); });
const target = await page.evaluate(() => Math.min(200, +document.querySelector('input[aria-label="Seek"]').max - 5));
const p2 = await waitPos((p) => p >= target + 2, 20000);
check('seek jumps and keeps playing', p2 >= target + 2 && p2 < target + 20, `${target}s -> ${p2}s`);

// Next track.
const titleBefore = (await page.locator('app-music-player-bar a span.truncate').first().textContent()).trim();
await page.click('button[aria-label="Next track"]');
await page.waitForFunction((t) => { const el = document.querySelector('app-music-player-bar a span.truncate'); return el && el.textContent.trim() !== t; }, titleBefore, { timeout: 10000 }).catch(() => {});
const titleAfter = (await page.locator('app-music-player-bar a span.truncate').first().textContent()).trim();
const p3 = await waitPos((p) => p >= 2 && p < 30);
check('next track switches and plays', titleAfter !== titleBefore && p3 >= 2, `"${titleBefore}" -> "${titleAfter}"`);

// Pause / resume.
await page.click('button[aria-label="Pause"]');
const frozen = await pos(); await page.waitForTimeout(1500);
check('pause holds position', (await pos()) - frozen < 1);
await page.click('button[aria-label="Play"]');
check('resume advances', (await waitPos((p) => p > frozen + 1.5, 8000)) > frozen + 1.5);

check('no uncaught page errors', errors.length === 0, errors.slice(0, 2).join(' | '));

// Mobile: tab bar has Music; mini player sits above it without overlap.
const m = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
await withToken(m);
const mp = await m.newPage();
await mp.goto(base + '/music?q=radiohead', { waitUntil: 'domcontentloaded' });
await mp.waitForSelector('app-music-track-row', { timeout: 20000 });
await mp.locator('app-music-track-row button').first().click();
await mp.waitForSelector('app-music-player-bar section', { timeout: 15000 });
const box = async (sel) => mp.locator(sel).first().boundingBox();
const bar = await box('app-music-player-bar section'), nav = await box('nav[aria-label="Primary"]');
check('mobile: Music tab in bottom nav', (await mp.locator('nav[aria-label="Primary"] a:has-text("Music")').count()) === 1);
check('mobile: mini player sits above the tab bar', bar && nav && bar.y + bar.height <= nav.y + 1, bar && nav ? `bar bottom ${Math.round(bar.y + bar.height)} <= nav top ${Math.round(nav.y)}` : 'no box');
if (shots) await mp.screenshot({ path: `${shots}/music-mobile.png` });

await browser.close();
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
