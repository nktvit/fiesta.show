// E2E for package P12 (downloads): settings section, single-track download with tray card + cancel,
// album ZIP with sidecars, folder writer (via the origin-private file system), and the off switch.
//   node tools/e2e/music-p12.mjs [baseUrl=http://localhost:4212] [--shots=dir] [--token-file=path] [--expect=on|off]
// --expect=on  (default) needs MUSIC_DOWNLOADS_ENABLED = true in music-download.service.ts and checks every feature.
// --expect=off needs the shipped value (false) and checks that every download entry point is hidden.
// Run with NODE_PATH pointing at a node_modules that has playwright(-core). Uses the real API harness behind
// the dev server; without a user token tracks are 30 s PREVIEWs, which is fine here.
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright-core')); } catch { ({ chromium } = require('playwright')); }

const base = process.argv.find((a) => a.startsWith('http')) || 'http://localhost:4212';
const shots = (process.argv.find((a) => a.startsWith('--shots=')) || '').slice(8);
const tokenFile = (process.argv.find((a) => a.startsWith('--token-file=')) || '').slice(13);
const expectOn = ((process.argv.find((a) => a.startsWith('--expect=')) || '--expect=on').slice(9)) !== 'off';
const userToken = tokenFile ? readFileSync(tokenFile, 'utf8').trim() : '';
const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };
const tmp = mkdtempSync(join(tmpdir(), 'p12-'));

const launchArgs = { args: ['--autoplay-policy=no-user-gesture-required'] };
const browser = await chromium.launch({ channel: 'chrome', ...launchArgs }).catch(() => chromium.launch(launchArgs));
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
if (userToken) await ctx.route('**/api/music*', (r) => r.continue({ headers: { ...r.request().headers(), 'x-tidal-token': userToken } }));
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const shot = async (name) => { if (shots) await page.screenshot({ path: `${shots}/music-p12-${name}.png` }); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const safe = (s) => s.replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+/, '').replace(/[. ]+$/, '');

