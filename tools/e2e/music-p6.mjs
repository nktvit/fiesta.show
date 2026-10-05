// E2E for package P6 (library UI): like button, Library page (tabs, filter, sort,
// Play/Shuffle, grid/list), playlists + folders, user playlist page (collage/custom
// cover, edit, share, drag + keyboard reorder, remove, recommendations), add-to-playlist
// dialog, pins and the Recent page.
//   node tools/e2e/music-p6.mjs [baseUrl=http://localhost:4206] [--shots=dir] [--token-file=path]
// Drives the app through `?musicdebug=1` (window.__music). Passes with 30 s previews.
// Needs the API harness behind the dev server (search is used to get real tracks).
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright-core')); } catch { ({ chromium } = require('playwright')); }

const base = process.argv.find((a) => a.startsWith('http')) || 'http://localhost:4206';
const shots = (process.argv.find((a) => a.startsWith('--shots=')) || '').slice(8);
const tokenFile = (process.argv.find((a) => a.startsWith('--token-file=')) || '').slice(13);
const userToken = tokenFile ? readFileSync(tokenFile, 'utf8').trim() : '';
const results = [];
const check = (name, ok, extra = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };

const browser = await chromium.launch({ channel: 'chrome', args: ['--autoplay-policy=no-user-gesture-required'] })
  .catch(() => chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] }));
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] });
if (userToken) await ctx.route('**/api/music*', (r) => r.continue({ headers: { ...r.request().headers(), 'x-tidal-token': userToken } }));
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

const wait = (ms) => page.waitForTimeout(ms);
const until = async (fn, arg, ms = 15000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await page.evaluate(fn, arg)) return true; await wait(150); }
  return false;
};
const boot = async (path) => {
  await page.goto(base + path + (path.includes('?') ? '&' : '?') + 'musicdebug=1', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__music, null, { timeout: 30000 });
  await page.waitForLoadState('load');
  await wait(300);
};
const shot = async (n) => { if (shots) await page.screenshot({ path: `${shots}/p6-${n}.png` }); };
const toastText = () => page.locator('[aria-live] ').allInnerTexts().then((a) => a.join(' | ')).catch(() => '');

// Real tracks from the API (distinct covers needed for the collage).
await page.goto(base + '/music', { waitUntil: 'domcontentloaded' });
const found = await page.evaluate(async () => {
  const r = await fetch('/api/music?action=search&q=' + encodeURIComponent('daft punk discovery'));
  return (await r.json()).tracks;
});
const covers = new Set();
const tracks = found.filter((t) => t.albumId && t.cover && !covers.has(t.cover) && covers.add(t.cover)).slice(0, 8);
const more = found.filter((t) => !tracks.some((x) => x.id === t.id)).slice(0, 4);
check('API gave enough distinct tracks to test with', tracks.length >= 5, String(tracks.length));

const reset = async () => { await page.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('fiesta:music:')) localStorage.removeItem(k); }); };
await reset();

// ── 1. Empty states ─────────────────────────────────────────────────────────
await boot('/music/library');
await page.waitForSelector('h1:has-text("Your Library")');
check('Library title is "Your Library | Stream Fiesta"', (await page.title()) === 'Your Library | Stream Fiesta', await page.title());
const tabNames = await page.locator('[role=tablist] [role=tab]').allInnerTexts();
check('Library has tabs Tracks, Albums, Artists, Playlists, Mixes', tabNames.join(',') === 'Tracks,Albums,Artists,Playlists,Mixes', tabNames.join(','));
let emptyOk = true;
for (const [tab, label] of [['tracks', 'Tracks'], ['albums', 'Albums'], ['artists', 'Artists'], ['playlists', 'Playlists'], ['mixes', 'Mixes']]) {
  await page.getByRole('tab', { name: label }).click();
  await page.waitForFunction((t) => new URL(location.href).searchParams.get('tab') === (t === 'tracks' ? null : t), tab);
  const a = page.locator('[data-empty] a[href="/music"]');
  const n = await a.count();
  if (n !== 1) emptyOk = false;
}
check('every tab shows an empty state linking to search (?tab= in URL)', emptyOk);
await boot('/music/library?tab=albums');
check('?tab=albums deep link selects Albums', (await page.locator('[role=tab][aria-selected=true]').innerText()) === 'Albums');

