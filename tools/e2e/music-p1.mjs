// E2E for P1 (player bar): transport, volume, speed, sleep timer, seek drag, mobile layout, tab title, badge.
//   node tools/e2e/music-p1.mjs [baseUrl=http://localhost:4201] [--shots=dir] [--token-file=path]
// Run with playwright(-core) resolvable (NODE_PATH or node_modules). Without a user token playback is a 30 s PREVIEW.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright-core')); } catch { ({ chromium } = require('playwright')); }

const base = process.argv.find((a) => a.startsWith('http')) || 'http://localhost:4201';
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
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
await withToken(ctx);
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const M = (expr) => page.evaluate(`(() => { const m = window.__music; return ${expr}; })()`);
const bar = page.locator('app-music-player-bar section');

// The bar is app-wide, so start playback from a non-music page (independent of other music pages' state):
// fetch real tracks from the API and hand them to the player through the debug handle.
const startPlayback = async (pg, q) => {
  await pg.goto(base + '/terms?musicdebug=1', { waitUntil: 'domcontentloaded' });
  await pg.waitForFunction(() => !!window.__music, null, { timeout: 30000 });
  await pg.waitForTimeout(500);
  const title = await pg.title();
  await pg.evaluate(async (query) => {
    const res = await fetch('/api/music?action=search&q=' + encodeURIComponent(query));
    const { tracks } = await res.json();
    window.__music.player.play(tracks[0], tracks);
  }, q);
  return title;
};
const pageTitle = await startPlayback(page, 'daft punk');
await bar.waitFor({ timeout: 15000 });
await page.waitForFunction(() => window.__music.player.position() > 2, null, { timeout: 20000 });

// ---- Controls present with the right labels
const labels = ['Shuffle', 'Previous track', 'Pause', 'Next track', 'Repeat', 'Mute', 'Playback speed', 'Sleep timer', 'Queue', 'Lyrics', 'Open now playing'];
const missing = [];
for (const l of labels) if ((await bar.locator(`button[aria-label="${l}"]`).count()) === 0) missing.push(l);
const hasVol = (await bar.locator('input[type=range][aria-label="Volume"]').count()) === 1;
const hasLike = (await bar.locator('app-music-like-button button').count()) === 1;
check('desktop: all controls present with aria-labels', !missing.length && hasVol && hasLike, missing.join(',') + (hasVol ? '' : ' no-volume') + (hasLike ? '' : ' no-like'));
check('desktop: Shuffle/Repeat have aria-pressed', (await bar.locator('button[aria-label="Shuffle"]').getAttribute('aria-pressed')) === 'false' && (await bar.locator('button[aria-label="Repeat"]').getAttribute('aria-pressed')) === 'false');
if (shots) await page.screenshot({ path: `${shots}/p1-desktop.png` });

// ---- Each control changes its signal
await bar.locator('button[aria-label="Shuffle"]').click();
check('Shuffle toggles player.shuffle', (await M('m.player.shuffle()')) === true && (await bar.locator('button[aria-label="Shuffle"]').getAttribute('aria-pressed')) === 'true');
await bar.locator('button[aria-label="Shuffle"]').click();
await bar.locator('button[aria-label="Repeat"]').click();
const r1 = await M('m.player.repeat()');
await bar.locator('button[aria-label="Repeat"]').click();
const r2 = await M('m.player.repeat()');
check('Repeat cycles to all then one, label "Repeat one" + visible 1', r1 === 'all' && r2 === 'one'
  && (await bar.locator('button[aria-label="Repeat one"]').count()) === 1
  && ((await bar.locator('button[aria-label="Repeat one"] span').first().textContent()) || '').trim() === '1');
await bar.locator('button[aria-label="Repeat one"]').click();
check('Repeat cycles back to off', (await M('m.player.repeat()')) === 'off');

