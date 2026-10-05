// E2E for P2: queue panel + fullscreen Now Playing.
//   node tools/e2e/music-p2.mjs [baseUrl=http://localhost:4202] [--shots=dir] [--token-file=path]
// Run from a dir whose node_modules has playwright(-core) (or set NODE_PATH).
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright-core')); } catch { ({ chromium } = require('playwright')); }

const base = process.argv.find((a) => a.startsWith('http')) || 'http://localhost:4202';
const shots = (process.argv.find((a) => a.startsWith('--shots=')) || '').slice(8);
const tokenFile = (process.argv.find((a) => a.startsWith('--token-file=')) || '').slice(13);
const userToken = tokenFile ? (await import('node:fs')).readFileSync(tokenFile, 'utf8').trim() : '';
const withToken = async (c) => {
  if (userToken) await c.route('**/api/music*', (r) => r.continue({ headers: { ...r.request().headers(), 'x-tidal-token': userToken } }));
};
const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };
const launchArgs = { args: ['--autoplay-policy=no-user-gesture-required'] };
const browser = await chromium.launch({ channel: 'chrome', ...launchArgs }).catch(() => chromium.launch(launchArgs));

async function openPage(opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, ...opts });
  await withToken(ctx);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('  pageerror:', e.message));
  await page.goto(base + '/music?musicdebug=1', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__music, null, { timeout: 20000 });
  // Two different queries so two different covers exist.
  await page.evaluate(async () => {
    const get = async (q) => (await (await fetch('/api/music?action=search&q=' + encodeURIComponent(q))).json()).tracks;
    const a = await get('daft punk discovery');
    const b = await get('radiohead ok computer');
    const seen = new Set();
    const mixed = [];
    for (let i = 0; i < 8; i++) for (const t of [a[i], b[i]]) if (t && !seen.has(t.id)) { seen.add(t.id); mixed.push(t); }
    window.__q = mixed.slice(0, 10);
    await window.__music.player.setQueue(window.__q, 0, { type: 'search', label: 'Search: test mix' });
  });
  await page.waitForSelector('app-music-player-bar section', { timeout: 15000 });
  return { ctx, page };
}
const titles = (page) => page.evaluate(() => window.__music.player.queue().map((t) => t.title));