// ── 2. Like button (on the album page; playback needs a TIDAL session, so nothing here plays audio) ──
const albumId = tracks[0].albumId;
const albumTrack = await page.evaluate(async (id) => (await (await fetch('/api/music?action=album&id=' + id)).json()).tracks[0], albumId);
await boot('/music/album/' + albumId);
await page.waitForSelector('main button[aria-label="Like"]', { timeout: 20000 });
const likeBtn = page.locator('main button[aria-label="Like"]').first();
const initial = await likeBtn.getAttribute('aria-pressed');
await likeBtn.click();
await wait(300);
const unlike = page.locator('main button[aria-label="Unlike"]').first();
check('Like toggles to Unlike with aria-pressed true and stores the favourite',
  initial === 'false' && (await unlike.getAttribute('aria-pressed')) === 'true'
  && await page.evaluate((id) => window.__music.library.favorites().albums.some((a) => a.id === id), albumId));
check('toast "Added to Liked" with an Undo button', /Added to Liked/.test(await page.locator('body').innerText()) && (await page.getByRole('button', { name: 'Undo' }).count()) > 0);
await page.getByRole('button', { name: 'Undo' }).first().click();
await wait(300);
check('Undo reverts the like', (await page.locator('main button[aria-label="Like"]').count()) > 0 && !(await page.evaluate((id) => window.__music.library.isFavorite({ kind: 'album', data: { id } }), albumId)));
await page.locator('main button[aria-label="Like"]').first().click();
await wait(300);
await boot('/music/album/' + albumId);
await page.waitForSelector('main button[aria-label="Unlike"]', { timeout: 20000 }).catch(() => {});
check('like persists across reload and shows Unlike', (await page.locator('main button[aria-label="Unlike"]').count()) > 0
  && await page.evaluate((id) => window.__music.library.isFavorite({ kind: 'album', data: { id } }), albumId));
await page.evaluate((id) => { window.__music.library.toggleFavorite({ kind: 'album', data: { id } }); }, albumId);
await wait(200);
check('state is shared instantly (toggling in the store flips the button)', (await page.locator('main button[aria-label="Like"]').count()) > 0);
await reset();
await boot('/music');
// Shared instantly: like more things programmatically, every surface reads the same state.
await page.evaluate((arg) => {
  const lib = window.__music.library;
  void 0;
  arg.tracks.forEach((t) => lib.isFavorite({ kind: 'track', data: t }) || lib.toggleFavorite({ kind: 'track', data: t }));
  lib.toggleFavorite({ kind: 'album', data: { id: 1, title: 'Alpha Album', artist: 'Zed', cover: arg.tracks[0].cover, year: '2001', tracks: 5, duration: 100, quality: 'LOSSLESS' } });
  lib.toggleFavorite({ kind: 'album', data: { id: 2, title: 'Beta Album', artist: 'Amy', cover: arg.tracks[1].cover, year: '2002', tracks: 5, duration: 100, quality: 'LOSSLESS' } });
  lib.toggleFavorite({ kind: 'artist', data: { id: 11, name: 'Zed Artist', picture: arg.tracks[0].cover } });
  lib.toggleFavorite({ kind: 'artist', data: { id: 12, name: 'Amy Artist', picture: arg.tracks[1].cover } });
  lib.toggleFavorite({ kind: 'mix', data: { id: 'mixone', title: 'Mix One', subTitle: 'sub', cover: arg.tracks[2].cover, type: 'DAILY_MIX' } });
  lib.toggleFavorite({ kind: 'playlist', data: { uuid: 'aaaaaaaa-0000-0000-0000-000000000000', title: 'Saved TIDAL', description: '', cover: arg.tracks[2].cover, creator: 'TIDAL', tracks: 10, duration: 1000, lastUpdated: '' } });
}, { tracks: tracks.slice(0, 6) });