await bar.locator('button[aria-label="Pause"]').click();
await page.waitForFunction(() => !window.__music.player.playing(), null, { timeout: 5000 }).catch(() => {});
check('Pause pauses', (await M('m.player.playing()')) === false);
await page.waitForTimeout(200);
check('document.title restored to page title on pause', (await page.title()) === pageTitle, JSON.stringify(await page.title()));
await bar.locator('button[aria-label="Play"]').click();
await page.waitForFunction(() => window.__music.player.playing());
const trackTitle = await M('m.player.track().title');
await page.waitForTimeout(300);
check('while playing document.title starts with "▶ " + track title', (await page.title()).startsWith('▶ ' + trackTitle), JSON.stringify(await page.title()));

const likedBefore = await bar.locator('app-music-like-button button').getAttribute('aria-pressed');
await bar.locator('app-music-like-button button').click();
check('like button toggles', (await bar.locator('app-music-like-button button').getAttribute('aria-pressed')) !== likedBefore);
await bar.locator('app-music-like-button button').click();

await bar.locator('button[aria-label="Mute"]').click();
check('Mute sets player.muted and label flips to Unmute', (await M('m.player.muted()')) === true && (await bar.locator('button[aria-label="Unmute"]').count()) === 1);
await bar.locator('button[aria-label="Unmute"]').click();
check('Unmute', (await M('m.player.muted()')) === false);

// F0's side panel is modal and covers the bar's right edge, so close it with Escape between toggles.
await bar.locator('button[aria-label="Queue"]').click();
check('Queue opens ui.panel = queue (aria-pressed)', (await M("m.ui.panel()")) === 'queue' && (await bar.locator('button[aria-label="Queue"]').getAttribute('aria-pressed')) === 'true');
await page.keyboard.press('Escape');
await page.waitForFunction(() => window.__music.ui.panel() === null);
await bar.locator('button[aria-label="Lyrics"]').click();
check('Lyrics opens ui.panel = lyrics (aria-pressed)', (await M("m.ui.panel()")) === 'lyrics' && (await bar.locator('button[aria-label="Lyrics"]').getAttribute('aria-pressed')) === 'true');
await page.keyboard.press('Escape');
await page.waitForFunction(() => window.__music.ui.panel() === null);
await bar.locator('button[aria-label="Open now playing"]').click();
check('Open now playing sets ui.nowPlayingOpen', (await M('m.ui.nowPlayingOpen()')) === true);
await M('m.ui.closeNowPlaying()');

// ---- Volume wheel + keys
await M('m.player.setVolume(0.5)');
const vol = bar.locator('input[aria-label="Volume"]');
await vol.hover();
await page.mouse.wheel(0, -100);
await page.waitForTimeout(100);
const up = await M('m.player.volume()');
await page.mouse.wheel(0, 100);
await page.mouse.wheel(0, 100);
await page.waitForTimeout(100);
const down = await M('m.player.volume()');
check('wheel over volume changes it by 5% per notch', Math.abs(up - 0.55) < 0.011 && Math.abs(down - 0.45) < 0.011, `${up} / ${down}`);
await vol.focus();
await page.keyboard.press('ArrowUp');
const ku = await M('m.player.volume()');
await page.keyboard.press('ArrowDown');
await page.keyboard.press('ArrowDown');
const kd = await M('m.player.volume()');
check('ArrowUp/Down on focused volume slider work', ku > down && kd < ku, `${down} -> ${ku} -> ${kd}`);

// ---- Speed popover
await bar.locator('button[aria-label="Playback speed"]').click();
const pop = bar.locator('[role=dialog][aria-label="Playback speed"]');
await pop.locator('button', { hasText: /^1\.5x$/ }).click();
check('speed 1.5x sets player.playbackRate and the button shows 1.5x', (await M('m.player.playbackRate()')) === 1.5 && ((await bar.locator('button[aria-label="Playback speed"]').textContent()) || '').trim() === '1.5x');
const pitch0 = await M('m.player.preservesPitch()');
await pop.locator('button[role=switch]').click();
check('Keep pitch flips preservesPitch', (await M('m.player.preservesPitch()')) === !pitch0);
await pop.locator('button[role=switch]').click();
await page.keyboard.press('Escape');
check('Escape closes speed popover and returns focus', (await pop.count()) === 0 && (await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))) === 'Playback speed');
await bar.locator('button[aria-label="Playback speed"]').click();
await pop.locator('button', { hasText: /^1x$/ }).click();
await page.keyboard.press('Escape');