// ── Desktop: queue panel ────────────────────────────────────────────────────
{
  const { ctx, page } = await openPage();
  const bodyOpen = () => page.evaluate(() => document.body.classList.contains('music-overlay-open'));
  await page.click('button[aria-label="Queue"]');
  const dlg = page.locator('app-music-queue-panel [role=dialog]');
  await dlg.waitFor({ timeout: 5000 });
  const heading = (await dlg.locator('h2').first().textContent()).trim();
  const txt = await dlg.innerText();
  check('queue opens as dialog titled Queue with Now playing / Next up / Playing from', heading === 'Queue' && /Now playing/i.test(txt) && /Next up/i.test(txt) && /Playing from\s+Search: test mix/.test(txt), `heading="${heading}"`);
  check('body has music-overlay-open while the panel is open', await bodyOpen());
  if (shots) await page.screenshot({ path: `${shots}/p2-queue.png` });

  const rowTitles = () => dlg.locator('[data-row] .truncate.text-sm').allTextContents().then((a) => a.map((s) => s.trim()));
  let q = await titles(page);
  check('next up lists the upcoming tracks in play order', JSON.stringify(await rowTitles()) === JSON.stringify(q.slice(1)), `${q.length - 1} rows`);

  // Shuffle: next up must follow the shuffled play order.
  await page.evaluate(() => window.__music.player.setShuffle(true));
  await page.waitForTimeout(300);
  q = await titles(page);
  check('next up honours shuffle (matches shuffled player.queue())', JSON.stringify(await rowTitles()) === JSON.stringify(q.slice(1)) && q.length > 3);
  await page.evaluate(() => window.__music.player.setShuffle(false));
  await page.waitForTimeout(300);

  // Mouse drag: last row's handle above the first row.
  q = await titles(page);
  const handles = dlg.locator('[data-row] [data-handle]');
  const n = await handles.count();
  const src = await handles.nth(2).boundingBox();
  const dst = await handles.nth(0).boundingBox();
  await page.mouse.move(src.x + src.width / 2, src.y + src.height / 2);
  await page.mouse.down();
  await page.mouse.move(src.x + src.width / 2, src.y + src.height / 2 - 10, { steps: 3 });
  await page.mouse.move(dst.x + dst.width / 2, dst.y + 2, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(500);
  let q2 = await titles(page);
  const expected = [q[0], q[3], q[1], q[2], ...q.slice(4)];
  check('mouse drag reorders player.queue()', JSON.stringify(q2) === JSON.stringify(expected), `moved "${q[3]}" to position 1 (rows=${n})`);

  // Keyboard: Alt+ArrowDown on the first row's handle.
  q = await titles(page);
  await dlg.locator('[data-row] [data-handle]').first().focus();
  await page.keyboard.press('Alt+ArrowDown');
  await page.waitForTimeout(400);
  q2 = await titles(page);
  const exp2 = [q[0], q[2], q[1], ...q.slice(3)];
  const focusOk = await page.evaluate(() => document.activeElement?.hasAttribute('data-handle') && document.activeElement.closest('[data-row]') === document.querySelectorAll('[data-row]')[1]);
  check('Alt+ArrowDown moves the focused row down (and focus follows)', JSON.stringify(q2) === JSON.stringify(exp2) && focusOk);

  // Play / Remove
  q = await titles(page);
  await dlg.locator('[data-row] button[aria-label="Remove from queue"]').first().click();
  await page.waitForTimeout(300);
  q2 = await titles(page);
  check('"Remove from queue" removes that row', q2.length === q.length - 1 && q2[1] === q[2]);
  const target = (await titles(page))[2];
  await dlg.locator('[data-row] button[aria-label="Play"]').nth(1).click();
  await page.waitForTimeout(500);
  const cur = await page.evaluate(() => window.__music.player.track()?.title);
  check('"Play" on a row jumps to it', cur === target, `"${cur}"`);

  // Save as playlist -> ui.addToPlaylist
  await dlg.locator('button[aria-label="Save as playlist"]').click();
  await page.waitForTimeout(300);
  const atp = await page.evaluate(() => window.__music.ui.addToPlaylist()?.length ?? 0);
  const qlen = await page.evaluate(() => window.__music.player.queue().length);
  check('"Save as playlist" opens addToPlaylist with the whole queue', atp === qlen && atp > 3, `${atp} tracks`);
  await page.evaluate(() => window.__music.ui.closeAddToPlaylist());
  await page.waitForTimeout(200);

  // Clear queue keeps current
  if (!(await dlg.count())) await page.click('button[aria-label="Queue"]');
  await dlg.locator('button[aria-label="Clear queue"]').click();
  await page.waitForTimeout(300);
  const after = await page.evaluate(() => ({ len: window.__music.player.queue().length, cur: window.__music.player.track()?.title }));
  check('"Clear queue" keeps only up to the current track', after.cur === cur && after.len === (await page.evaluate(() => window.__music.player.index())) + 1, JSON.stringify(after));

  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  check('Escape closes the panel and removes the overlay class', (await dlg.count()) === 0 && !(await bodyOpen()));
  await ctx.close();
}

// ── Focus returns to the bar's Queue button ────────────────────────────────
{
  const { ctx, page } = await openPage();
  await page.click('button[aria-label="Queue"]');
  await page.locator('app-music-queue-panel [role=dialog]').waitFor();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  const lab = await page.evaluate(() => document.activeElement?.getAttribute('aria-label'));
  check("Escape returns focus to the bar's Queue button", lab === 'Queue', `focus=${lab}`);
  await page.click('button[aria-label="Queue"]');
  await page.locator('app-music-queue-panel [role=dialog]').waitFor();
  await page.click('app-music-queue-panel button[aria-label="Close"]');
  await page.waitForTimeout(300);
  const lab2 = await page.evaluate(() => document.activeElement?.getAttribute('aria-label'));
  check('closing with the X also returns focus to the Queue button', lab2 === 'Queue', `focus=${lab2}`);
  await ctx.close();
}

// ── Touch drag in the queue ────────────────────────────────────────────────
{
  const { ctx, page } = await openPage({ viewport: { width: 1280, height: 800 }, hasTouch: true });
  await page.evaluate(() => window.__music.ui.openPanel('queue'));
  const dlg = page.locator('app-music-queue-panel [role=dialog]');
  await dlg.waitFor();
  const q = await titles(page);
  const handles = dlg.locator('[data-row] [data-handle]');
  const a = await handles.nth(2).boundingBox();
  const b = await handles.nth(0).boundingBox();
  const cdp = await ctx.newCDPSession(page);
  const pt = (x, y) => [{ x, y, id: 1 }];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt(a.x + a.width / 2, a.y + a.height / 2) });
  for (let i = 1; i <= 14; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pt(a.x + a.width / 2, a.y + a.height / 2 + ((b.y - a.y) * i) / 14) });
    await page.waitForTimeout(16);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(500);
  const q2 = await titles(page);
  check('touch drag reorders player.queue()', JSON.stringify(q2) !== JSON.stringify(q) && q2[1] === q[3], `"${q[3]}" -> position 1: ${q2[1] === q[3]}`);
  await ctx.close();
}

