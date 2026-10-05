// E2E for package P7 (library data): import wizard, export menu, backup/restore, settings export/import,
// reset, blocked items, shared-playlist page.
//   node tools/e2e/music-p7.mjs [baseUrl=http://localhost:4207] [--shots=dir] [--token-file=path]
// Run with NODE_PATH pointing at a node_modules that has playwright(-core).
// Import matching uses routed /api/music search + tracks responses (no TIDAL dependency); the
// "player skips blocked" check uses the real API harness behind the dev server (30 s PREVIEW is fine).
import { createRequire } from 'node:module';
import { deflateRawSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright-core')); } catch { ({ chromium } = require('playwright')); }

const base = process.argv.find((a) => a.startsWith('http')) || 'http://localhost:4207';
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
const shot = async (page, name) => { if (shots) await page.screenshot({ path: `${shots}/music-p7-${name}.png` }); };
const dbg = (page) => page.waitForFunction(() => !!window.__music, null, { timeout: 15000 });

// ── fake catalogue ──────────────────────────────────────────────────────────
const mk = (id, title, artist, extra = {}) => ({
  id, title, artist, artistId: 6000 + id, artists: [{ id: 6000 + id, name: artist }], album: 'Alb ' + id, albumId: 7000 + id,
  cover: '', duration: 180 + id % 7, explicit: false, trackNumber: 1, quality: 'LOSSLESS', ...extra,
});
const DB = [
  mk(9001, 'Alpha, Song', 'Ann'), mk(9002, 'Beta Line', 'Bob'), mk(9003, 'Gamma Remastered', 'Gus', { isrc: 'GBX000000003' }),
  mk(9004, 'Epsilon', 'Eve'), mk(9005, 'Zeta', 'Zed'),
];
const ALBUMS = [{ id: 7001, title: 'Disc One', artist: 'Ann', cover: '', year: '2020', tracks: 9, duration: 1, quality: '' }];
const ARTISTS = [{ id: 6001, name: 'Ann', picture: '' }];
let inflight = 0; let maxInflight = 0; let searchDelay = 120; let tracksMode = 'ok';
const musicRoutes = async (ctx) => {
  await ctx.route('**/api/music?*', async (route) => {
    const u = new URL(route.request().url());
    const action = u.searchParams.get('action');
    if (action === 'search') {
      inflight++; maxInflight = Math.max(maxInflight, inflight);
      await new Promise((r) => setTimeout(r, searchDelay));
      inflight--;
      const q = (u.searchParams.get('q') || '').toLowerCase();
      const tracks = DB.filter((t) => q.includes(t.title.toLowerCase().split(' ')[0].replace(',', '')));
      return route.fulfill({ json: { tracks, albums: q.includes('disc one') ? ALBUMS : [], artists: q.trim() === 'ann' ? ARTISTS : [] } });
    }
    if (action === 'tracks') {
      if (tracksMode === 'fail') return route.fulfill({ status: 501, json: { error: 'not_implemented' } });
      const ids = (u.searchParams.get('ids') || '').split(',').map(Number);
      return route.fulfill({ json: DB.filter((t) => ids.includes(t.id)) });
    }
    return route.continue();
  });
};
const bigCsv = 'Track Name,Artist Name(s)\n' + Array.from({ length: 40 }, (_, i) => `Filler ${i},Nobody`).join('\n') + '\n';
const fixtureCsv = '﻿"Track URI","Track Name","Album Name","Artist Name(s)","ISRC"\n'
  + '"spotify:track:1","Alpha, Song","Alb","Ann, Bob",""\n'
  + '"spotify:track:2","Beta\nLine","Alb","Bob",""\n'
  + '"spotify:track:3","Gamma","Alb","Someone",GB-X00-00-00003\n'
  + '"spotify:track:4","Nonexistent One","Alb","Nobody",""\n'
  + '"spotify:track:5","Nonexistent Two","Alb","Nobody",""\n'
  + '"spotify:track:6","Epsilon (Live)","Alb","Eve",""\n';
const libraryCsv = 'Type,Track Name,Artist Name,Album\ntrack,Alpha Song,Ann,Alb\nalbum,Disc One,Ann,Disc One\nartist,,Ann,\n';
const buf = (s, name) => ({ name, mimeType: 'text/csv', buffer: Buffer.from(s) });

// ════════════════════════════════════════════════════════════════════════════
// Context A: routed catalogue (import wizard, shared page, export menu)
// ════════════════════════════════════════════════════════════════════════════
const ctxA = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
await musicRoutes(ctxA);
const a = await newPage(ctxA);
await a.goto(base + '/music/settings?tab=data&musicdebug=1', { waitUntil: 'domcontentloaded' });
await dbg(a);
await a.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('fiesta:music:')) localStorage.removeItem(k); });
await a.reload({ waitUntil: 'domcontentloaded' });
await dbg(a);