// ── 3. Library page ─────────────────────────────────────────────────────────
await boot('/music/library');
await page.waitForSelector('app-music-track-row');
const rowCount = await page.locator('app-music-track-row').count();
check('Tracks tab lists all liked tracks', rowCount === 6, String(rowCount));
// Sort
const titlesOf = () => page.locator('app-music-track-row p.truncate.text-sm').allInnerTexts().then((a) => a.map((s) => s.replace(/\s+/g, ' ').trim().replace(/ E$/, '')));
const sortOpts = await page.locator('#music-library-sort option').allInnerTexts();
check('sort select offers Recently added, Title, Artist, Album, Duration', sortOpts.join(',') === 'Recently added,Title,Artist,Album,Duration', sortOpts.join(','));
await page.selectOption('#music-library-sort', 'title');
await wait(150);
const byTitle = await titlesOf();
const expected = [...byTitle].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true }));
check('sort by Title orders rows alphabetically', byTitle.join('|') === expected.join('|'), byTitle.join(' | '));
await page.selectOption('#music-library-sort', 'duration');
await wait(150);
const durs = await page.locator('app-music-track-row span.tabular-nums.text-right').allInnerTexts();
const secs = durs.map((d) => d.split(':').reduce((a, b) => a * 60 + Number(b), 0));
check('sort by Duration is ascending', secs.every((s, i) => i === 0 || secs[i - 1] <= s), durs.join(','));
await page.selectOption('#music-library-sort', 'added');
// Filter
const some = tracks[2];
await page.fill('input[name=libraryFilter]', some.title.slice(0, 6));
await wait(200);
const filtered = await page.locator('app-music-track-row').count();
check('filter input narrows the tracks', filtered >= 1 && filtered < 6, String(filtered));
await page.fill('input[name=libraryFilter]', '');
// Play / Shuffle
await page.getByRole('button', { name: 'Play', exact: true }).first().click();
await until(() => window.__music.player.context()?.label === 'Liked tracks', null, 20000);
const ctxPlay = await page.evaluate(() => ({ label: window.__music.player.context()?.label, type: window.__music.player.context()?.type, n: window.__music.player.queue().length, shuffle: window.__music.player.shuffle() }));
check('Play queues all liked tracks with context "Liked tracks"', ctxPlay.label === 'Liked tracks' && ctxPlay.n === 6 && ctxPlay.type === 'library' && !ctxPlay.shuffle, JSON.stringify(ctxPlay));
await page.getByRole('button', { name: 'Shuffle', exact: true }).first().click();
await until(() => window.__music.player.shuffle(), null, 20000);
const ctxSh = await page.evaluate(() => ({ label: window.__music.player.context()?.label, n: window.__music.player.queue().length, shuffle: window.__music.player.shuffle() }));
check('Shuffle queues all liked tracks shuffled', ctxSh.label === 'Liked tracks' && ctxSh.n === 6 && ctxSh.shuffle, JSON.stringify(ctxSh));
await page.evaluate(() => window.__music.player.pause?.());
await shot('library-tracks');
// Albums grid/list + persistence
await page.getByRole('tab', { name: 'Albums' }).click();
await page.waitForSelector('app-music-album-card');
check('Albums tab renders liked albums as cards (grid)', (await page.locator('app-music-album-card').count()) === 2);
await page.getByRole('button', { name: 'List view' }).click();
await wait(150);
const listShown = (await page.locator('app-music-album-card').count()) === 0 && (await page.locator('li:has(a[href^="/music/album/"])').count()) === 2;
await boot('/music/library?tab=albums');
await page.waitForSelector('main h1');
const persistedList = (await page.locator('app-music-album-card').count()) === 0 && (await page.getByRole('button', { name: 'List view' }).getAttribute('aria-pressed')) === 'true';
check('grid/list toggle works for albums and persists across reload', listShown && persistedList);
await page.getByRole('tab', { name: 'Artists' }).click();
await wait(200);
check('view mode is shared with the Artists tab (list rows)', (await page.locator('li:has(a[href^="/music/artist/"])').count()) === 2);
await page.getByRole('button', { name: 'Grid view' }).click();
await wait(150);
check('Artists grid view shows artist cards', (await page.locator('app-music-artist-card').count()) === 2);
await page.getByRole('tab', { name: 'Mixes' }).click();
await wait(200);
check('Mixes tab lists the liked mix', (await page.locator('app-music-playlist-card').count()) === 1);