// ── Now Playing (desktop) ──────────────────────────────────────────────────
{
  const { ctx, page } = await openPage();
  await page.waitForFunction(() => window.__music.player.playing(), null, { timeout: 15000 }).catch(() => {});
  await page.evaluate(() => window.__music.ui.openNowPlaying());
  const np = page.locator('app-music-now-playing [role=dialog]');
  await np.waitFor({ timeout: 5000 });
  const trk = await page.evaluate(() => window.__music.player.track());
  const hrefs = await np.locator('a').evaluateAll((as) => as.map((a) => a.getAttribute('href')));
  check('Now Playing: title/artist/album links point at their pages',
    hrefs.includes(`/music/track/${trk.id}`) && hrefs.includes(`/music/artist/${trk.artistId}`) && hrefs.includes(`/music/album/${trk.albumId}`), hrefs.join(' '));
  const labels = ['Previous track', 'Next track', 'Seek', 'Close now playing', 'Visualizer'];
  const have = await Promise.all(labels.map((l) => np.locator(`[aria-label="${l}"]`).count()));
  const pp = (await np.locator('button[aria-label="Pause"], button[aria-label="Play"]').count()) === 1;
  check('Now Playing: full transport + seek + close controls are labelled', have.every((c) => c === 1) && pp, have.join(','));
  check('Now Playing: lyrics pane is side by side at lg', (await np.locator('app-music-lyrics-view').count()) === 1 && await np.locator('app-music-lyrics-view').isVisible());
  check('Now Playing: next-up preview is shown', (await np.locator('[data-next-preview]').count()) === 1);
  check('Now Playing: body scroll locked', await page.evaluate(() => document.body.classList.contains('music-overlay-open')));
  const viz0 = await np.locator('app-music-visualizer').count();
  await np.locator('button[aria-label="Visualizer"]').click();
  const viz1 = await np.locator('app-music-visualizer').count();
  const pressed = await np.locator('button[aria-label="Visualizer"]').getAttribute('aria-pressed');
  check('Visualizer toggle mounts <app-music-visualizer>', viz0 === 0 && viz1 === 1 && pressed === 'true');
  await np.locator('button[aria-label="Visualizer"]').click();
  if (shots) await page.screenshot({ path: `${shots}/p2-nowplaying.png` });

  // Dynamic colour
  await page.waitForFunction(() => document.querySelector('[data-now-playing]')?.getAttribute('data-accent'), null, { timeout: 8000 }).catch(() => {});
  const c1 = await np.getAttribute('data-accent');
  const bg1 = await np.evaluate((e) => getComputedStyle(e).backgroundImage);
  await page.evaluate(async () => {
    const q = window.__music.player.queue();
    const cur = window.__music.player.track();
    const other = q.findIndex((t) => t.cover !== cur.cover);
    window.__music.player.playAt(other);
  });
  await page.waitForFunction((prev) => { const a = document.querySelector('[data-now-playing]')?.getAttribute('data-accent'); return a && a !== prev; }, c1, { timeout: 8000 }).catch(() => {});
  const c2 = await np.getAttribute('data-accent');
  check('dynamic colour differs between two covers', !!c1 && !!c2 && c1 !== c2, `${c1} vs ${c2}`);
  check('dynamic colour on: gradient uses the cover colour', /gradient/.test(bg1));
  await page.evaluate(() => window.__music.settings.dynamicColor.set(false));
  await page.waitForTimeout(300);
  const off = await np.evaluate((e) => ({ img: getComputedStyle(e).backgroundImage, col: getComputedStyle(e).backgroundColor, acc: e.getAttribute('data-accent') }));
  check('dynamic colour off -> neutral #121212', off.img === 'none' && off.col === 'rgb(18, 18, 18)' && !off.acc, JSON.stringify(off));
  await page.evaluate(() => window.__music.settings.dynamicColor.set(true));

  // Hide-UI
  await np.locator('[data-cover]').click();
  const hidden = (await np.locator('button[aria-label="Pause"], button[aria-label="Play"]').count()) === 0 && (await np.locator('input[aria-label="Seek"]').count()) === 0;
  const coverVisible = await np.locator('[data-cover]').isVisible();
  await np.locator('[data-cover]').click();
  const shown = (await np.locator('input[aria-label="Seek"]').count()) === 1;
  check('tapping the cover hides the controls (cover only) and again shows them', hidden && coverVisible && shown);

  // Cover options
  const cls = () => np.locator('[data-cover]').evaluate((e) => e.className);
  await page.evaluate(() => window.__music.settings.coverRound.set(true));
  const roundA = /rounded-2xl/.test(await cls());
  await page.evaluate(() => window.__music.settings.coverRound.set(false));
  await page.waitForTimeout(100);
  const roundB = /rounded-none/.test(await cls());
  check('settings.coverRound switches rounded / square', roundA && roundB);
  await page.evaluate(() => window.__music.settings.coverTilt.set(true));
  const wrap = await np.locator('[data-cover-wrap]').boundingBox();
  await page.mouse.move(wrap.x + wrap.width * 0.9, wrap.y + wrap.height * 0.1, { steps: 4 });
  const tf = await np.locator('[data-cover-wrap]').evaluate((e) => e.style.transform);
  const m = tf.match(/rotateX\((-?[\d.]+)deg\) rotateY\((-?[\d.]+)deg\)/);
  const maxDeg = m ? Math.max(Math.abs(+m[1]), Math.abs(+m[2])) : 99;
  check('settings.coverTilt tilts the cover (max 8deg)', !!m && maxDeg > 1 && maxDeg <= 8.01, tf);
  await page.evaluate(() => window.__music.settings.coverTilt.set(false));
  await page.mouse.move(wrap.x + wrap.width * 0.2, wrap.y + wrap.height * 0.8, { steps: 3 });
  check('tilt off -> no transform', (await np.locator('[data-cover-wrap]').evaluate((e) => e.style.transform)) === '');

  // CD mode
  await page.evaluate(() => window.__music.player.resume());
  await page.waitForFunction(() => window.__music.player.playing(), null, { timeout: 15000 }).catch(() => {});
  await np.locator('button[aria-label="CD mode"]').click();
  await page.waitForTimeout(400);
  const spin = () => np.locator('[data-cover]').evaluate((e) => ({ s: e.dataset.spinning, running: e.getAnimations().some((a) => a.playState === 'running'), round: /rounded-full/.test(e.className) }));
  const playing = await page.evaluate(() => window.__music.player.playing());
  const s1 = await spin();
  check('CD mode: round cover spins while playing', playing && s1.s === 'true' && s1.running && s1.round, JSON.stringify(s1));
  await page.evaluate(() => window.__music.player.pause());
  await page.waitForTimeout(400);
  const s2 = await spin();
  check('CD mode: stops spinning when paused', s2.s === 'false' && !s2.running, JSON.stringify(s2));
  await np.locator('button[aria-label="CD mode"]').click();

  // Escape
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  check('Escape closes Now Playing and releases scroll lock', (await np.count()) === 0 && !(await page.evaluate(() => document.body.classList.contains('music-overlay-open'))));
  await ctx.close();
}