await a.click('[data-testid=open-import]');
const dlg = a.locator('[role=dialog]');
await dlg.waitFor();
check('import dialog opens from Settings > Data (ui.importOpen)', await a.evaluate(() => window.__music.ui.importOpen()));
const fileIn = a.locator('input[type=file][aria-label="Choose a file to import"]');

// Cancel flow on a 40-row file.
searchDelay = 300;
await fileIn.setInputFiles(buf(bigCsv, 'big.csv'));
await dlg.locator('[data-testid=detected-format]').waitFor();
check('detected format shown (generic CSV, 40 items)', /CSV/.test(await dlg.locator('[data-testid=detected-format]').innerText()) && /40 items/.test(await dlg.locator('[data-testid=detected-count]').innerText()));
await dlg.getByRole('button', { name: 'Start import' }).click();
await a.waitForFunction(() => { const m = /Matching (\d+)\/40/.exec(document.querySelector('[data-testid=import-progress-text]')?.textContent || ''); return m && +m[1] >= 1; }, null, { timeout: 15000 });
const progressText = (await dlg.locator('[data-testid=import-progress-text]').innerText()).trim();
check('progress bar text "Matching n/40" with Cancel', /^Matching \d+\/40$/.test(progressText) && (await dlg.getByRole('button', { name: 'Cancel' }).count()) === 1 && (await dlg.locator('[role=progressbar]').count()) === 1, progressText);
await shot(a, 'import-progress');
await dlg.getByRole('button', { name: 'Cancel' }).click();
await dlg.getByRole('button', { name: 'Start import' }).waitFor();
check('Cancel stops matching and creates nothing', (await a.evaluate(() => window.__music.library.playlists().length)) === 0);

// Full flow on the fixture.
searchDelay = 120; maxInflight = 0;
await dlg.getByRole('button', { name: 'Choose another file' }).click();
await fileIn.setInputFiles(buf(fixtureCsv, 'fixture-export.csv'));
await dlg.locator('[data-testid=detected-format]').waitFor();
check('detected format shown (Exportify CSV, 6 items, quoted newline kept in one row)', /Exportify CSV/.test(await dlg.locator('[data-testid=detected-format]').innerText()) && /6 items/.test(await dlg.locator('[data-testid=detected-count]').innerText()));
await a.fill('#music-import-name', 'Imported mix');
await dlg.getByRole('button', { name: 'Start import' }).click();
await dlg.locator('[data-testid=import-result]').waitFor({ timeout: 20000 });
const resultText = (await dlg.locator('[data-testid=import-result]').innerText()).trim();
check('result: playlist created with matched tracks', resultText === 'Created "Imported mix" with 4 tracks.', resultText);
const pl = await a.evaluate(() => window.__music.library.playlists().map((p) => ({ name: p.name, ids: p.tracks.map((t) => t.id) })));
check('ISRC match + fuzzy match + comma/newline titles resolved, order kept', pl.length === 1 && JSON.stringify(pl[0].ids) === JSON.stringify([9001, 9002, 9003, 9004]), JSON.stringify(pl));
check('matching concurrency 2..4', maxInflight >= 2 && maxInflight <= 4, `max in flight ${maxInflight}`);
const missingHead = (await dlg.locator('#music-import-missing').innerText()).trim();
const missingItems = await dlg.locator('[data-testid=missing-list] li').allInnerTexts();
check('"Missing tracks (n)" list', missingHead === 'Missing tracks (2)' && missingItems.length === 2 && /Nonexistent One/.test(missingItems[0]), missingHead);
const [dl] = await Promise.all([a.waitForEvent('download'), dlg.getByRole('button', { name: 'Download CSV' }).click()]);
const missCsv = readFileSync(await dl.path(), 'utf8');
check('missing tracks CSV download', /missing tracks\.csv$/.test(dl.suggestedFilename()) && missCsv.includes('Nonexistent One') && missCsv.includes('Nonexistent Two') && !missCsv.includes('Alpha'), dl.suggestedFilename());
await shot(a, 'import-result');