// ── 4. Playlists, folders, add-to-playlist dialog ───────────────────────────
await boot('/music/library?tab=playlists');
await page.getByRole('button', { name: 'New playlist' }).click();
const dlg = page.locator('[role=dialog]');
await dlg.waitFor();
await dlg.getByRole('button', { name: 'Create' }).click();
check('New playlist requires a name', (await dlg.getByText('A name is required.').count()) === 1 && /playlist/.test(new URL(page.url()).pathname) === false);
await dlg.getByLabel('Name').fill('Road Trip');
await dlg.getByRole('button', { name: 'Create' }).click();
await page.waitForURL(/\/music\/library\/playlist\/.+/);
const plId = new URL(page.url()).pathname.split('/').pop();
check('creating a playlist navigates to /music/library/playlist/:id', !!plId);
await page.waitForSelector('h1:has-text("Road Trip")');
check('playlist page title is "<Playlist> | Stream Fiesta"', (await page.title()) === 'Road Trip | Stream Fiesta', await page.title());

// Add-to-playlist dialog through ui.openAddToPlaylist
await page.evaluate((t) => window.__music.ui.openAddToPlaylist(t), tracks.slice(0, 3));
const add = page.locator('[role=dialog]');
await add.waitFor();
const listing = await add.innerText();
check('add-to-playlist dialog lists playlists with track counts', /Road Trip/.test(listing) && /0 tracks/.test(listing), listing.replace(/\s+/g, ' ').slice(0, 120));
await add.getByRole('button', { name: /Road Trip/ }).click();
await wait(200);
check('adding reports "Added 3 tracks"', /Added 3 tracks/.test(await page.locator('body').innerText()));
await page.evaluate((t) => window.__music.ui.openAddToPlaylist(t), tracks.slice(0, 3));
await add.waitFor();
await add.getByRole('button', { name: /Road Trip/ }).click();
await wait(200);
check('adding the same tracks reports "Already in ..."', /Already in Road Trip/.test(await page.locator('body').innerText()));
await page.evaluate((t) => window.__music.ui.openAddToPlaylist(t), [tracks[3]]);
await add.waitFor();
await add.getByRole('button', { name: /New playlist/ }).click();
await add.getByLabel('New playlist name').fill('Inline Made');
await add.getByRole('button', { name: 'Create' }).click();
await wait(200);
const names = await page.evaluate(() => window.__music.library.playlists().map((p) => p.name + ':' + p.tracks.length));
check('"New playlist" inline in the dialog creates a playlist holding the tracks', names.includes('Inline Made:1'), names.join(','));
await page.evaluate((t) => window.__music.ui.openAddToPlaylist(t), [tracks[3]]);
await add.waitFor();
await add.getByPlaceholder('Filter playlists').fill('inline');
await wait(150);
check('dialog filter narrows playlists', (await add.locator('ul button').count()) === 1);
await page.keyboard.press('Escape');
await wait(150);

// Playlist page: header + collage
await page.evaluate(([id, t]) => window.__music.library.addToPlaylist(id, t), [plId, tracks.slice(3, 6)]);
await wait(200);
check('header shows 2x2 collage of the first 4 distinct covers', (await page.locator('[data-cover-collage] img').count()) === 4);
const meta = await page.locator('[data-meta]').innerText();
check('header shows count and duration', /6 songs/.test(meta) && /(min|hr)/.test(meta), meta);
await shot('playlist');