// ── Reduced motion ─────────────────────────────────────────────────────────
{
  const { ctx, page } = await openPage({ reducedMotion: 'reduce' });
  await page.evaluate(() => { window.__music.settings.coverTilt.set(true); window.__music.player.resume(); });
  await page.evaluate(() => window.__music.ui.openNowPlaying());
  const np = page.locator('app-music-now-playing [role=dialog]');
  await np.waitFor();
  const anims = await np.evaluate((e) => e.getAnimations().length);
  check('reduced motion: no slide animation on open', anims === 0, `${anims} animations`);
  await np.locator('button[aria-label="CD mode"]').click();
  await page.waitForTimeout(400);
  const spin = await np.locator('[data-cover]').evaluate((e) => ({ s: e.dataset.spinning, running: e.getAnimations().some((a) => a.playState === 'running') }));
  const playingRm = await page.evaluate(() => window.__music.player.playing());
  const tfAt = () => np.locator('[data-cover]').evaluate((e) => getComputedStyle(e).transform);
  const tf1 = await tfAt();
  await page.waitForTimeout(500);
  const tf2 = await tfAt();
  check('reduced motion: explicit CD mode still spins while playing (rotation advances)', playingRm && spin.s === 'true' && spin.running && tf1 !== 'none' && tf1 !== tf2, `${tf1} -> ${tf2}`);
  const wrap = await np.locator('[data-cover-wrap]').boundingBox();
  await page.mouse.move(wrap.x + wrap.width * 0.9, wrap.y + wrap.height * 0.1, { steps: 4 });
  check('reduced motion: no tilt', (await np.locator('[data-cover-wrap]').evaluate((e) => e.style.transform)) === '');
  await ctx.close();
}
{
  const { ctx, page } = await openPage();
  await page.evaluate(() => window.__music.ui.openNowPlaying());
  const anims = await page.locator('app-music-now-playing [role=dialog]').evaluate((e) => e.getAnimations().length);
  check('motion allowed: slide-in animation runs (control for the test above)', anims > 0, `${anims} animations`);
  await ctx.close();
}