// ---- Sleep timer
await bar.locator('button[aria-label="Sleep timer"]').click();
const dlg = page.locator('app-music-sleep-timer [role=dialog]');
await dlg.waitFor();
await dlg.locator('button', { hasText: /^15 min$/ }).click();
await page.waitForTimeout(1300);
const chip = (await bar.locator('[data-sleep-chip]').textContent())?.trim() ?? '';
check('15 min shows a countdown chip (~14:5x)', /^(15:00|14:5\d)$/.test(chip), chip);
await bar.locator('button[aria-label="Sleep timer"]').click();
await dlg.locator('button', { hasText: /^End of track$/ }).click();
await page.waitForTimeout(200);
check('"End of track" chip shows End of track', ((await bar.locator('[data-sleep-chip]').textContent()) || '').trim() === 'End of track' && (await M('m.player.sleep().endOfTrack')) === true);
await bar.locator('button[aria-label="Sleep timer"]').click();
await dlg.locator('button', { hasText: /^Cancel timer$/ }).click();
await page.waitForTimeout(200);
check('Cancel clears the timer and chip', (await bar.locator('[data-sleep-chip]').count()) === 0 && (await M('m.player.sleep().endsAt === null && !m.player.sleep().endOfTrack')) === true);
await bar.locator('button[aria-label="Sleep timer"]').click();
await dlg.locator('input[aria-label="Custom minutes"]').fill('20');
await dlg.locator('input[aria-label="Custom minutes"]').press('Enter');
check('custom minutes arms the timer', (await M('m.player.sleep().endsAt !== null')) === true);
await M('m.player.setSleepTimer(null)');

// ---- Seek: hover tooltip + drag commits on pointerup only
await page.waitForFunction(() => window.__music.player.duration() > 20);
await M('m.player.pause()');
const seek = bar.locator('input[aria-label="Seek"]');
// Let the bar settle first: clearing the sleep timer removes its chip, which re-centres the seek bar
// (~44 px) and made this check land short of 70 % about half the time.
await page.waitForTimeout(500);
const sb = await seek.boundingBox();
const pos0 = await M('m.player.position()');
await page.mouse.move(sb.x + sb.width * 0.25, sb.y + sb.height / 2);
const tip1 = bar.locator('span[role=presentation]');
await tip1.waitFor({ timeout: 2000 }).catch(() => {});
const t1 = ((await tip1.textContent().catch(() => '')) || '').trim();
const l1 = (await tip1.boundingBox().catch(() => null))?.x ?? -1;
await page.mouse.move(sb.x + sb.width * 0.75, sb.y + sb.height / 2);
await page.waitForTimeout(100);
const t2 = ((await tip1.textContent().catch(() => '')) || '').trim();
const l2 = (await tip1.boundingBox().catch(() => null))?.x ?? -1;
check('hover shows a time tooltip that follows the pointer', !!t1 && !!t2 && t1 !== t2 && l2 > l1, `${t1}@${Math.round(l1)} -> ${t2}@${Math.round(l2)}`);
await page.evaluate(() => { window.__seekInputs = []; const i = document.querySelector('app-music-player-bar input[aria-label="Seek"]'); i.addEventListener('input', () => window.__seekInputs.push(i.value)); });
await page.mouse.move(sb.x + sb.width * 0.2, sb.y + sb.height / 2);
await page.mouse.down();
await page.mouse.move(sb.x + sb.width * 0.7, sb.y + sb.height / 2, { steps: 8 });
await page.waitForTimeout(200);
const mid = await M('m.player.position()');
check('mid-drag does not seek', Math.abs(mid - pos0) < 1.5, `position ${pos0} -> ${mid}`);
await page.mouse.up();
await page.waitForTimeout(300);
const dur = await M('m.player.duration()');
const end = await M('m.player.position()');
const diag = await page.evaluate(([x, y]) => { const e = document.elementFromPoint(x, y); return `inputs ${window.__seekInputs.join(',')} | at 0.7: ${e?.tagName}.${String(e?.className).slice(0, 50)}`; }, [sb.x + sb.width * 0.7, sb.y + sb.height / 2]);
check('pointerup commits the seek', Math.abs(end - dur * 0.7) < dur * 0.06, `${end}s of ${dur}s; ${diag}`);
await seek.focus();
const k0 = await M('m.player.position()');
await page.keyboard.press('ArrowRight');
await page.waitForTimeout(200);
check('seek ArrowRight steps +5 s', Math.abs((await M('m.player.position()')) - (k0 + 5)) < 1.5);
await M('m.player.resume()');