// Edit: description + URL cover + upload (downscaled <= 100 KB)
await page.getByRole('button', { name: 'Edit', exact: true }).click();
await dlg.waitFor();
await dlg.getByLabel('Name').fill('Road Trip 2');
await dlg.getByLabel('Description').fill('Songs for driving');
await dlg.getByLabel('Cover image URL').fill(tracks[0].cover);
await dlg.getByRole('button', { name: 'Save' }).click();
await wait(300);
const afterUrl = await page.evaluate((id) => window.__music.library.playlist(id), plId);
check('Edit saves name, description and cover URL', afterUrl.name === 'Road Trip 2' && afterUrl.description === 'Songs for driving' && afterUrl.cover === tracks[0].cover);
check('custom cover replaces the collage in the header', (await page.locator('[data-cover-custom]').count()) === 1 && (await page.locator('[data-cover-collage]').count()) === 0);
check('title follows the rename', (await page.title()) === 'Road Trip 2 | Stream Fiesta', await page.title());
// Build a big noisy image to upload.
const dataUrl = await page.evaluate(() => {
  const c = document.createElement('canvas'); c.width = c.height = 1400;
  const x = c.getContext('2d'); const d = x.createImageData(1400, 1400);
  for (let i = 0; i < d.data.length; i += 4) { d.data[i] = Math.random() * 255; d.data[i + 1] = Math.random() * 255; d.data[i + 2] = Math.random() * 255; d.data[i + 3] = 255; }
  x.putImageData(d, 0, 0);
  return c.toDataURL('image/png');
});
const png = join(mkdtempSync(join(tmpdir(), 'p6-')), 'cover.png');
writeFileSync(png, Buffer.from(dataUrl.split(',')[1], 'base64'));
await page.getByRole('button', { name: 'Edit', exact: true }).click();
await dlg.waitFor();
await dlg.getByLabel('Upload cover image').setInputFiles(png);
await page.waitForFunction(() => document.querySelector('[role=dialog] img[src^="data:image"]'), null, { timeout: 15000 });
await dlg.getByRole('button', { name: 'Save' }).click();
await wait(300);
const upl = await page.evaluate((id) => window.__music.library.playlist(id).cover, plId);
const bytes = Math.floor(((upl.split(',')[1] || '').length * 3) / 4);
check('uploaded image becomes a downscaled data URL <= 100 KB', upl.startsWith('data:image/jpeg') && bytes <= 100 * 1024 && bytes > 1000, `${bytes} bytes`);
// Collage button -> data URL cover
await page.getByRole('button', { name: 'Edit', exact: true }).click();
await dlg.waitFor();
await dlg.getByRole('button', { name: 'Remove cover' }).click();
await dlg.getByRole('button', { name: 'Use collage' }).click();
await page.waitForFunction(() => document.querySelector('[role=dialog] img[src^="data:image"]'), null, { timeout: 15000 }).catch(() => {});
const collageMade = await dlg.locator('img[src^="data:image"]').count();
await dlg.getByRole('button', { name: 'Save' }).click();
await wait(300);
check('"Use collage" bakes the 2x2 collage into a data URL only on Save (needs the image proxy)', collageMade === 1 && (await page.evaluate((id) => window.__music.library.playlist(id).cover || '', plId)).startsWith('data:image/jpeg'),
  `collage in dialog: ${collageMade}`);
// reset to auto cover
await page.getByRole('button', { name: 'Edit', exact: true }).click();
await dlg.waitFor();
await dlg.getByRole('button', { name: 'Remove cover' }).click();
await dlg.getByRole('button', { name: 'Save' }).click();
await wait(300);

// Play / Shuffle with playlist context
await page.getByRole('button', { name: 'Play', exact: true }).first().click();
await until((id) => window.__music.player.context()?.id === id, plId, 20000);
const pc = await page.evaluate(() => ({ type: window.__music.player.context()?.type, label: window.__music.player.context()?.label, n: window.__music.player.queue().length }));
check('Play queues the playlist with context userPlaylist', pc.type === 'userPlaylist' && pc.label === 'Road Trip 2' && pc.n === 6, JSON.stringify(pc));
await page.getByRole('button', { name: 'Shuffle', exact: true }).first().click();
await until(() => window.__music.player.shuffle(), null, 20000);
check('Shuffle on the playlist turns shuffle on', await page.evaluate(() => window.__music.player.shuffle()));
await page.evaluate(() => window.__music.player.pause?.());