// ── Mobile ─────────────────────────────────────────────────────────────────
{
  const { ctx, page } = await openPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await page.evaluate(() => window.__music.ui.openNowPlaying());
  const np = page.locator('app-music-now-playing [role=dialog]');
  await np.waitFor();
  const noLyrics = (await np.locator('app-music-lyrics-view').count()) === 0;
  await np.locator('button[aria-pressed]:has-text("Lyrics")').click();
  const lyrics = (await np.locator('app-music-lyrics-view').count()) === 1;
  check('mobile: lyrics are behind a "Lyrics" toggle', noLyrics && lyrics);
  const noOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  check('mobile: no horizontal overflow', noOverflow);
  if (shots) await page.screenshot({ path: `${shots}/p2-nowplaying-mobile.png` });

  const swipe = async (dy) => {
    const h = await page.locator('[data-drag-handle]').boundingBox();
    const x = h.x + h.width / 2, y = h.y + h.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x, y + dy / 2, { steps: 5 });
    await page.waitForTimeout(450);
    await page.mouse.move(x, y + dy, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(300);
  };
  await swipe(60);
  const stays = (await np.count()) === 1 && (await np.evaluate((e) => e.style.transform)) === '';
  check('mobile: dragging the handle < 120px springs back (stays open)', stays);
  await swipe(160);
  check('mobile: dragging the handle > 120px dismisses', (await np.count()) === 0);

  // Queue sheet on mobile
  await page.evaluate(() => window.__music.ui.openPanel('queue'));
  const qd = page.locator('app-music-queue-panel [role=dialog]');
  await qd.waitFor();
  const small = await qd.locator('button').evaluateAll((bs) => bs.filter((b) => { const r = b.getBoundingClientRect(); return r.width && (r.width < 30 || r.height < 30); }).length);
  const ovf = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  check('mobile: queue sheet has no horizontal overflow', ovf);
  console.log(`  note: queue buttons smaller than 30px: ${small}`);
  if (shots) await page.screenshot({ path: `${shots}/p2-queue-mobile.png` });
  await ctx.close();
}

await browser.close();
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
