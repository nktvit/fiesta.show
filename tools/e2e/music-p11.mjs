// E2E for package P11: settings shell, Playback / Interface / System sections, in-page search.
//   node tools/e2e/music-p11.mjs [baseUrl=http://localhost:4211] [--shots=dir] [--token-file=path]
// Run with NODE_PATH pointing at a node_modules that has playwright(-core).
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright-core')); } catch { ({ chromium } = require('playwright')); }

const base = process.argv.find((a) => a.startsWith('http')) || 'http://localhost:4211';
const shots = (process.argv.find((a) => a.startsWith('--shots=')) || '').slice(8);
const tokenFile = (process.argv.find((a) => a.startsWith('--token-file=')) || '').slice(13);
const userToken = tokenFile ? readFileSync(tokenFile, 'utf8').trim() : '';
const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };

const launchArgs = { args: ['--autoplay-policy=no-user-gesture-required'] };
const browser = await chromium.launch({ channel: 'chrome', ...launchArgs }).catch(() => chromium.launch(launchArgs));
const errors = [];
const newPage = async (ctx) => {
  if (userToken) await ctx.route('**/api/music*', (r) => r.continue({ headers: { ...r.request().headers(), 'x-tidal-token': userToken } }));
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  return page;
};
const shot = async (page, name) => { if (shots) await page.screenshot({ path: `${shots}/music-p11-${name}.png` }); };
const dbg = (page) => page.waitForFunction(() => !!window.__music, null, { timeout: 15000 });
const stored = (page) => page.evaluate(() => { try { return JSON.parse(localStorage.getItem('fiesta:music:settings') || '{}'); } catch { return {}; } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const url = (p) => `${base}${p}${p.includes('?') ? '&' : '?'}musicdebug=1`;

const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await newPage(ctx);

// ── shell ───────────────────────────────────────────────────────────────────
await page.goto(url('/music/settings'), { waitUntil: 'domcontentloaded' });
await dbg(page);
await page.waitForSelector('[role=tablist] [role=tab]');
const labels = await page.locator('[role=tablist][aria-label="Settings sections"] [role=tab]').allTextContents();
// Downloads is hidden while MUSIC_DOWNLOADS_ENABLED is off (the shipped default), so eight tabs is also right.
check('tablist with the nine tabs in order (eight while downloads are switched off)',
  ['Playback|Audio|Lyrics|Interface|Shortcuts|Downloads|Scrobbling|Data|System', 'Playback|Audio|Lyrics|Interface|Shortcuts|Scrobbling|Data|System']
    .includes(labels.map((l) => l.trim()).join('|')), labels.join('|'));
check('title is "Music settings | Stream Fiesta"', (await page.title()) === 'Music settings | Stream Fiesta', await page.title());
check('default tab is Playback and selected', (await page.locator('[role=tab][aria-selected=true]').textContent())?.trim() === 'Playback');
{
  // Visitors never pass ?musicdebug=1, which is the only way the hidden Data tab appears.
  const flagged = page.url();
  await page.goto(base + '/music/settings', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[role=tab]', { timeout: 15000 });
  check('the Data tab is hidden for visitors (browser storage is not the permanent store)', (await page.locator('#music-settings-tab-data').count()) === 0
    && (await page.locator('[role=tab]').count()) > 3);
  await page.goto(base + '/music/settings?tab=data', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[role=tab]', { timeout: 15000 });
  check('?tab=data without the test flag falls back to Playback', (await page.locator('[role=tab][aria-selected=true]').textContent())?.trim() === 'Playback');
  await page.goto(flagged, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[role=tab]', { timeout: 15000 });
}
await shot(page, 'playback');

for (const [id, sel] of [['audio', 'app-music-settings-audio'], ['lyrics', 'app-music-settings-lyrics'], ['interface', 'app-music-settings-interface'],
  ['shortcuts', 'app-music-settings-shortcuts'], ['downloads', 'app-music-settings-downloads'], ['scrobbling', 'app-music-settings-scrobbling'],
  ['data', 'app-music-settings-data'], ['system', 'app-music-settings-system'], ['playback', 'app-music-settings-playback']]) {
  // The Downloads tab only exists while MUSIC_DOWNLOADS_ENABLED is on, and the Data tab is hidden for visitors.
  if ((id === 'downloads' || id === 'data') && (await page.locator(`#music-settings-tab-${id}`).count()) === 0) continue;
  await page.click(`#music-settings-tab-${id}`);
  await page.waitForSelector(sel, { timeout: 5000 }).catch(() => {});
  check(`tab ${id} renders ${sel} and updates ?tab=`, (await page.locator(sel).count()) === 1 && page.url().includes('tab=' + id));
}

await page.goto(url('/music/settings?tab=interface'), { waitUntil: 'domcontentloaded' });
await page.waitForSelector('app-music-settings-interface');
check('?tab=interface deep link selects Interface', (await page.locator('[role=tab][aria-selected=true]').textContent())?.trim() === 'Interface');
await page.waitForTimeout(500);
await page.goto(url('/music/settings'), { waitUntil: 'domcontentloaded' });
await page.waitForSelector('[role=tab][aria-selected=true]');
check('last tab remembered across reload (settings.lastSettingsTab)', (await page.locator('[role=tab][aria-selected=true]').textContent())?.trim() === 'Interface'
  && (await stored(page)).lastSettingsTab === 'interface');

await page.focus('#music-settings-tab-interface');
await page.keyboard.press('ArrowRight');
await page.waitForSelector('app-music-settings-shortcuts');
check('arrow keys move between tabs', (await page.locator('[role=tab][aria-selected=true]').textContent())?.trim() === 'Shortcuts');

// ── playback ────────────────────────────────────────────────────────────────
await page.goto(url('/music/settings?tab=playback'), { waitUntil: 'domcontentloaded' });
await dbg(page);
await page.waitForSelector('app-music-settings-playback');
const get = (k) => page.evaluate((key) => window.__music.settings[key](), k);
const switchOf = (id) => page.locator(`#setting-${id} [role=switch]`);

await page.selectOption('select[aria-label="Streaming quality"]', 'LOSSLESS');
check('streaming quality select updates the signal', (await get('quality')) === 'LOSSLESS');
const qOpts = await page.locator('select[aria-label="Streaming quality"] option').allTextContents();
check('quality offers Auto, Low, High, Lossless, Hi-Res', qOpts.join('|') === 'Auto|Low|High|Lossless|Hi-Res', qOpts.join('|'));
check('Hi-Res note about full session shown', (await page.locator('#setting-quality').textContent()).includes('Hi-Res needs a full session'));

for (const [id, key] of [['gapless', 'gapless'], ['autoplay', 'autoplay'], ['skipUnavailable', 'skipUnavailable'], ['exponentialVolume', 'exponentialVolume'],
  ['preservesPitch', 'preservesPitch'], ['sleepFadeOut', 'sleepFadeOut'], ['removeSilence', 'removeSilence']]) {
  const before = await get(key);
  await switchOf(id).click();
  const after = await get(key);
  check(`switch ${id} toggles settings.${key}`, after === !before && (await switchOf(id).getAttribute('aria-checked')) === String(after), `${before} -> ${after}`);
}
check('Remove silence row mentions the extra stream', (await page.locator('#setting-removeSilence').textContent()).includes('extra stream'));

await page.locator('input[aria-label="Crossfade seconds"]').fill('7');
check('crossfade slider 0-12 sets crossfadeSeconds', (await get('crossfadeSeconds')) === 7);
check('crossfade enabled in this browser', await page.locator('input[aria-label="Crossfade seconds"]').isEnabled());

await page.click('[role=group][aria-label="ReplayGain mode"] button:has-text("Album")');
check('ReplayGain Album', (await get('replayGainMode')) === 'album');
await page.click('[role=group][aria-label="ReplayGain mode"] button:has-text("Track")');
check('ReplayGain Track', (await get('replayGainMode')) === 'track');
await page.locator('input[aria-label="ReplayGain pre-amp in decibels"]').fill('-6');
check('pre-amp -6 dB', (await get('replayGainPreamp')) === -6);
await page.locator('input[aria-label="ReplayGain pre-amp in decibels"]').fill('15');
check('pre-amp +15 dB', (await get('replayGainPreamp')) === 15);
await page.selectOption('select[aria-label="Default speed"]', '1.5');
check('default speed 1.5', (await get('playbackRate')) === 1.5);

await page.waitForTimeout(500);
const st = await stored(page);
check('playback changes persisted under fiesta:music:settings',
  st.quality === 'LOSSLESS' && st.crossfadeSeconds === 7 && st.replayGainMode === 'track' && st.replayGainPreamp === 15 && st.playbackRate === 1.5
  && st.gapless === false && st.autoplay === true && st.exponentialVolume === true, JSON.stringify({ q: st.quality, x: st.crossfadeSeconds, r: st.replayGainMode }));
await page.reload({ waitUntil: 'domcontentloaded' });
await dbg(page);
await page.waitForSelector('app-music-settings-playback');
check('values survive reload and controls reflect them',
  (await page.locator('select[aria-label="Streaming quality"]').inputValue()) === 'LOSSLESS'
  && (await page.locator('input[aria-label="Crossfade seconds"]').inputValue()) === '7'
  && (await switchOf('autoplay').getAttribute('aria-checked')) === 'true');
await shot(page, 'playback-changed');

// ── interface ───────────────────────────────────────────────────────────────
await page.goto(url('/music/settings?tab=interface'), { waitUntil: 'domcontentloaded' });
await dbg(page);
await page.waitForSelector('app-music-settings-interface');
await page.selectOption('select[aria-label="Cover click action"]', 'album');
check('cover click action -> album', (await get('coverClickAction')) === 'album');
for (const k of ['closeOverlaysOnNavigate', 'backClosesOverlays', 'reduceBlur', 'dynamicColor', 'albumBackground', 'compactGrids', 'haptics', 'coverTilt', 'coverRound', 'nowPlayingLyrics', 'waveformSeekbar']) {
  const before = await get(k);
  await switchOf(k).click();
  check(`interface switch ${k} toggles`, (await get(k)) === !before);
}
for (const k of ['jumpBackIn', 'recent', 'mixes', 'forYou', 'playlists', 'picks']) {
  const before = await page.evaluate((key) => window.__music.settings.homeSections()[key], k);
  await switchOf('home-' + k).click();
  const now = await page.evaluate((key) => window.__music.settings.homeSections()[key], k);
  check(`home section toggle ${k}`, now === !before);
}
check('six home-section switches exist', (await page.locator('[id^="setting-home-"] [role=switch]').count()) === 6);
await page.waitForTimeout(500);
const st2 = await stored(page);
check('interface changes persisted', st2.coverClickAction === 'album' && st2.reduceBlur === true && st2.homeSections?.picks === false, JSON.stringify(st2.homeSections));
await shot(page, 'interface');

// ── system ──────────────────────────────────────────────────────────────────
await page.goto(url('/music/settings?tab=system'), { waitUntil: 'domcontentloaded' });
await dbg(page);
await page.waitForSelector('app-music-settings-system');
// seed an IndexedDB cache with data
await page.evaluate(async () => {
  await new Promise((res, rej) => {
    const r = indexedDB.open('fiesta-music-lyrics', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('x');
    r.onsuccess = () => {
      const tx = r.result.transaction('x', 'readwrite');
      tx.objectStore('x').put('a'.repeat(200000), 'k');
      tx.oncomplete = () => { r.result.close(); res(); };
      tx.onerror = () => rej(tx.error);
    };
    r.onerror = () => rej(r.error);
  });
});
await page.click('button:has-text("Refresh")');
await page.waitForTimeout(600);
const rows = await page.locator('[data-storage-row]').allTextContents();
check('localStorage grouped by area with sizes', rows.some((r) => r.includes('settings')) && /\d+(\.\d)? (B|KB)/.test(rows.join(' ')), rows.map((r) => r.replace(/\s+/g, ' ').trim()).join(' / '));
check('IndexedDB fiesta-music-* databases listed', (await page.locator('app-music-settings-system').textContent()).includes('fiesta-music-lyrics'));
check('API status pings /api/music and shows latency', await page.waitForFunction(() => /Online, \d+ ms|Unavailable/.test(document.querySelector('[data-api-status]')?.textContent || ''), null, { timeout: 15000 }).then(() => true).catch(() => false),
  (await page.locator('[data-api-status]').textContent()).replace(/\s+/g, ' ').trim());
check('version shown', ((await page.locator('[data-version]').textContent()) || '').trim().length > 0, (await page.locator('[data-version]').textContent()).trim());
await page.click('button:has-text("Clear caches")');
await page.waitForSelector('[data-freed]', { timeout: 10000 });
const dbsAfter = await page.evaluate(async () => (await indexedDB.databases()).map((d) => d.name).filter((n) => n?.startsWith('fiesta-music-lyrics')));
check('Clear caches deletes fiesta-music-lyrics and reports bytes freed', dbsAfter.length === 0, (await page.locator('[data-freed]').textContent()).trim());
check('Clear caches keeps settings', (await stored(page)).coverClickAction === 'album');
await shot(page, 'system');

// ── search ──────────────────────────────────────────────────────────────────
await page.goto(url('/music/settings?tab=system'), { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#music-settings-search');
await page.fill('#music-settings-search', 'crossfade');
await page.waitForSelector('[data-setting-result]');
const first = (await page.locator('[data-setting-result]').first().textContent()).replace(/\s+/g, ' ').trim();
check('search lists matching settings with their tab', first.includes('Crossfade') && first.includes('Playback'), first);
await shot(page, 'search');
await page.keyboard.press('Enter');
await page.waitForSelector('app-music-settings-playback');
await page.waitForFunction(() => document.getElementById('setting-crossfadeSeconds')?.classList.contains('ring-2'), null, { timeout: 5000 }).catch(() => {});
const hl = await page.evaluate(() => {
  const el = document.getElementById('setting-crossfadeSeconds');
  const r = el?.getBoundingClientRect();
  return { ring: !!el?.classList.contains('ring-2'), inView: !!r && r.top >= 0 && r.bottom <= innerHeight };
});
check('search jumps to Playback tab, scrolls to and highlights the row', page.url().includes('tab=playback') && hl.ring && hl.inView, JSON.stringify(hl));
await page.fill('#music-settings-search', 'vibration');
await page.waitForSelector('[data-setting-result]');
await page.locator('[data-setting-result]').first().click();
await page.waitForSelector('app-music-settings-interface');
await page.waitForFunction(() => document.getElementById('setting-haptics')?.classList.contains('ring-2'), null, { timeout: 5000 }).catch(() => {});
check('search by keyword jumps across tabs (vibration -> Interface haptics)', page.url().includes('tab=interface')
  && await page.evaluate(() => !!document.getElementById('setting-haptics')?.classList.contains('ring-2')));
await page.fill('#music-settings-search', 'zzzzqq');
check('no-match message', (await page.locator('#music-settings-results').textContent()).includes('No settings match'));

// ── mobile + crossfade unsupported ──────────────────────────────────────────
const mctx = await browser.newContext({ viewport: { width: 390, height: 800 }, hasTouch: true, isMobile: true });
const mpage = await newPage(mctx);
await mpage.addInitScript(() => {
  // emulate iOS: element volume is read-only
  const d = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'volume');
  Object.defineProperty(HTMLMediaElement.prototype, 'volume', { get: d.get, set() { /* read-only like iOS */ }, configurable: true });
});
await mpage.goto(url('/music/settings?tab=playback'), { waitUntil: 'domcontentloaded' });
await mpage.waitForSelector('app-music-settings-playback');
check('crossfade disabled with explanation when element volume is read-only',
  (await mpage.locator('input[aria-label="Crossfade seconds"]').isDisabled())
  && (await mpage.locator('#setting-crossfadeSeconds').textContent()).includes('not available on this device'));
check('mobile: no horizontal page scroll', await mpage.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), await mpage.evaluate(() => `${document.documentElement.scrollWidth}/${innerWidth}`));
await shot(mpage, 'mobile');

check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
await browser.close();
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