// ── OFF mode: nothing is reachable ────────────────────────────────────────────
if (!expectOn) {
  await page.goto(base + '/music/settings?tab=downloads&musicdebug=1', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__music, null, { timeout: 15000 });
  await page.waitForSelector('[role=tablist][aria-label="Settings sections"] [role=tab]', { timeout: 15000 });
  const tabLabels = (await page.locator('[role=tablist][aria-label="Settings sections"] [role=tab]').allTextContents()).map((l) => l.trim());
  check('Settings has no Downloads tab while downloads are switched off', !tabLabels.includes('Downloads'), tabLabels.join('|'));
  check('...and ?tab=downloads falls back to a visible section without download controls',
    (await page.locator('app-music-settings-downloads').count()) === 0
    && (await page.locator('[role=tab][aria-selected=true]').textContent().catch(() => ''))?.trim() !== 'Downloads');
  await page.fill('#music-settings-search', 'download');
  await sleep(300);
  check('...and settings search does not offer the Downloads section', (await page.locator('[data-setting-result]:has-text("Downloads")').count()) === 0);
  await page.waitForFunction(() => !!window.__music?.downloads, null, { timeout: 10000 }).catch(() => {});
  check('the download service reports enabled() === false', await page.evaluate(() => window.__music?.downloads?.enabled() === false));
  const track = { id: 1550546, title: 'One More Time', artist: 'Daft Punk', artistId: 8847, album: 'Discovery', albumId: 1550545, cover: '', duration: 320, explicit: false, trackNumber: 1, quality: 'LOSSLESS' };
  await page.evaluate(async (t) => { await window.__music.downloads.downloadTrack(t); await window.__music.downloads.downloadTracks([t, { ...t, id: 2 }], { kind: 'album', name: 'x' }); await window.__music.downloads.downloadArtist(8847); }, track);
  await sleep(500);
  check('download calls are no-ops: no task, no tray, no dialog', await page.evaluate(() => window.__music.downloads.tasks().length === 0 && window.__music.downloads.artistRequest() === null) && (await page.locator('[data-downloads-tray]').count()) === 0);
  await page.goto(base + '/music?q=daft+punk+one+more+time', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('app-music-track-row', { timeout: 20000 });
  check('no "Download" entry point on the search page', (await page.locator('button:has-text("Download"), a:has-text("Download"), [aria-label*="ownload"]').count()) === 0);
  await shot('off');
  await browser.close();
  console.log(errors.length ? 'page errors: ' + errors.slice(0, 3).join(' | ') : 'no page errors');
  const failed = results.filter((r) => !r).length;
  console.log(`${results.length - failed}/${results.length} passed`);
  process.exit(failed || errors.length ? 1 : 0);
}

// ── ON mode ───────────────────────────────────────────────────────────────────
// 1. Settings > Downloads
await page.goto(base + '/music/settings?tab=downloads&musicdebug=1', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.__music, null, { timeout: 15000 });
await page.evaluate(() => { try { localStorage.removeItem('fiesta:music:downloads'); } catch {} });
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.__music?.downloads, null, { timeout: 15000 });
await page.waitForSelector('app-music-settings-downloads input[name="download-track-template"]');
check('settings section renders quality Lossless/High/Low', (await page.locator('app-music-settings-downloads [data-quality]').allTextContents()).join(',') === 'Lossless,High,Low');
check('default template previews "Daft Punk - One More Time.flac"', (await page.locator('[data-preview-track]').textContent()).includes('Daft Punk - One More Time.flac'));
await page.fill('input[name="download-track-template"]', '{artist}/{album} - {track} {title}');
await page.press('input[name="download-track-template"]', 'Tab');
check('editing the template updates the preview', (await page.locator('[data-preview-track]').textContent()).includes('Daft Punk/Discovery - 01 One More Time.flac'));
await page.fill('input[name="download-track-template"]', '{artist} - {title}');
await page.press('input[name="download-track-template"]', 'Tab');
await page.click('[data-quality="HIGH"]');
check('choosing a quality sticks (aria-checked) and persists', (await page.locator('[data-quality="HIGH"]').getAttribute('aria-checked')) === 'true' && (await page.evaluate(() => JSON.parse(localStorage.getItem('fiesta:music:downloads')).quality)) === 'HIGH');
await page.click('[data-quality="LOSSLESS"]');
const sidecarSwitches = await page.locator('app-music-settings-downloads [role="switch"]').count();
check('sidecar toggles (cover, m3u8, cue, nfo, json) + embed switches are there', sidecarSwitches >= 7, `switches ${sidecarSwitches}`);
await page.click('#setting-dl-sidecar-cue [role="switch"]');
check('a sidecar toggle persists', await page.evaluate(() => JSON.parse(localStorage.getItem('fiesta:music:downloads')).sidecars.cue === true));
await page.click('[data-bulk-mode="files"]');
await page.click('[data-bulk-mode="zip"]');
check('ZIP vs separate files switch exists and persists', await page.evaluate(() => JSON.parse(localStorage.getItem('fiesta:music:downloads')).bulkMode === 'zip'));
const hasPicker = await page.evaluate(() => typeof window.showDirectoryPicker === 'function');
check('"Choose folder" is shown only when File System Access exists', (await page.locator('[data-choose-folder]').count()) === (hasPicker ? 1 : 0), `picker ${hasPicker}`);
await shot('settings');

// 2. Real catalogue data (captured from the live API harness)
const searchP = page.waitForResponse((r) => r.url().includes('action=search'), { timeout: 30000 });
await page.goto(base + '/music?q=daft+punk+one+more+time&musicdebug=1', { waitUntil: 'domcontentloaded' });
const search = await (await searchP).json();
await page.waitForFunction(() => !!window.__music?.downloads, null, { timeout: 15000 });
const track = search.tracks.find((t) => /one more time/i.test(t.title)) || search.tracks[0];
console.log('INFO  track', track.id, track.artist, '-', track.title);

// Slow segments a little so the progress card is observable.
await page.route('**/api/music?action=seg*', async (route) => { await sleep(350); await route.continue(); });
let manifest = null;
page.on('response', async (r) => { if (r.url().includes('action=manifest') && !manifest) manifest = await r.json().catch(() => null); });