// Sort + drag
const order = () => page.evaluate((id) => window.__music.library.playlist(id).tracks.map((t) => t.id), plId);
const before = await order();
const sortOptsPl = await page.locator('#music-playlist-sort option').allInnerTexts();
check('sort select offers Custom order plus the track sorts', sortOptsPl.join(',') === 'Custom order,Recently added,Title,Artist,Album,Duration', sortOptsPl.join(','));
await page.selectOption('#music-playlist-sort', 'title');
await wait(150);
check('drag handles and move buttons are hidden unless sort is Custom', (await page.locator('[cdkDragHandle], [data-move]').count()) === 0);
await page.selectOption('#music-playlist-sort', 'custom');
await wait(150);
// Keyboard move
await page.locator('[data-row="1"] [data-move="down"]').focus();
await page.keyboard.press('Enter');
await wait(200);
const afterMove = await order();
check('keyboard Move down swaps the track with the next one', afterMove[1] === before[2] && afterMove[2] === before[1], afterMove.join(','));
check('focus stays on the moved track\'s button', await page.evaluate(() => !!document.activeElement?.closest('[data-row="2"]')));
await page.locator('[data-row="2"] [data-move="up"]').click();
await wait(200);
check('Move up restores the order', (await order()).join() === before.join());
// Mouse drag with the CDK handle
const h0 = await page.locator('[data-row="0"] [cdkDragHandle]').boundingBox();
const h2 = await page.locator('[data-row="3"] [cdkDragHandle]').boundingBox();
await page.mouse.move(h0.x + h0.width / 2, h0.y + h0.height / 2);
await page.mouse.down();
for (let i = 1; i <= 12; i++) await page.mouse.move(h0.x + h0.width / 2, h0.y + (h2.y - h0.y) * (i / 12) + h0.height, { steps: 2 });
await page.mouse.up();
await wait(400);
const afterDrag = await order();
check('CDK drag-and-drop reorders the playlist (custom sort)', afterDrag[0] !== before[0] && afterDrag.join() !== before.join() && [...afterDrag].sort().join() === [...before].sort().join(), afterDrag.join(','));
// Remove + undo
const rm = (await order())[0];
await page.locator('[data-row="0"] [data-remove]').click();
await wait(200);
check('remove track drops it from the playlist', !(await order()).includes(rm) && (await order()).length === 5);
await page.getByRole('button', { name: 'Undo' }).first().click();
await wait(300);
check('Undo puts the removed track back', (await order()).includes(rm) && (await order()).length === 6);

// Recommended songs (P9's recommender is a stub that returns [], so feed it one)
const recDone = await page.evaluate(async (more) => {
  const comp = window.ng?.getComponent?.(document.querySelector('app-music-user-playlist'));
  if (!comp) return 'nocomp';
  comp.recommender.forPlaylist = async (t, limit) => { window.__recArgs = { n: t.length, limit }; return more; };
  await comp.refreshRecs();
  return 'ok';
}, more);
await wait(300);
const recArgs = await page.evaluate(() => window.__recArgs);
const recBtns = await page.locator('[data-recs] [data-add-rec]').count();
check('"Recommended songs" asks recommender.forPlaylist(tracks, 10) and lists results with Add', recDone === 'ok' && recArgs?.limit === 10 && recArgs?.n === 6 && recBtns === more.length, `${recDone} ${JSON.stringify(recArgs)} buttons=${recBtns}`);
await page.locator('[data-recs] [data-add-rec]').first().click();
await wait(250);
check('Add puts the recommendation into the playlist and removes it from the list', (await order()).length === 7 && (await page.locator('[data-recs] [data-add-rec]').count()) === more.length - 1);

// Share
await page.getByRole('button', { name: 'Share', exact: true }).click();
await wait(400);
const clip = await page.evaluate(() => navigator.clipboard.readText()).catch(() => '');
check('Share copies a /music/shared?d= link', /\/music\/shared\?d=/.test(clip) && clip.startsWith(base), clip.slice(0, 80));