// ---- Quality badge
const badge = (await bar.locator('span.uppercase').first().textContent())?.trim();
const btitle = await bar.locator('span.uppercase').first().getAttribute('title');
check('badge shows Preview/AAC/Lossless/Hi-Res with a tooltip', ['Preview', 'AAC', 'Lossless', 'Hi-Res'].includes(badge) && !!btitle, `${badge}: ${btitle}`);
await M("m.player.qualityFallback.set('HI_RES_LOSSLESS'), 0");
await page.waitForTimeout(100);
// The fallback explanation only applies to non-Preview badges; Preview keeps its sign-in hint.
const ftitle = await bar.locator('span.uppercase').first().getAttribute('title');
check('qualityFallback set -> badge title explains it (full tracks) or keeps hint (preview)', badge === 'Preview' ? /Sign in/.test(ftitle) : /can't play Hi-Res/.test(ftitle), ftitle);
await M('m.player.qualityFallback.set(null), 0');

check('no uncaught page errors (desktop)', errors.length === 0, errors.slice(0, 2).join(' | '));

// ---- Mobile
const m = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
await withToken(m);
const mp = await m.newPage();
const merrors = [];
mp.on('pageerror', (e) => merrors.push(e.message));
await startPlayback(mp, 'radiohead');
const mbar = mp.locator('app-music-player-bar section');
await mbar.waitFor({ timeout: 15000 });
const mb = await mbar.boundingBox();
const row = await mp.locator('app-music-player-bar section > div').first().boundingBox();
const visible = async (sel) => (await mbar.locator(sel).filter({ visible: true }).count()) > 0;
check('mobile: shows like, play/pause, next', (await visible('app-music-like-button button')) && (await visible('button[aria-label="Next track"]')) && ((await visible('button[aria-label="Pause"]')) || (await visible('button[aria-label="Play"]'))));
check('mobile: hides shuffle/prev/repeat/volume/speed', !(await visible('button[aria-label="Shuffle"]')) && !(await visible('button[aria-label="Previous track"]')) && !(await visible('button[aria-label="Repeat"]')) && !(await visible('input[aria-label="Volume"]')) && !(await visible('button[aria-label="Playback speed"]')));
check('mobile: single row (bar height <= 72px incl. progress line)', mb.height <= 72, `${Math.round(mb.height)}px`);
check('mobile: no horizontal overflow', await mp.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
check('mobile: thin progress line kept', (await mbar.locator('div.h-0\\.5').count()) === 1);
await mp.locator('app-music-player-bar a').first().click();
check("mobile: tap on cover/title opens Now Playing (coverClickAction 'nowPlaying') without navigating", (await mp.evaluate(() => window.__music.ui.nowPlayingOpen())) === true && /\/terms/.test(mp.url()), mp.url());
await mp.evaluate(() => { window.__music.ui.closeNowPlaying(); window.__music.settings.coverClickAction.set('album'); });
await mp.waitForTimeout(200);
const urlBefore = mp.url();
await mp.locator('app-music-player-bar a').first().click();
await mp.waitForTimeout(800);
check("mobile: coverClickAction 'album' navigates to the album instead", (await mp.evaluate(() => window.__music.ui.nowPlayingOpen())) === false && mp.url() !== urlBefore && /\/music\/album\//.test(mp.url()), mp.url());
await mp.evaluate(() => window.__music.settings.coverClickAction.set('nowPlaying'));
if (shots) await mp.screenshot({ path: `${shots}/p1-mobile.png` });
check('no uncaught page errors (mobile)', merrors.length === 0, merrors.slice(0, 2).join(' | '));

await browser.close();
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