// Library CSV mode: add-only favourites.
await a.evaluate(() => window.__music.library.toggleFavorite({ kind: 'track', data: { id: 9005, title: 'Zeta', artist: 'Zed', artistId: 1, album: 'x', albumId: 1, cover: '', duration: 1, explicit: false, trackNumber: 1, quality: '' } }));
await dlg.getByRole('button', { name: 'Import another' }).click();
await fileIn.setInputFiles(buf(libraryCsv, 'library.csv'));
await dlg.locator('[data-testid=detected-format]').waitFor();
await dlg.getByRole('button', { name: 'Add to favourites' }).click();
await dlg.getByRole('button', { name: 'Start import' }).click();
await dlg.locator('[data-testid=import-result]').waitFor({ timeout: 20000 });
const fav = await a.evaluate(() => { const f = window.__music.library.favorites(); return { t: f.tracks.map((x) => x.id), al: f.albums.map((x) => x.id), ar: f.artists.map((x) => x.id) }; });
check('library CSV bulk-adds favourites (tracks, albums, artists) and keeps existing ones', fav.t.includes(9005) && fav.t.includes(9001) && fav.al.includes(7001) && fav.ar.includes(6001), JSON.stringify(fav));
check('library import result text', /Added 3 items to your favourites/.test(await dlg.locator('[data-testid=import-result]').innerText()));
await dlg.getByRole('button', { name: 'Done' }).click();
check('dialog closes', (await a.locator('[role=dialog]').count()) === 0);

// Format parsers through the real dialog: XSPF and M3U.
const xspf = '<?xml version="1.0"?><playlist xmlns="http://xspf.org/ns/0/" version="1"><title>From XSPF</title><trackList><track><title>Epsilon</title><creator>Eve</creator></track></trackList></playlist>';
await a.click('[data-testid=open-import]');
await a.locator('[role=dialog]').waitFor();
await fileIn.setInputFiles({ name: 'x.xspf', mimeType: 'application/xml', buffer: Buffer.from(xspf) });
await dlg.locator('[data-testid=detected-format]').waitFor();
check('XSPF detected with its playlist name prefilled', /XSPF/.test(await dlg.locator('[data-testid=detected-format]').innerText()) && (await a.inputValue('#music-import-name')) === 'From XSPF');
await dlg.getByRole('button', { name: 'Choose another file' }).click();
await fileIn.setInputFiles({ name: 'bad.bin', mimeType: 'application/octet-stream', buffer: Buffer.from('zzzz') });
await dlg.locator('[role=alert]').waitFor();
check('unsupported file shows an amber error', /Unsupported/.test(await dlg.locator('[role=alert]').innerText()) && (await dlg.locator('[role=alert]').getAttribute('class')).includes('text-amber-400'));
await a.keyboard.press('Escape');

// ── Shared playlist page ────────────────────────────────────────────────────
const b64url = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const body = JSON.stringify({ n: 'Road trip', d: 'for the car', t: [9001, 9002, 9003] });
const v0 = '0.' + b64url(body);
const v1 = '1.' + b64url(deflateRawSync(Buffer.from(body)));
for (const [label, d] of [['v1 deflate-raw', v1], ['v0 plain', v0]]) {
  await a.goto(`${base}/music/shared?musicdebug=1&d=${encodeURIComponent(d)}`, { waitUntil: 'domcontentloaded' });
  await a.waitForSelector('app-music-track-row', { timeout: 15000 });
  const name = (await a.locator('[data-testid=shared-name]').innerText()).trim();
  check(`/music/shared ${label}: name + 3 tracks listed`, name === 'Road trip' && (await a.locator('app-music-track-row').count()) === 3 && /^3 songs/.test((await a.locator('[data-testid=shared-count]').innerText()).trim()), name);
}
await shot(a, 'shared');
await dbg(a);
await a.getByRole('button', { name: 'Save a copy' }).click();
const saved = await a.evaluate(() => window.__music.library.playlists().filter((p) => p.name === 'Road trip').map((p) => p.tracks.map((t) => t.id)));
check('"Save a copy" creates a user playlist', saved.length === 1 && JSON.stringify(saved[0]) === '[9001,9002,9003]', JSON.stringify(saved));
await a.getByRole('button', { name: 'Play', exact: true }).click();
const played = await a.waitForFunction(() => [9001].includes(window.__music.player.track()?.id), null, { timeout: 8000 }).then(() => true).catch(() => false);
check('"Play" starts the first shared track', played);