const texts = new Set();
const toasts = new Set();
const watcher = (async () => {
  for (let i = 0; i < 120; i++) {
    const t = await page.locator('[data-dl-card]').first().innerText({ timeout: 500 }).catch(() => '');
    if (t) texts.add(t.replace(/\s+/g, ' '));
    const toast = await page.locator('app-music-toast-host').innerText({ timeout: 500 }).catch(() => '');
    if (toast) toasts.add(toast.replace(/\s+/g, ' '));
    await sleep(60);
  }
})();
const [dl] = await Promise.all([
  page.waitForEvent('download', { timeout: 60000 }),
  page.evaluate((t) => window.__music.downloads.downloadTrack(t), track),
]);
await page.waitForSelector('[data-dl-card] [data-dl-cancel]', { timeout: 5000 }).catch(() => {});
const sawCancel = [...texts].length > 0;
const file = join(tmp, dl.suggestedFilename());
await dl.saveAs(file);
await watcher;
const progressText = [...texts].find((t) => /Downloading .+ ([1-9]\d?) %/.test(t));
check('tray card shows "Downloading <title> NN %" (0 < NN < 100) with a Cancel button', !!progressText && sawCancel && [...texts].some((t) => /Cancel/.test(t)), [...texts].map((t) => t.slice(0, 48)).join(' | ').slice(0, 220));
const bytes = readFileSync(file);
const isFlac = bytes.subarray(0, 4).toString('latin1') === 'fLaC';
const isM4a = bytes.subarray(4, 8).toString('latin1') === 'ftyp';
const expectedBase = `${safe(track.artist)} - ${safe(track.title)}`;
check(`file is "${expectedBase}.(flac|m4a)" matching its container`, dl.suggestedFilename() === `${expectedBase}.${isFlac ? 'flac' : 'm4a'}` && (isFlac || isM4a), `${dl.suggestedFilename()} ${bytes.length} bytes, codec ${manifest?.codec}, ${manifest?.presentation}`);
check('lossless manifest -> real .flac (fLaC header), AAC -> .m4a', manifest ? (/flac/i.test(manifest.codec) ? isFlac : isM4a) : false);
if (isFlac) {
  // walk the metadata blocks: STREAMINFO first, VORBIS_COMMENT with TITLE, PICTURE present, last flag on the final one
  let pos = 4; const types = []; let title = ''; let lastOk = false;
  for (;;) {
    const head = bytes[pos]; const len = (bytes[pos + 1] << 16) | (bytes[pos + 2] << 8) | bytes[pos + 3];
    types.push(head & 0x7f);
    if ((head & 0x7f) === 4) { const d = bytes.subarray(pos + 4, pos + 4 + len).toString('utf8'); title = /TITLE=([^\u0000-\u0008]*)/.exec(d)?.[1] ?? ''; }
    pos += 4 + len;
    if (head & 0x80) { lastOk = true; break; }
    if (pos > bytes.length) break;
  }
  check('FLAC blocks: STREAMINFO first, Vorbis comment (TITLE) and PICTURE, last-block flag set', types[0] === 0 && types.includes(4) && types.includes(6) && lastOk && title.includes(track.title.slice(0, 5)), `types ${types} title "${title}"`);
  check('frames follow the metadata (FLAC frame sync 0xFFF8/F9)', bytes[pos] === 0xff && (bytes[pos + 1] & 0xfe) === 0xf8);
} else {
  check('m4a has ilst tags (moov/udta/meta/ilst, title atom)', bytes.includes(Buffer.from('ilst')) && bytes.includes(Buffer.from('©nam', 'latin1')));
}
await page.waitForSelector('[data-dl-card][data-status="done"]', { timeout: 10000 });
check('card ends as "Saved ..." and an aria-live toast announces it', /^Saved /.test((await page.locator('[data-dl-card]').first().innerText()).trim()) && [...toasts].some((t) => t.includes('Saved ')));
await shot('tray-done');

// 3. Cancel
await page.click('[data-dl-clear]');
let gotDownload = false;
page.once('download', () => { gotDownload = true; });
await page.evaluate((t) => window.__music.downloads.downloadTrack({ ...t, id: t.id }), track);
await page.waitForSelector('[data-dl-card] [data-dl-cancel]');
await page.click('[data-dl-card] [data-dl-cancel]');
await page.waitForSelector('[data-dl-card][data-status="cancelled"]', { timeout: 5000 });
await sleep(2500);
check('Cancel stops the download: card says Cancelled, no file is saved, Retry is offered', !gotDownload && (await page.locator('[data-dl-retry]').count()) === 1);
await page.click('[data-dl-dismiss]');
check('Dismiss removes the card', (await page.locator('[data-dl-card]').count()) === 0);