// Delete (confirm)
await page.evaluate(() => window.__music.library.createPlaylist('Temp', [])); // keep another
await page.getByRole('button', { name: 'Delete', exact: true }).click();
await page.locator('[role=dialog]').waitFor();
await page.locator('[role=dialog]').getByRole('button', { name: 'Cancel' }).click();
check('Delete asks for confirmation (Cancel keeps it)', !!(await page.evaluate((id) => window.__music.library.playlist(id), plId)));
await page.getByRole('button', { name: 'Delete', exact: true }).click();
await page.locator('[data-confirm-delete]').click();
await page.waitForURL(/\/music\/library\?tab=playlists/);
check('confirming Delete removes the playlist and returns to the Playlists tab', !(await page.evaluate((id) => window.__music.library.playlist(id), plId)));
await boot('/music/library/playlist/does-not-exist');
check('unknown playlist id shows a not-found state with an h1', (await page.locator('main h1').first().innerText()).includes('not found') && (await page.title()) === 'Playlist | Stream Fiesta');

// ── 5. Folders and pins ─────────────────────────────────────────────────────
await boot('/music/library?tab=playlists');
await page.evaluate((t) => {
  const l = window.__music.library;
  ['Alpha', 'Beta', 'Gamma', 'Delta'].forEach((n) => l.createPlaylist(n, t.slice(0, 2)));
}, tracks);
await boot('/music/library?tab=playlists');
await page.waitForSelector('[data-user-playlist]');
await page.getByRole('button', { name: 'New folder' }).click();
await page.locator('[role=dialog]').waitFor();
await page.locator('#music-folder-name').fill('Chill');
await page.locator('[role=dialog]').getByRole('button', { name: 'Save' }).click();
await wait(200);
check('New folder creates a folder chip', (await page.locator('[data-folder-chip]').allInnerTexts()).join() === 'Chill');
await page.getByRole('button', { name: 'All', exact: true }).click();
const alphaCard = page.locator('[data-user-playlist]', { hasText: 'Alpha' });
await alphaCard.getByRole('button', { name: /Move Alpha to folder/ }).click();
check('Move to folder is a menu (aria-haspopup, expanded)', (await alphaCard.getByRole('button', { name: /Move Alpha to folder/ }).getAttribute('aria-expanded')) === 'true' && (await page.getByRole('menu').count()) === 1);
await page.getByRole('menuitem', { name: 'Chill' }).click();
await wait(200);
const folderOf = (name) => page.evaluate((n) => { const l = window.__music.library; const p = l.playlists().find((x) => x.name === n); return l.folders().find((f) => f.id === p.folderId)?.name ?? null; }, name);
check('Move to folder assigns the playlist to the folder', (await folderOf('Alpha')) === 'Chill');
await page.locator('[data-folder-chip]').click();
await wait(200);
check('selecting the folder chip filters the playlists', (await page.locator('[data-user-playlist]').count()) === 1);
await alphaCard.getByRole('button', { name: /Move Alpha to folder/ }).click();
await page.getByRole('menuitem', { name: 'Remove from folder' }).click();
await wait(200);
check('"Remove from folder" empties the folder assignment', (await folderOf('Alpha')) === null && (await page.locator('[data-user-playlist]').count()) === 0);
await page.getByRole('button', { name: 'Rename folder' }).click();
await page.locator('#music-folder-name').fill('Calm');
await page.locator('[role=dialog]').getByRole('button', { name: 'Save' }).click();
await wait(200);
check('Rename folder updates the chip', (await page.locator('[data-folder-chip]').allInnerTexts()).join() === 'Calm');
await page.getByRole('button', { name: 'Delete folder' }).click();
await page.locator('[role=dialog]').getByRole('button', { name: 'Delete' }).click();
await wait(200);
check('Delete folder removes the chip and keeps the playlists', (await page.locator('[data-folder-chip]').count()) === 0 && (await page.evaluate(() => window.__music.library.playlists().length)) >= 4);
await shot('library-playlists');