// Export menu (mounted on the shared page).
await a.getByRole('button', { name: 'Export' }).click();
check('export menu: aria-haspopup/expanded, 5 formats + share link', (await a.locator('app-music-export-menu button[aria-haspopup=menu]').getAttribute('aria-expanded')) === 'true' && (await a.locator('[role=menuitem]').allInnerTexts()).map((s) => s.trim().split('\n')[0]).join(',') === 'CSV,JSON,XSPF,M3U,M3U8,Copy share link');
await a.keyboard.press('Escape');
check('Escape closes the export menu and returns focus to Export', (await a.locator('[role=menu]').count()) === 0 && (await a.evaluate(() => document.activeElement?.textContent?.trim())) === 'Export');
const wantFiles = { CSV: 'Road trip.csv', JSON: 'Road trip.json', XSPF: 'Road trip.xspf', M3U: 'Road trip.m3u', M3U8: 'Road trip.m3u8' };
const exported = {};
for (const [idx, [label, fileName]] of Object.entries(wantFiles).entries()) {
  await a.getByRole('button', { name: 'Export' }).click();
  const [d] = await Promise.all([a.waitForEvent('download'), a.locator('[role=menuitem]').nth(idx).click()]);
  exported[label] = { name: d.suggestedFilename(), text: readFileSync(await d.path(), 'utf8') };
  if (exported[label].name !== fileName) check(`export ${label} file name`, false, exported[label].name);
}
check('export menu downloads the right file names', Object.entries(wantFiles).every(([l, f]) => exported[l]?.name === f), Object.values(exported).map((x) => x.name).join(' | '));
check('exported contents are the right formats', exported.CSV.text.startsWith('Position,Track Name') && exported.CSV.text.includes('"Alpha, Song"')
  && JSON.parse(exported.JSON.text).tracks.length === 3 && exported.XSPF.text.includes('<trackList>') && exported.M3U.text.startsWith('#EXTM3U')
  && exported.M3U8.text.includes('#EXT-X-ENDLIST') && /#EXTINF:\d+,Ann - Alpha, Song/.test(exported.M3U.text));

// Catalogue not ready: "n tracks" + retry.
tracksMode = 'fail';
await a.goto(`${base}/music/shared?musicdebug=1&d=${encodeURIComponent(v1)}`, { waitUntil: 'domcontentloaded' });
await a.getByRole('button', { name: 'Try again' }).waitFor({ timeout: 15000 });
check('catalogue failure: shows name, "3 tracks" and retry', (await a.locator('[data-testid=shared-count]').innerText()).trim() === '3 tracks' && (await a.locator('[data-testid=shared-name]').innerText()).trim() === 'Road trip');
tracksMode = 'ok';
await a.getByRole('button', { name: 'Try again' }).click();
await a.waitForSelector('app-music-track-row', { timeout: 15000 });
check('retry loads the list', (await a.locator('app-music-track-row').count()) === 3);
await a.goto(`${base}/music/shared?d=zzz`, { waitUntil: 'domcontentloaded' });
await a.getByRole('heading', { name: "This link doesn't work" }).waitFor({ timeout: 10000 });
check('invalid link shows a clear message', true);
await ctxA.close();

// ════════════════════════════════════════════════════════════════════════════
// Context B: real API; backup / restore / settings / blocked / reset
// ════════════════════════════════════════════════════════════════════════════
const ctxB = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
const p = await newPage(ctxB);
const data = `${base}/music/settings?tab=data&musicdebug=1`;
const reloaded = () => p.waitForEvent('load', { timeout: 15000 });
await p.goto(data, { waitUntil: 'domcontentloaded' });
await dbg(p);
await p.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('fiesta:music:')) localStorage.removeItem(k); });
await p.reload({ waitUntil: 'domcontentloaded' });
await dbg(p);
const T = (id, title, artist) => ({ id, title, artist, artistId: 1, album: 'x', albumId: 1, cover: '', duration: 100, explicit: false, trackNumber: 1, quality: '' });
await p.evaluate((t) => {
  const lib = window.__music.library;
  lib.createPlaylist('Keep', [t]);
  lib.block({ kind: 'track', data: t });
  lib.block({ kind: 'artist', data: { id: 55, name: 'Blocked Band', picture: '' } });
  localStorage.setItem('fiesta:music:secret:lastfm', JSON.stringify({ token: 's3cret-token' }));
  localStorage.setItem('fiesta:music:zz-custom', '1');
}, T(111, 'Blocked Song', 'Someone'));

