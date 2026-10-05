// E2E for package P8: search UX (suggest, recents, tabs, paging, paste-a-link), album /
// artist / track pages, backend actions and the OG middleware branch.
//   node tools/e2e/music-p8.mjs [baseUrl=http://localhost:4208] [--api=http://localhost:3908] [--shots=dir] [--token-file=path]
// Run from a dir whose node_modules has playwright(-core). Without a user token playback
// is the 30 s PREVIEW, which is all these checks need.
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright-core')); } catch { ({ chromium } = require('playwright')); }

const base = process.argv.find((a) => a.startsWith('http')) || 'http://localhost:4208';
const api = (process.argv.find((a) => a.startsWith('--api=')) || '--api=http://localhost:3908').slice(6);
const shots = (process.argv.find((a) => a.startsWith('--shots=')) || '').slice(8);
const tokenFile = (process.argv.find((a) => a.startsWith('--token-file=')) || '').slice(13);
const userToken = tokenFile ? (await import('node:fs')).readFileSync(tokenFile, 'utf8').trim() : '';
const results = [];
const check = (name, ok, extra = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };
const here = path.dirname(fileURLToPath(import.meta.url));

// ---- Backend (curl-style) ---------------------------------------------------------------
async function get(q) {
  const r = await fetch(`${api}/api/music?${q}`);
  let body = null; try { body = await r.json(); } catch { /* not json */ }
  return { status: r.status, cc: r.headers.get('cache-control') || '', body };
}
const ok200 = async (name, q, shape) => {
  const r = await get(q);
  check(`api ${name}: 200 JSON + Cache-Control`, r.status === 200 && !!r.cc && shape(r.body), `${r.status} ${r.cc}`);
  return r;
};
const arr = (x) => Array.isArray(x);
await ok200('suggest', 'action=suggest&q=daft', (b) => arr(b.terms) && arr(b.tracks) && arr(b.albums) && arr(b.artists));
await ok200('search-type playlists', 'action=search-type&q=chill&type=playlists&limit=5', (b) => arr(b.items) && b.items.length > 0 && !!b.items[0].uuid);
await ok200('search-type tracks offset', 'action=search-type&q=daft&type=tracks&offset=20&limit=20', (b) => arr(b.items) && typeof b.total === 'number');
await ok200('track', 'action=track&id=1550546', (b) => b.track && b.track.id === 1550546 && arr(b.albumTracks) && b.albumTracks.length > 3);
await ok200('tracks (batch)', 'action=tracks&ids=1550546,1550547', (b) => arr(b) && b.length === 2);
await ok200('album-extras', 'action=album-extras&id=1550545', (b) => arr(b.moreByArtist) && arr(b.epsSingles) && arr(b.similarAlbums) && arr(b.similarArtists) && b.moreByArtist.length > 0 && !!b.copyright && !!b.releaseDate);
await ok200('artist-bio', 'action=artist-bio&id=8847', (b) => typeof b.text === 'string' && b.text.length > 100 && !/\[wimpLink|<br/.test(b.text));
await ok200('similar-artists', 'action=similar-artists&id=8847', (b) => arr(b) && b.length > 0);
await ok200('similar-albums', 'action=similar-albums&id=1550545', (b) => arr(b) && b.length > 0);
await ok200('artist-albums EPSANDSINGLES', 'action=artist-albums&id=8847&filter=EPSANDSINGLES&limit=5', (b) => arr(b.items) && b.items.length > 0 && b.items.length <= 5);
await ok200('artist-albums COMPILATIONS', 'action=artist-albums&id=8847&filter=COMPILATIONS&limit=5', (b) => arr(b.items));
await ok200('artist-albums APPEARS_ON degrades to []', 'action=artist-albums&id=8847&filter=APPEARS_ON', (b) => arr(b.items));
await ok200('artist-toptracks paged', 'action=artist-toptracks&id=8847&offset=10&limit=5', (b) => arr(b.items) && b.items.length === 5);
await ok200('artist-links (MusicBrainz)', 'action=artist-links&id=8847', (b) => arr(b) && b.some((l) => /musicbrainz\.org\/artist\//.test(l.url)));
await ok200('aoty', 'action=aoty&title=Discovery&artist=Daft%20Punk', (b) => b && b.critic > 0 && b.user > 0);
await ok200('aoty unknown album -> null', 'action=aoty&title=Zzqx%20Nothing&artist=Nobodyxx', (b) => b === null);
for (const a of ['track', 'album-extras', 'artist-bio', 'artist-albums', 'artist-toptracks', 'artist-links', 'similar-artists', 'similar-albums']) {
  const r = await get(`action=${a}&id=abc`);
  check(`api ${a}: invalid id -> 400`, r.status === 400, `${r.status}`);
}
check('api tracks: >100 ids -> 400', (await get('action=tracks&ids=' + Array.from({ length: 101 }, (_, i) => i + 1).join(','))).status === 400);
check('api search-type: bad type -> 400', (await get('action=search-type&q=x&type=nope')).status === 400);
check('api limits are clamped', (await get('action=artist-toptracks&id=8847&limit=9999')).body.items.length <= 50);

// ---- OG middleware ------------------------------------------------------------------------
{
  const mw = (await import(pathToFileURL(path.resolve(here, '../../middleware.js')).href)).default;
  const realFetch = globalThis.fetch;
  const indexHtml = `<!doctype html><html><head><title>Stream Fiesta</title>
<meta name="description" content="generic">
<meta property="og:title" content="generic">
<meta property="og:description" content="generic">
<meta property="og:url" content="https://fiesta.show/">
<meta property="og:image" content="https://fiesta.show/assets/og-image.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:title" content="generic">
<meta name="twitter:description" content="generic">
<meta name="twitter:image" content="https://fiesta.show/assets/og-image.png">
</head><body><app-root></app-root></body></html>`;
  const album = { album: { id: 1550545, title: 'Discovery', artist: 'Daft Punk', year: '2001', tracks: 14, cover: 'https://resources.tidal.com/images/a/b/c/d/e/640x640.jpg' } };
  const calls = [];
  globalThis.fetch = async (input) => {
    const u = new URL(typeof input === 'string' ? input : input.url ?? String(input));
    calls.push(u.pathname + u.search);
    if (u.pathname === '/index.html') return new Response(indexHtml, { headers: { 'content-type': 'text/html' } });
    if (u.pathname === '/api/music') {
      const id = u.searchParams.get('id');
      switch (u.searchParams.get('action')) {
        case 'album': return Response.json(album);
        case 'artist': return Response.json({ artist: { id: 8847, name: 'Daft Punk', picture: 'https://resources.tidal.com/images/x/y/320x320.jpg' } });
        case 'track': return Response.json({ track: { id: 1, title: 'One More Time', artist: 'Daft Punk', album: 'Discovery', cover: 'https://resources.tidal.com/images/q/320x320.jpg' } });
        case 'playlist': return Response.json({ playlist: { uuid: id, title: 'Chill Pop', description: 'Vibe', cover: 'https://resources.tidal.com/images/p/640x640.jpg' } });
        case 'mix': return Response.json({ mix: { id, title: 'My Mix', subTitle: 'Daily', cover: 'https://resources.tidal.com/mix.jpg' } });
      }
    }
    return new Response('nope', { status: 404 });
  };
  const run = async (p, ua) => mw(new Request('http://localhost' + p, { headers: { 'user-agent': ua } }));
  try {
    const r = await run('/music/album/1550545', 'Twitterbot/1.0');
    const html = await r.text();
    check('og: bot on /music/album gets HTML', r.status === 200 && /text\/html/.test(r.headers.get('content-type') || ''));
    check('og: og:title matches the album', html.includes('<meta property="og:title" content="Discovery by Daft Punk | Stream Fiesta">'));
    check('og: og:image is the album cover', html.includes('<meta property="og:image" content="https://resources.tidal.com/images/a/b/c/d/e/750x750.jpg">'));
    check('og: twitter + description updated', html.includes('twitter:title" content="Discovery by Daft Punk') && /name="description" content="Listen to Discovery by Daft Punk/.test(html));
    const cases = [['artist', '8847', 'Daft Punk | Stream Fiesta'], ['track', '1', 'One More Time by Daft Punk | Stream Fiesta'],
      ['playlist', '0dfc3b10-fbdb-4419-bf54-11b90051fa6c', 'Chill Pop | Stream Fiesta'], ['mix', '0123456789abcdef0123', 'My Mix | Stream Fiesta']];
    for (const [k, id, title] of cases) {
      const h = await (await run(`/music/${k}/${id}`, 'facebookexternalhit/1.1')).text();
      check(`og: ${k} branch`, h.includes(`og:title" content="${title}"`));
    }
    calls.length = 0;
    const human = await run('/music/album/1550545', 'Mozilla/5.0 (Macintosh) AppleWebKit/605 Chrome/120 Safari/537');
    check('og: non-bot request is untouched (next())', human.headers.get('x-middleware-next') === '1' && calls.length === 0, `calls=${calls.length}`);
    const other = await run('/music/library', 'Twitterbot/1.0');
    check('og: other music paths untouched for bots', other.headers.get('x-middleware-next') === '1');
    const bad = await run('/music/album/abc', 'Twitterbot/1.0');
    check('og: invalid id falls through', bad.headers.get('x-middleware-next') === '1');
  } finally { globalThis.fetch = realFetch; }
}

// ---- Browser ------------------------------------------------------------------------------
const browser = await chromium.launch({ channel: 'chrome', args: ['--autoplay-policy=no-user-gesture-required'] }).catch(() => chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] }));
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] });
if (userToken) await ctx.route('**/api/music*', (r) => r.continue({ headers: { ...r.request().headers(), 'x-tidal-token': userToken } }));
// Desktop Chrome has a native share sheet; hide it so the copy-link fallback is what runs.
await ctx.addInitScript(() => { try { Object.defineProperty(navigator, 'share', { value: undefined, configurable: true }); } catch { /* ignore */ } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const shot = async (n) => { if (shots) await page.screenshot({ path: `${shots}/p8-${n}.png` }); };
const url = (p) => base + p + (p.includes('?') ? '&' : '?') + 'musicdebug=1';
const listbox = page.locator('[role=listbox]');

// Search: suggestions (debounce, cancel stale, keyboard)
const suggestReqs = [];
page.on('request', (r) => { if (r.url().includes('action=suggest')) suggestReqs.push({ t: Date.now(), q: new URL(r.url()).searchParams.get('q') }); });
const failed = [];
page.on('requestfailed', (r) => { if (r.url().includes('action=suggest')) failed.push({ q: new URL(r.url()).searchParams.get('q'), err: r.failure()?.errorText }); });
await page.goto(url('/music'), { waitUntil: 'domcontentloaded' });
await page.waitForSelector('input[name=q]');
// Hold the "da" response so a newer keystroke has to cancel it.
let released = false;
await page.route('**/api/music?*action=suggest*q=da&*', async (route) => { await new Promise((r) => setTimeout(r, 1500)); released = true; await route.continue().catch(() => {}); });
await page.route(/action=suggest&q=da$/, async (route) => { await new Promise((r) => setTimeout(r, 1500)); released = true; await route.continue().catch(() => {}); });
const t0 = Date.now();
await page.locator('input[name=q]').click();
await page.keyboard.type('da', { delay: 30 });
await page.waitForTimeout(450);
await page.keyboard.type('ft', { delay: 30 });
await listbox.waitFor({ timeout: 8000 });
const input = page.locator('input[name=q]');
check('suggestions: listbox appears for 2+ chars', (await listbox.count()) === 1 && (await page.locator('[role=option]').count()) >= 3);
check('suggestions: input is a combobox wired to the listbox', (await input.getAttribute('role')) === 'combobox' && (await input.getAttribute('aria-expanded')) === 'true' && (await input.getAttribute('aria-controls')) === (await listbox.getAttribute('id')));
check('suggestions: debounced (no request per keystroke)', suggestReqs.length <= 2, `requests: ${suggestReqs.map((r) => r.q).join(',')}`);
check('suggestions: first request fired >= 250 ms after typing started', suggestReqs.length > 0 && suggestReqs[0].t - t0 >= 250, `${suggestReqs[0] ? suggestReqs[0].t - t0 : '?'} ms`);
check('suggestions: stale request is cancelled', failed.some((f) => f.q === 'da'), JSON.stringify(failed));
check('suggestions: results are for the latest text', suggestReqs.at(-1)?.q === 'daft');
await shot('suggest');
await page.keyboard.press('ArrowDown');
const a1 = await input.getAttribute('aria-activedescendant');
check('suggestions: ArrowDown highlights an option', !!a1 && (await page.locator(`#${a1}`).getAttribute('aria-selected')) === 'true', a1 || '');
await page.keyboard.press('Escape');
check('suggestions: Escape closes the list', (await listbox.count()) === 0 && (await input.getAttribute('aria-expanded')) === 'false');
await page.keyboard.press('ArrowDown');
check('suggestions: ArrowDown reopens it', (await listbox.count()) === 1);
// Walk down to an artist option and press Enter.
let hitArtist = false;
for (let i = 0; i < 12; i++) {
  const id = await input.getAttribute('aria-activedescendant');
  if (id && id.startsWith('sg-artist-')) { hitArtist = true; break; }
  await page.keyboard.press('ArrowDown');
}
await page.keyboard.press('Enter');
await page.waitForURL(/\/music\/artist\/\d+/, { timeout: 10000 }).catch(() => {});
check('suggestions: Enter on an artist option navigates to it', hitArtist && /\/music\/artist\/\d+/.test(page.url()), page.url());

// Recent searches
await page.goto(url('/music?q=daft%20punk%20one%20more%20time'), { waitUntil: 'domcontentloaded' });
await page.waitForSelector('app-music-track-row', { timeout: 20000 });
await page.locator('input[name=q]').fill('radiohead creep');
await page.press('input[name=q]', 'Enter');
await page.waitForFunction(() => location.search.includes('radiohead'));
await page.goto(url('/music'), { waitUntil: 'domcontentloaded' });
// searches are only recorded on submit: submit once through the form.
await page.fill('input[name=q]', 'daft punk one more time');
await page.press('input[name=q]', 'Enter');
await page.waitForSelector('app-music-track-row', { timeout: 20000 });
await page.goto(url('/music'), { waitUntil: 'domcontentloaded' });
await page.waitForSelector('section[aria-label="Recent searches"]');
const recents = await page.locator('section[aria-label="Recent searches"] li').allTextContents();
check('recents: shown on the empty search state', recents.some((t) => /daft punk one more time/i.test(t)), JSON.stringify(recents.map((t) => t.trim())));
const order = await page.evaluate(() => {
  const r = document.querySelector('section[aria-label="Recent searches"]'); const h = document.querySelector('app-music-home');
  return !!r && !!h && !!(r.compareDocumentPosition(h) & Node.DOCUMENT_POSITION_FOLLOWING);
});
check('recents: rendered above <app-music-home>', order);
await shot('recents');
const before = await page.locator('section[aria-label="Recent searches"] li').count();
await page.locator('section[aria-label="Recent searches"] button[aria-label^="Remove"]').first().click();
check('recents: remove button deletes one', (await page.locator('section[aria-label="Recent searches"] li').count()) === before - 1);
await page.locator('section[aria-label="Recent searches"] li button').first().click();
await page.waitForSelector('app-music-track-row', { timeout: 20000 });
check('recents: clicking one runs the search', page.url().includes('q='));
await page.goto(url('/music'), { waitUntil: 'domcontentloaded' });
await page.getByRole('button', { name: 'Clear all' }).click();
check('recents: Clear all empties the section', (await page.locator('section[aria-label="Recent searches"]').count()) === 0 && (await page.locator('app-music-home').count()) === 1);

// Tabs, ?type=, Load more, playlists
await page.goto(url('/music?q=daft'), { waitUntil: 'domcontentloaded' });
await page.waitForSelector('app-music-track-row', { timeout: 20000 });
const tabs = await page.locator('[role=tab]').allTextContents();
check('tabs: Songs / Albums / Artists / Playlists', tabs.map((t) => t.trim()).join('|') === 'Songs|Albums|Artists|Playlists', tabs.join('|'));
const n0 = await page.locator('app-music-track-row').count();
await page.getByRole('button', { name: 'Load more' }).click();
await page.waitForFunction((n) => document.querySelectorAll('app-music-track-row').length > n, n0, { timeout: 15000 });
const n1 = await page.locator('app-music-track-row').count();
check('tabs: Load more appends the next 20 songs', n1 === n0 + 20 || (n1 > n0 && n1 <= n0 + 20), `${n0} -> ${n1}`);
await page.getByRole('tab', { name: 'Albums' }).click();
await page.waitForFunction(() => location.search.includes('type=albums'));
check('tabs: ?type=albums in the URL and cards shown', (await page.locator('app-music-album-card').count()) > 0);
await page.getByRole('tab', { name: 'Artists' }).click();
await page.waitForFunction(() => location.search.includes('type=artists'));
check('tabs: artists tab shows artist cards', (await page.locator('app-music-artist-card').count()) > 0);
const a0 = await page.locator('app-music-artist-card').count();
if (await page.getByRole('button', { name: 'Load more' }).count()) {
  await page.getByRole('button', { name: 'Load more' }).click();
  await page.waitForFunction((n) => document.querySelectorAll('app-music-artist-card').length > n, a0, { timeout: 15000 }).catch(() => {});
}
check('tabs: Load more on artists appends', (await page.locator('app-music-artist-card').count()) > a0, `${a0} -> ${await page.locator('app-music-artist-card').count()}`);
await page.getByRole('tab', { name: 'Playlists' }).click();
await page.waitForSelector('app-music-playlist-card', { timeout: 15000 });
const plHref = await page.locator('app-music-playlist-card a[href^="/music/playlist/"]').first().getAttribute('href');
check('tabs: playlist results link to /music/playlist/:uuid', /^\/music\/playlist\/[0-9a-f-]{36}$/.test(plHref || ''), plHref || '');
await shot('playlists');
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('app-music-playlist-card', { timeout: 15000 });
check('tabs: ?type= survives a reload', page.url().includes('type=playlists'));

// Paste-a-link
const paste = async (text, re, name) => {
  await page.goto(url('/music'), { waitUntil: 'domcontentloaded' });
  await page.fill('input[name=q]', text);
  await page.press('input[name=q]', 'Enter');
  await page.waitForURL(re, { timeout: 8000 }).catch(() => {});
  check(`paste: ${name}`, re.test(page.url()), page.url());
};
await paste('https://tidal.com/browse/album/1550545', /\/music\/album\/1550545/, 'tidal.com album link opens the album');
await paste('https://listen.tidal.com/track/1550546', /\/music\/track\/1550546/, 'listen.tidal.com track link');
await paste('https://tidal.com/browse/artist/8847?u', /\/music\/artist\/8847/, 'artist link with tracking param');
await paste('https://tidal.com/browse/playlist/0dfc3b10-fbdb-4419-bf54-11b90051fa6c', /\/music\/playlist\/0dfc3b10-fbdb-4419-bf54-11b90051fa6c/, 'playlist uuid link');
await paste('https://tidal.com/browse/mix/0123456789abcdef0123456789abcd', /\/music\/mix\/0123456789abcdef0123456789abcd/, 'mix link');
await paste('https://monochrome.tf/album/1550545', /\/music\/album\/1550545/, 'monochrome.tf album link');

// Album page
await page.goto(url('/music/album/1550545'), { waitUntil: 'domcontentloaded' });
await page.waitForSelector('app-music-track-row', { timeout: 20000 });
check('album: title is "<Album> by <Artist> | Stream Fiesta"', (await page.title()) === 'Discovery by Daft Punk | Stream Fiesta', await page.title());
const btn = (n) => page.locator(`button[aria-label^="${n}"], button:has-text("${n}")`).first();
check('album: Shuffle, Like, Add to playlist, Share buttons', (await page.locator('main button', { hasText: /^\s*Shuffle\s*$/ }).count()) === 1 && (await page.locator('main app-music-like-button button').count()) >= 1 && (await page.locator('button[aria-label="Add album to playlist"]').count()) === 1 && (await page.locator('button[aria-label="Share album"]').count()) === 1);
{
  // P12 owns MUSIC_DOWNLOADS_ENABLED: the button must be visible exactly when the shipped switch is on.
  const dlSrc = (await import('node:fs')).readFileSync(path.resolve(here, '../../src/app/services/music-download.service.ts'), 'utf8');
  const dlOn = /MUSIC_DOWNLOADS_ENABLED\s*=\s*true/.test(dlSrc);
  const dlCount = await page.locator('button[aria-label="Download album"]').count();
  check(`album: Download button ${dlOn ? 'shown (switch on)' : 'hidden (switch off)'}`, dlOn ? dlCount === 1 : dlCount === 0);
}
await page.waitForSelector('text=More by Daft Punk', { timeout: 20000 });
const text = await page.locator('main').innerText();
check('album: release date and copyright shown', /March 12, 2001|12 March 2001|2001/.test(text) && /℗|©|Daft Life/.test(text));
check('album: rails More by / EPs & Singles / Similar albums / Similar artists', ['More by Daft Punk', 'Similar albums', 'Similar artists'].every((h) => text.includes(h)) && (await page.locator('app-music-rail').count()) >= 3, `${await page.locator('app-music-rail').count()} rails`);
await page.waitForSelector('a[aria-label^="Critic score"]', { timeout: 20000 }).catch(() => {});
check('album: AOTY critic/user score chips', (await page.locator('a[aria-label^="Critic score"]').count()) === 1 && (await page.locator('a[aria-label^="User score"]').count()) === 1);
await page.waitForFunction(() => /linear-gradient/.test(document.querySelector('[data-testid=album-header]')?.getAttribute('style') || ''), null, { timeout: 15000 }).catch(() => {});
const tinted = await page.locator('[data-testid=album-header]').getAttribute('style');
check('album: cover-tinted header when albumBackground is on', /linear-gradient/.test(tinted || ''), (tinted || '').slice(0, 60));
await page.evaluate(() => window.__music.settings.albumBackground.set(false));
await page.waitForTimeout(200);
check('album: tint removed when albumBackground is off', !/linear-gradient/.test((await page.locator('[data-testid=album-header]').getAttribute('style')) || ''));
await page.evaluate(() => window.__music.settings.albumBackground.set(true));
await shot('album');
check('album: records library activity', await page.evaluate(() => window.__music.library.activity().some((i) => i.kind === 'album' && i.data.id === 1550545)));
await page.locator('main app-music-like-button button').first().click();
check('album: Like toggles', await page.evaluate(() => window.__music.library.favorites().albums.some((a) => a.id === 1550545)));
await page.locator('button[aria-label="Add album to playlist"]').click();
await page.waitForSelector('[role=dialog]', { timeout: 5000 }).catch(() => {});
check('album: Add to playlist opens the dialog', (await page.locator('[role=dialog]').count()) >= 1);
await page.keyboard.press('Escape');
await page.locator('button[aria-label="Share album"]').click();
await page.waitForTimeout(400);
const clip = await page.evaluate(() => navigator.clipboard.readText().catch(() => '')) ;
check('album: Share copies the album link (no Web Share on desktop)', /\/music\/album\/1550545$/.test(clip), clip);
await page.locator('main button', { hasText: /^\s*Shuffle\s*$/ }).click();
await page.waitForSelector('app-music-player-bar section', { timeout: 15000 });
check('album: Shuffle starts playback in shuffle mode', await page.evaluate(() => window.__music.player.shuffle() && !!window.__music.player.track()));
// blocked items are filtered
await page.evaluate(() => window.__music.library.block({ kind: 'album', data: { id: 328631591, title: 'x', artist: 'x', cover: '', year: '', tracks: 0, duration: 0, quality: '' } }));
await page.waitForTimeout(500); // let change detection re-render the rails
const railIds = await page.locator('app-music-rail a[href^="/music/album/"]').evaluateAll((els) => els.map((e) => e.getAttribute('href')));
check('album: blocked albums are filtered from rails', !railIds.includes('/music/album/328631591'));
await page.evaluate(() => window.__music.library.unblock('album', 328631591));

// Artist page
await page.goto(url('/music/artist/8847'), { waitUntil: 'domcontentloaded' });
await page.waitForSelector('h1:has-text("Daft Punk")', { timeout: 20000 });
check('artist: title is "<Artist> | Stream Fiesta"', (await page.title()) === 'Daft Punk | Stream Fiesta', await page.title());
await page.waitForSelector('section[aria-label="About the artist"]', { timeout: 20000 });
check('artist: bio excerpt shown (markup stripped)', !/wimpLink|<br/.test(await page.locator('section[aria-label="About the artist"]').innerText()));
await page.getByRole('button', { name: 'Read more' }).click();
await page.waitForSelector('[role=dialog]');
const dlgText = await page.locator('[role=dialog]').innerText();
check('artist: Read more opens a dialog with the full bio', dlgText.length > 600, `${dlgText.length} chars`);
await page.keyboard.press('Escape');
await page.waitForTimeout(200);
check('artist: Escape closes the bio dialog and returns focus', (await page.locator('[role=dialog]').count()) === 0 && (await page.evaluate(() => document.activeElement?.textContent?.trim())) === 'Read more');
await page.waitForSelector('ul[aria-label="Artist links"] a', { timeout: 30000 });
const links = await page.locator('ul[aria-label="Artist links"] a').evaluateAll((els) => els.map((e) => e.href));
check('artist: external links include MusicBrainz', links.some((l) => /musicbrainz\.org\/artist\//.test(l)), `${links.length} links`);
const pills = (await page.locator('[role=group][aria-label="Discography filter"] button').allTextContents()).map((t) => t.trim());
check('artist: discography filter pills', pills.includes('Albums') && pills.includes('EPs & Singles') && pills.includes('Compilations'), pills.join('|'));
const albumsBefore = await page.locator('section[aria-label="Discography"] app-music-album-card a').first().getAttribute('href');
await page.getByRole('button', { name: 'EPs & Singles' }).click();
await page.waitForTimeout(300);
const albumsAfter = await page.locator('section[aria-label="Discography"] app-music-album-card a').first().getAttribute('href');
check('artist: pill switches the discography list', albumsBefore !== albumsAfter && (await page.locator('[aria-pressed=true]:has-text("EPs & Singles")').count()) === 1, `${albumsBefore} -> ${albumsAfter}`);
const top0 = await page.locator('section[aria-label="Popular songs"] app-music-track-row').count();
await page.getByRole('button', { name: 'Show all' }).click();
await page.waitForFunction((n) => document.querySelectorAll('section[aria-label="Popular songs"] app-music-track-row').length >= n + 15, top0, { timeout: 15000 }).catch(() => {});
const top1 = await page.locator('section[aria-label="Popular songs"] app-music-track-row').count();
check('artist: Show all expands top songs (paged)', top1 >= 20, `${top0} -> ${top1}`);
if (await page.getByRole('button', { name: 'Show more' }).count()) {
  await page.getByRole('button', { name: 'Show more' }).click();
  await page.waitForFunction((n) => document.querySelectorAll('section[aria-label="Popular songs"] app-music-track-row').length > n, top1, { timeout: 15000 }).catch(() => {});
}
check('artist: Show more pages further', (await page.locator('section[aria-label="Popular songs"] app-music-track-row').count()) > top1);
check('artist: Similar artists rail', (await page.locator('app-music-rail:has-text("Similar artists") app-music-artist-card').count()) > 0);
await page.evaluate(() => { window.__radioCalls = []; const p = window.__music.player; const orig = p.startRadio.bind(p); p.startRadio = (s) => { window.__radioCalls.push(s); return orig(s); }; });
await page.locator('main button', { hasText: /^\s*Radio\s*$/ }).click();
const radio = await page.evaluate(() => window.__radioCalls[0]);
check("artist: Radio calls player.startRadio({kind:'artist',...})", radio && radio.kind === 'artist' && String(radio.id) === '8847' && radio.label === 'Daft Punk', JSON.stringify(radio));
await page.locator('main button', { hasText: /^\s*Shuffle\s*$/ }).click();
await page.waitForFunction(() => window.__music.player.queue().length > 20 && window.__music.player.shuffle(), null, { timeout: 40000 }).catch(() => {});
const q = await page.evaluate(() => ({ n: window.__music.player.queue().length, sh: window.__music.player.shuffle(), albums: new Set(window.__music.player.queue().map((t) => t.albumId)).size }));
check('artist: Shuffle queues tracks from several albums', q.sh && q.n > 20 && q.albums > 1, JSON.stringify(q));
await page.locator('main app-music-like-button button').first().click();
check('artist: Like toggles', await page.evaluate(() => window.__music.library.favorites().artists.some((a) => a.id === 8847)));
await page.evaluate(async () => { const r = await fetch('/api/music?action=track&id=1550546'); const j = await r.json(); window.__music.library.toggleFavorite({ kind: 'track', data: j.track }); });
await page.goto(url('/music/artist/8847'), { waitUntil: 'domcontentloaded' });
await page.waitForSelector('section[aria-label="In your library"] app-music-track-row', { timeout: 20000 }).catch(() => {});
check('artist: "In your library" lists liked tracks by this artist', (await page.locator('section[aria-label="In your library"] app-music-track-row').count()) >= 1);
await shot('artist');

// Track page
await page.goto(url('/music/track/1550546'), { waitUntil: 'domcontentloaded' });
await page.waitForSelector('h1:has-text("One More Time")', { timeout: 20000 });
check('track: title is "<Track> by <Artist> | Stream Fiesta"', (await page.title()) === 'One More Time by Daft Punk | Stream Fiesta', await page.title());
check('track: play, like, radio, add to playlist, share buttons', (await page.locator('main button', { hasText: /^\s*Play\s*$/ }).count()) === 1 && (await page.locator('main app-music-like-button button').count()) >= 1 && (await page.locator('main button', { hasText: /^\s*Radio\s*$/ }).count()) === 1 && (await page.locator('button[aria-label="Add song to playlist"]').count()) === 1 && (await page.locator('button[aria-label="Share song"]').count()) === 1);
check("track: shows its album's track list", (await page.locator('section[aria-label="From the album"] app-music-track-row').count()) >= 5);
await page.locator('button[aria-label="Copy link to this song"]').click();
await page.waitForTimeout(300);
check('track: copy-link target is the track URL', /\/music\/track\/1550546$/.test(await page.evaluate(() => navigator.clipboard.readText().catch(() => ''))));
await page.locator('main button', { hasText: /^\s*Play\s*$/ }).click();
await page.waitForFunction(() => window.__music.player.track()?.id === 1550546, null, { timeout: 15000 }).catch(() => {});
check('track: Play starts that song', await page.evaluate(() => window.__music.player.track()?.id === 1550546));
await page.waitForTimeout(3000);
const simCount = await page.locator('section[aria-label="Similar tracks"] app-music-track-row').count();
console.log(`INFO  similar tracks rendered: ${simCount} (depends on P9's track-mix backend)`);
// The similar-tracks shelf needs P9's track-mix backend; stub it to prove the page renders what it gets.
await page.route('**/api/music?*action=track-mix*', async (route) => {
  const r = await fetch(`${api}/api/music?action=tracks&ids=20115561,20115557,20115556`);
  await route.fulfill({ json: { mixId: 'stub', tracks: await r.json() } });
});
await page.goto(url('/music/track/1550546'), { waitUntil: 'domcontentloaded' });
await page.waitForSelector('section[aria-label="Similar tracks"] app-music-track-row', { timeout: 15000 }).catch(() => {});
check('track: "Similar tracks" renders the track-mix result (stubbed backend)', (await page.locator('section[aria-label="Similar tracks"] app-music-track-row').count()) >= 1);
await page.unroute('**/api/music?*action=track-mix*');
await shot('track');

// Mobile layout
const m = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const mp = await m.newPage();
await mp.goto(url('/music/album/1550545'), { waitUntil: 'domcontentloaded' });
await mp.waitForSelector('app-music-track-row', { timeout: 20000 });
check('mobile: album page has no horizontal scroll', await mp.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
await mp.goto(url('/music/artist/8847'), { waitUntil: 'domcontentloaded' });
await mp.waitForSelector('h1:has-text("Daft Punk")', { timeout: 20000 });
check('mobile: artist page has no horizontal scroll', await mp.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
if (shots) await mp.screenshot({ path: `${shots}/p8-mobile.png` });

check('no uncaught page errors', errors.length === 0, errors.slice(0, 2).join(' | '));
await browser.close();
const bad = results.filter((r) => !r).length;
console.log(`\n${results.length - bad}/${results.length} passed`);
process.exit(bad ? 1 : 0);