// Pins
await page.getByRole('button', { name: 'All', exact: true }).click().catch(() => {});
for (const n of ['Alpha', 'Beta', 'Gamma']) await page.locator('[data-user-playlist]', { hasText: n }).getByRole('button', { name: new RegExp('^Pin ' + n) }).click();
await wait(200);
check('Pin action pins up to 3 items', (await page.evaluate(() => window.__music.library.pins().length)) === 3);
await page.locator('[data-user-playlist]', { hasText: 'Delta' }).getByRole('button', { name: /^Pin Delta/ }).click();
await wait(200);
check('a 4th pin is refused with a toast', (await page.evaluate(() => window.__music.library.pins().length)) === 3 && /up to 3/.test(await page.locator('body').innerText()));
check('pinned row is shown at the top of Library', (await page.locator('app-music-pins-row [data-pin]').count()) === 3
  && await page.evaluate(() => { const r = document.querySelector('app-music-pins-row'); const t = document.querySelector('[role=tablist]'); return !!(r.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_FOLLOWING); }));
await page.locator('app-music-pins-row').getByRole('button', { name: 'Unpin Alpha' }).click();
await wait(200);
check('Unpin removes the item from the row', (await page.locator('app-music-pins-row [data-pin]').count()) === 2);
await shot('library-pins');

// ── 6. Recent ───────────────────────────────────────────────────────────────
await boot('/music/recent');
await page.waitForSelector('main h1');
check('empty Recent shows an empty state', (await page.locator('[data-empty]').count()) === 1 && (await page.title()) === 'Recently played | Stream Fiesta', await page.title());
const now = Date.now();
const day = 24 * 3600 * 1000;
await page.evaluate(([t, now, day]) => {
  const e = [
    { track: t[0], playedAt: now - 60000 }, { track: t[1], playedAt: now - 120000 },
    { track: t[2], playedAt: now - day - 3600000 }, { track: t[3], playedAt: now - 5 * day }, { track: t[4], playedAt: now - 9 * day },
  ];
  localStorage.setItem('fiesta:music:history', JSON.stringify(e));
}, [tracks, now, day]);
await boot('/music/recent');
await page.waitForSelector('app-music-track-row');
const groups = await page.locator('[data-group]').allInnerTexts();
// "Yesterday" can fall into Today when the clock is just after midnight; compute what the page should show.
const exp = await page.evaluate(([now, day]) => {
  const s = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const today = s(now); const y = s(today - 12 * 3600 * 1000);
  const ts = [now - 60000, now - 120000, now - day - 3600000, now - 5 * day, now - 9 * day];
  const g = ts.map((x) => (x >= today ? 'Today' : x >= y ? 'Yesterday' : 'Earlier'));
  return [...new Set(g)];
}, [now, day]);
check('history is grouped Today / Yesterday / Earlier', groups.join() === exp.join() && groups.includes('Earlier'), groups.join());
// play from here
await page.locator('app-music-track-row').nth(2).getByRole('button', { name: /^Play / }).click();
await until(() => window.__music.player.queue().length > 0, null, 20000);
const q = await page.evaluate(() => ({ ids: window.__music.player.queue().map((t) => t.id), cur: window.__music.player.track()?.id }));
check('play-from-here queues the rest of the list', q.ids.length === 3 && q.cur === tracks[2].id && q.ids[0] === tracks[2].id, JSON.stringify(q.ids));
await page.evaluate(() => window.__music.player.pause?.());
await shot('recent');
await page.getByRole('button', { name: 'Clear history' }).first().click();
await page.locator('[role=dialog]').getByRole('button', { name: 'Clear history' }).click();
await wait(200);
check('Clear history (confirm) empties the page and the store', (await page.evaluate(() => window.__music.library.history().length)) === 0 && (await page.locator('[data-empty]').count()) === 1);

// ── 7. Quality ──────────────────────────────────────────────────────────────
await boot('/music/library');
await page.waitForSelector('main h1');
const noAmber = await page.evaluate(() => !document.querySelector('main .text-red-400, main .text-red-500'));
const smalls = await page.evaluate(() => [...document.querySelectorAll('main > div button')].filter((b) => b.offsetParent && b.getBoundingClientRect().height < 40).map((b) => b.getAttribute('aria-label') || b.textContent.trim()).slice(0, 5));
check('no red text, buttons >= 40px tall on the Library page', noAmber && smalls.length === 0, smalls.join(','));
check('no uncaught page errors', errors.length === 0, errors.slice(0, 3).join(' | '));

await browser.close();
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