// Blocked manager
await p.waitForSelector('[data-testid=blocked-list]');
const blockedText = await p.locator('[data-testid=blocked-list]').innerText();
check('blocked items list (artists, tracks) with Unblock', /Blocked Band/.test(blockedText) && /Blocked Song/.test(blockedText) && (await p.getByRole('button', { name: 'Unblock Blocked Band' }).count()) === 1);
await p.getByRole('button', { name: 'Unblock Blocked Band' }).click();
check('Unblock removes it from the list and from library.isBlocked', !(await p.locator('[data-testid=blocked-list]').innerText()).includes('Blocked Band') && !(await p.evaluate(() => window.__music.library.isBlocked({ kind: 'artist', data: { id: 55, name: 'x', picture: '' } }))));

// Backup
const keysBefore = await p.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('fiesta:music:') && !k.startsWith('fiesta:music:secret:')).map((k) => k.slice(13)).sort());
const [bk] = await Promise.all([p.waitForEvent('download'), p.click('[data-testid=backup]')]);
const bkText = readFileSync(await bk.path(), 'utf8');
const bkJson = JSON.parse(bkText);
const today = new Date().toISOString().slice(0, 10);
check('backup file name fiesta-music-backup-YYYY-MM-DD.json', bk.suggestedFilename() === `fiesta-music-backup-${today}.json`, bk.suggestedFilename());
check('backup holds every fiesta:music:* key except secrets', bkJson.app === 'fiesta-music' && bkJson.version === 1 && JSON.stringify(Object.keys(bkJson.keys).sort()) === JSON.stringify(keysBefore) && !bkText.includes('s3cret-token') && !bkText.includes('lastfm'), `keys: ${Object.keys(bkJson.keys).join(',')}`);

// Restore: merge (default)
const other = { app: 'fiesta-music', version: 1, exportedAt: new Date().toISOString(), keys: {
  library: { favorites: {}, playlists: [{ id: 'other-1', name: 'Other', description: '', tracks: [], createdAt: 1, updatedAt: 1 }], folders: [], pins: [] },
  'zz-extra': 'x', 'secret:evil': { t: 1 },
} };
const json = (o, name = 'backup.json') => ({ name, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(o)) });
check('Merge is the default restore mode', (await p.locator('button:has-text("Merge")').getAttribute('aria-pressed')) === 'true');
await Promise.all([reloaded(), p.locator('[data-testid=restore-input]').setInputFiles(json(other))]);
await dbg(p);
const merged = await p.evaluate(() => ({ names: window.__music.library.playlists().map((x) => x.name).sort(), extra: localStorage.getItem('fiesta:music:zz-extra'), evil: localStorage.getItem('fiesta:music:secret:evil') }));
check('Restore > Merge keeps existing playlists and adds new ones (secrets in a file ignored)', JSON.stringify(merged.names) === '["Keep","Other"]' && merged.extra === '"x"' && merged.evil === null, JSON.stringify(merged));

// Restore: replace (confirm; cancel first)
const solo = { app: 'fiesta-music', version: 1, exportedAt: '', keys: { library: { favorites: {}, playlists: [{ id: 'solo', name: 'Solo', description: '', tracks: [], createdAt: 1, updatedAt: 1 }], folders: [], pins: [] } } };
await p.locator('button:has-text("Replace")').first().click();
await p.locator('[data-testid=restore-input]').setInputFiles(json(solo));
await p.locator('[data-testid=confirm-yes]').waitFor();
check('Replace asks for confirmation', /overwritten/.test(await p.locator('[data-testid=confirm-body]').innerText()));
await p.getByRole('button', { name: 'Cancel' }).click();
check('cancelling the confirmation changes nothing', JSON.stringify(await p.evaluate(() => window.__music.library.playlists().map((x) => x.name).sort())) === '["Keep","Other"]');
await p.locator('[data-testid=restore-input]').setInputFiles(json(solo));
await Promise.all([reloaded(), p.locator('[data-testid=confirm-yes]').click()]);
await dbg(p);
const replaced = await p.evaluate(() => ({ names: window.__music.library.playlists().map((x) => x.name), extra: localStorage.getItem('fiesta:music:zz-extra'), secret: localStorage.getItem('fiesta:music:secret:lastfm') }));
check('Restore > Replace overwrites everything except secrets', JSON.stringify(replaced.names) === '["Solo"]' && replaced.extra === null && !!replaced.secret, JSON.stringify(replaced));
await p.waitForSelector('[data-testid=reset]');