// 4. Album ZIP with sidecars
const albumRes = await page.evaluate(async (id) => (await fetch('/api/music?action=album&id=' + id)).json(), track.albumId);
const album = albumRes.album; const tracks = albumRes.tracks.slice(0, 3);
await page.evaluate(() => window.__music.downloads.setPrefs({ lyricsSidecar: 'lrc', bulkMode: 'zip', sidecars: { cover: true, m3u8: true, cue: true, nfo: true, json: true } }));
const [zdl] = await Promise.all([
  page.waitForEvent('download', { timeout: 120000 }),
  page.evaluate(([a, t]) => window.__music.downloads.downloadAlbum(a, t), [album, tracks]),
]);
const zfile = join(tmp, zdl.suggestedFilename());
await zdl.saveAs(zfile);
const listing = execFileSync('unzip', ['-Z1', zfile]).toString().split('\n').filter(Boolean);
console.log('INFO  zip', zdl.suggestedFilename(), statSync(zfile).size, 'bytes:', listing.join(' | '));
check(`ZIP is named "${safe(album.artist)} - ${safe(album.title)}.zip"`, zdl.suggestedFilename() === `${safe(album.artist)} - ${safe(album.title)}.zip`);
check('ZIP holds numbered tracks (01 - ..., 02 - ..., 03 - ...)', [1, 2, 3].every((n) => listing.some((f) => f.startsWith(String(n).padStart(2, '0') + ' - ') && /\.(flac|m4a)$/.test(f))));
check('ZIP holds cover.jpg', listing.includes('cover.jpg'));
const stem = safe(album.title);
check('ZIP holds .m3u8 .cue .nfo .json sidecars', ['m3u8', 'cue', 'nfo', 'json'].every((e) => listing.some((f) => f.endsWith('.' + e))), listing.filter((f) => !/\.(flac|m4a)$/.test(f)).join(','));
const lrc = listing.filter((f) => f.endsWith('.lrc'));
const lyricsFound = await page.evaluate(async (ts) => {
  const out = [];
  for (const t of ts) { try { const r = await fetch('https://lrclib.net/api/search?track_name=' + encodeURIComponent(t.title) + '&artist_name=' + encodeURIComponent(t.artist)); const j = await r.json(); out.push(Array.isArray(j) && j.some((x) => x.syncedLyrics || x.plainLyrics)); } catch { out.push(false); } }
  return out;
}, tracks);
check('ZIP holds a .lrc per track that has lyrics (or none when no provider has them)', lrc.length > 0 || lyricsFound.every((f) => !f), `lrc files ${lrc.length}, lrclib has lyrics for ${lyricsFound.filter(Boolean).length}/${tracks.length}`);
const m3u = execFileSync('unzip', ['-p', zfile, listing.find((f) => f.endsWith('.m3u8'))]).toString();
check('m3u8 lists the saved track paths', listing.filter((f) => /\.(flac|m4a)$/.test(f)).every((f) => m3u.includes(f)));

// 5. Folder writer (File System Access) through the origin-private file system
if (hasPicker) {
  const wrote = await page.evaluate(async (t) => {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('p12-out', { create: true });
    await new Promise((res, rej) => { const rq = indexedDB.open('fiesta-music-downloads', 1); rq.onupgradeneeded = () => rq.result.createObjectStore('handles'); rq.onsuccess = () => { const tx = rq.result.transaction('handles', 'readwrite'); tx.objectStore('handles').put(dir, 'folder'); tx.oncomplete = res; tx.onerror = rej; }; rq.onerror = rej; });
    window.__music.downloads.setPrefs({ saveToFolder: true, trackTemplate: '{artist}/{title}' });
    await window.__music.downloads.downloadTrack(t);
    for (let i = 0; i < 200 && window.__music.downloads.tasks().some((x) => x.status === 'running' || x.status === 'queued'); i++) await new Promise((r) => setTimeout(r, 100));
    const names = [];
    for await (const [name, h] of dir.entries()) { if (h.kind === 'directory') for await (const [n2] of h.entries()) names.push(name + '/' + n2); else names.push(name); }
    window.__music.downloads.setPrefs({ saveToFolder: false, trackTemplate: '{artist} - {title}' });
    return names;
  }, track);
  check('"Save to folder" writes <Artist>/<Title>.<ext> into the chosen folder (OPFS handle)', wrote.some((n) => n.startsWith(safe(track.artist) + '/' + safe(track.title) + '.')), wrote.join(','));
}

// 6. Artist discography asks first
await page.click('[data-dl-clear]').catch(() => {});
const before = await page.evaluate(() => window.__music.downloads.tasks().length);
const artistDlg = await page.evaluate(async (id) => { await window.__music.downloads.downloadArtist(id); const r = window.__music.downloads.artistRequest(); return r ? r.albums.length : -1; }, track.artistId);
check('downloadArtist asks for confirmation with the album count before queueing', artistDlg > 0 && (await page.locator('[role="dialog"]:has-text("Download discography")').count()) === 1 && (await page.evaluate(() => window.__music.downloads.tasks().length)) === before, `albums ${artistDlg}`);
await page.click('[data-dl-artist-cancel]');
check('Cancel in the confirm dialog queues nothing and closes it', (await page.evaluate(() => window.__music.downloads.tasks().length)) === before && (await page.locator('[role="dialog"]').count()) === 0);
await shot('artist-confirm');

await browser.close();
console.log(errors.length ? 'page errors: ' + errors.slice(0, 3).join(' | ') : 'no page errors');
const failed = results.filter((r) => !r).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed || errors.length ? 1 : 0);