// Settings-only export / import
await p.evaluate(() => { window.__music.settings.reduceBlur.set(false); localStorage.setItem('fiesta:music:settings', JSON.stringify({ reduceBlur: false })); });
const [se] = await Promise.all([p.waitForEvent('download'), p.click('[data-testid=export-settings]')]);
const seJson = JSON.parse(readFileSync(await se.path(), 'utf8'));
check('settings-only export has no library keys', se.suggestedFilename() === `fiesta-music-settings-${today}.json` && !('library' in seJson.keys) && 'settings' in seJson.keys, Object.keys(seJson.keys).join(','));
await Promise.all([reloaded(), p.locator('[data-testid=settings-input]').setInputFiles(json({ app: 'fiesta-music', version: 1, exportedAt: '', keys: { settings: { reduceBlur: true }, library: { playlists: [] } } }, 'settings.json'))]);
await dbg(p);
const after = await p.evaluate(() => ({ blur: window.__music.settings.reduceBlur(), pls: window.__music.library.playlists().map((x) => x.name) }));
check('settings import applies settings and ignores library keys', after.blur === true && JSON.stringify(after.pls) === '["Solo"]', JSON.stringify(after));
await p.locator('[data-testid=restore-input]').setInputFiles({ name: 'junk.json', mimeType: 'application/json', buffer: Buffer.from('{"nope":1}') });
await p.waitForFunction(() => /not a Fiesta music backup/.test(document.querySelector('[data-testid=data-status]')?.textContent || ''));
check('a non-backup file is rejected with an amber message', (await p.locator('[data-testid=data-status]').getAttribute('class')).includes('text-amber-400'));
await shot(p, 'settings-data');

// Blocking makes the player skip (real API, 30 s previews are fine)
const skip = await p.evaluate(async () => {
  const r = await fetch('/api/music?action=search&q=daft+punk+one+more+time').then((x) => x.json());
  const list = r.tracks.slice(0, 4);
  const { player, library } = window.__music;
  await player.play(list[0], list);
  const until = async (fn, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await new Promise((x) => setTimeout(x, 150)); } return false; };
  const started = await until(() => player.track()?.id === list[0].id);
  library.block({ kind: 'track', data: list[1] });
  player.next();
  const landed = await until(() => player.track()?.id === list[2].id);
  const wasBlockedPlayed = player.track()?.id === list[1].id;
  library.unblock('track', list[1].id);
  return { started, landed, wasBlockedPlayed, ids: list.map((t) => t.id), now: player.track()?.id };
});
check('blocking a track makes the player skip it on Next', skip.started && skip.landed && !skip.wasBlockedPlayed, JSON.stringify(skip));

// Reset
await p.evaluate(() => new Promise((res) => { const r = indexedDB.open('fiesta-music-p7test'); r.onsuccess = () => { r.result.close(); res(); }; r.onerror = res; }));
const dbBefore = await p.evaluate(async () => (await indexedDB.databases()).map((d) => d.name));
await p.click('[data-testid=reset]');
await p.locator('[data-testid=confirm-yes]').waitFor();
check('Reset asks for confirmation', /clears/i.test(await p.locator('[data-testid=confirm-body]').innerText()) && dbBefore.includes('fiesta-music-p7test'));
await Promise.all([reloaded(), p.locator('[data-testid=confirm-yes]').click()]);
await dbg(p);
const reset = await p.evaluate(async () => ({
  keys: Object.keys(localStorage).filter((k) => k.startsWith('fiesta:music:')),
  dbs: (await indexedDB.databases()).map((d) => d.name).filter((n) => n.startsWith('fiesta-music-')),
  pls: window.__music.library.playlists().length,
}));
check('Reset clears music keys and every fiesta-music-* IndexedDB, then reloads', !reset.keys.includes('fiesta:music:library') && !reset.keys.includes('fiesta:music:secret:lastfm') && !reset.keys.includes('fiesta:music:zz-custom') && !reset.dbs.includes('fiesta-music-p7test') && reset.pls === 0, JSON.stringify(reset));
await ctxB.close();

check('no uncaught page errors', errors.length === 0, errors.slice(0, 2).join(' | '));
await browser.close();
const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
