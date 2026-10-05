// E2E for package P5: visualizer presets, waveform seek bar + silence bounds, crossfade engine.
//   node tools/e2e/music-p5.mjs [baseUrl=http://localhost:4205] [--shots=dir] [--token-file=path]
// Drives the real app through ?musicdebug=1 (window.__music). Passes with 30 s previews (no TIDAL
// user token) as well as with full tracks. Run from a dir whose node_modules has playwright(-core)
// (or set NODE_PATH).
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright-core')); } catch { ({ chromium } = require('playwright')); }

const base = process.argv.find((a) => a.startsWith('http')) || 'http://localhost:4205';
const shots = (process.argv.find((a) => a.startsWith('--shots=')) || '').slice(8);
const tokenFile = (process.argv.find((a) => a.startsWith('--token-file=')) || '').slice(13);
const userToken = tokenFile ? (await import('node:fs')).readFileSync(tokenFile, 'utf8').trim() : '';
const results = [];
const check = (name, ok, extra = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const md5 = (b) => createHash('md5').update(b).digest('hex');

const launchArgs = ['--autoplay-policy=no-user-gesture-required', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];
const browser = await chromium.launch({ channel: 'chrome', args: launchArgs }).catch(() => chromium.launch({ args: launchArgs }));

async function newPage(opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: 'no-preference', ...opts.context });
  if (userToken) await ctx.route('**/api/music*', (r) => r.continue({ headers: { ...r.request().headers(), 'x-tidal-token': userToken } }));
  // ng serve shows a full-page error overlay while another package's file is mid-edit; it is not part of the app.
  await ctx.addInitScript(() => { setInterval(() => document.querySelectorAll('vite-error-overlay').forEach((e) => e.remove()), 300); });
  if (opts.initScript) await ctx.addInitScript(opts.initScript);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const reqs = [];
  page.on('request', (r) => reqs.push(r.url()));
  const jsSizes = new Map();
  page.on('response', async (r) => {
    const u = r.url();
    if (/\.js(\?|$)/.test(u) && u.startsWith(base)) { try { jsSizes.set(u, (await r.body()).length); } catch { /* ignore */ } }
  });
  return { ctx, page, errors, reqs, jsSizes };
}

async function playFirstTrack(page, q = 'daft punk one more time') {
  await page.goto(`${base}/music?musicdebug=1&q=${encodeURIComponent(q)}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('app-music-track-row', { timeout: 30000 });
  await page.waitForSelector('app-music-track-row button[aria-label^="Play "]', { state: 'attached', timeout: 30000 });
  await page.waitForTimeout(500);
  await page.locator('app-music-track-row button[aria-label^="Play "]').first().click({ force: true, timeout: 15000 });
  await page.waitForSelector('app-music-player-bar section', { timeout: 20000 });
  await page.waitForFunction(() => +(document.querySelector('input[aria-label="Seek"]')?.value ?? -1) >= 2, null, { timeout: 30000 });
}

/** Hides everything inside Now Playing except the visualizer layer, so screenshots only change when the canvas does. */
const ISOLATE = '[data-now-playing] > *:not(:has(app-music-visualizer)) { visibility: hidden !important; }';
async function isolate(page) { await page.addStyleTag({ content: ISOLATE }); }

async function openVisualizer(page) {
  await page.evaluate(() => window.__music.ui.openNowPlaying());
  await page.waitForSelector('[data-now-playing]', { timeout: 10000 });
  await page.waitForSelector('button[aria-label="Visualizer"]', { state: 'attached' });
  if ((await page.locator('app-music-visualizer').count()) === 0) await clickVizButton(page);
  await page.waitForSelector('app-music-visualizer[data-viz-status]', { timeout: 10000 });
}
async function clickVizButton(page) {
  const ok = await page.evaluate(() => { const b = document.querySelector('button[aria-label="Visualizer"]'); if (b) b.click(); return !!b; });
  if (!ok) console.log('DEBUG no Visualizer button:', JSON.stringify(await page.evaluate(() => ({ np: window.__music.ui.nowPlayingOpen(), url: location.pathname + location.search, dlg: !!document.querySelector('[data-now-playing]'), track: window.__music.player.track()?.title }))));
  return ok;
}
const vizAttr = (page, a) => page.evaluate((n) => document.querySelector('app-music-visualizer')?.getAttribute(n) ?? null, a);
const waitViz = async (page, status = 'ready', ms = 25000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if ((await vizAttr(page, 'data-viz-status')) === status) return true; await wait(150); }
  return false;
};
/** md5 of the canvas region over `n` samples `gap` ms apart. */
async function canvasHashes(page, n = 4, gap = 450) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const box = await page.evaluate(() => { const c = document.querySelector('app-music-visualizer canvas:not([aria-hidden=false])'); const r = c?.getBoundingClientRect(); return r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null; });
    if (!box) { out.push(null); } else out.push(md5(await page.screenshot({ clip: box })));
    await wait(gap);
  }
  return out;
}
const changes = (hs) => new Set(hs.filter(Boolean)).size > 1;
/** Frames drawn so far by the visualizer's own loop (-1 when the layer is not mounted). */
const rafCount = (page) => page.evaluate(() => { const el = document.querySelector('app-music-visualizer'); return el ? Number(el.dataset.frames || 0) : -1; });

// ───────────────────────────── Visualizer ─────────────────────────────
{
  const { page, errors, jsSizes } = await newPage();
  await playFirstTrack(page);
  await openVisualizer(page);
  await isolate(page);
  check('visualizer starts on a canvas (graph analyser available)', await waitViz(page), `status=${await vizAttr(page, 'data-viz-status')}`);
  check('canvas exists inside app-music-visualizer', (await page.locator('app-music-visualizer canvas').count()) >= 1);
  if (shots) await page.screenshot({ path: `${shots}/p5-particles.png` });

  const hs = await canvasHashes(page, 5, 400);
  check('particles: canvas pixels change over time while playing', changes(hs), `${new Set(hs).size} distinct of ${hs.length}`);

  // rAF loop vs visibility
  const f0 = await rafCount(page);
  await wait(500);
  const f1 = await rafCount(page);
  check('rAF loop is running while visible', f1 - f0 >= 3 && (await vizAttr(page, 'data-viz-running')) === 'true', `+${f1 - f0} frames/0.5s`);

  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); });
  await wait(300);
  const h0 = await rafCount(page);
  await wait(600);
  const h1 = await rafCount(page);
  check('rAF loop stops when the document is hidden', h1 === h0 && (await vizAttr(page, 'data-viz-running')) === 'false', `+${h1 - h0} frames while hidden`);
  await page.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event('visibilitychange')); });
  await wait(500);
  const v0 = await rafCount(page);
  await wait(400);
  check('rAF loop resumes when the document is visible again', (await rafCount(page)) - v0 >= 2 && (await vizAttr(page, 'data-viz-running')) === 'true');

  // reduced motion
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await wait(500);
  const r0 = await rafCount(page);
  await wait(600);
  const r1 = await rafCount(page);
  check('rAF loop stops under prefers-reduced-motion', r1 === r0 && (await vizAttr(page, 'data-viz-running')) === 'false' && (await page.locator('app-music-visualizer :text("Animation is paused")').count()) === 1, `+${r1 - r0} frames`);
  await page.locator('app-music-visualizer button:has-text("Animate anyway")').first().click();
  await wait(900);
  const a0 = await rafCount(page);
  await wait(800);
  check("'Animate anyway' runs the loop under reduced motion", (await rafCount(page)) - a0 >= 2 && (await vizAttr(page, 'data-viz-running')) === 'true', `+${(await rafCount(page)) - a0} frames, running=${await vizAttr(page, 'data-viz-running')}, status=${await vizAttr(page, 'data-viz-status')}`);
  // switch the opt-in off again and leave reduced motion
  await page.locator('app-music-visualizer button[aria-label="Animate anyway"]').click();
  await wait(400);
  check('turning the opt-in off pauses it again', (await vizAttr(page, 'data-viz-running')) === 'false');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await wait(500);
  check('leaving reduced motion resumes it', (await vizAttr(page, 'data-viz-running')) === 'true');

  // Inactive (the Visualizer button off): layer gone, loop gone.
  await clickVizButton(page);
  await wait(500);
  const i0 = await rafCount(page);
  await wait(600);
  check('rAF loop stops when the visualizer is switched off', (await page.locator('app-music-visualizer').count()) === 0 && (await rafCount(page)) === i0);

  // Presets
  await clickVizButton(page);
  await waitViz(page);
  await isolate(page);
  const opts = await page.$$eval('select[aria-label="Visualizer preset"] option', (os) => os.map((o) => o.textContent.trim()));
  check('preset picker lists Particles, LCD, Unknown Pleasures, Butterchurn, Kawarp', JSON.stringify(opts) === JSON.stringify(['Particles', 'LCD', 'Unknown Pleasures', 'Butterchurn', 'Kawarp']), opts.join(' | '));

  await page.evaluate(() => { window.__marker = 'same-page'; });
  const isBig = ([u, s]) => s > 250000 || /butterchurn/i.test(u);
  const bigBefore = new Set([...jsSizes].filter(isBig).map(([u]) => u));
  const pickAndCheck = async (id, label) => {
    await page.evaluate(() => { window.__oldCanvas = document.querySelector('app-music-visualizer canvas'); });
    if ((await page.locator('select[aria-label="Visualizer preset"]').count()) === 0) {
      console.log('DEBUG picker missing:', JSON.stringify(await page.evaluate(() => ({ np: window.__music.ui.nowPlayingOpen(), viz: document.querySelectorAll('app-music-visualizer').length, url: location.pathname, status: document.querySelector('app-music-visualizer')?.getAttribute('data-viz-status') }))));
    }
    await page.selectOption('select[aria-label="Visualizer preset"]', id, { timeout: 8000 });
    const ok = await waitViz(page, 'ready', 40000) && (await vizAttr(page, 'data-viz-preset')) === id;
    const fresh = await page.evaluate(() => { const c = document.querySelector('app-music-visualizer canvas'); return !!c && c !== window.__oldCanvas && !(window.__oldCanvas && window.__oldCanvas.isConnected); });
    const same = await page.evaluate(() => window.__marker === 'same-page');
    check(`${label}: switching recreates the canvas without a page reload`, ok && fresh && same, `status=${await vizAttr(page, 'data-viz-status')}`);
    return ok;
  };
  const lcdOk = await pickAndCheck('lcd', 'LCD');
  if (lcdOk) { const h = await canvasHashes(page, 5, 400); check('LCD: pixels change over time', changes(h), `${new Set(h).size} distinct`); }
  const upOk = await pickAndCheck('unknown-pleasures', 'Unknown Pleasures');
  if (upOk) { const h = await canvasHashes(page, 5, 400); check('Unknown Pleasures: pixels change over time (WebGL)', changes(h), `${new Set(h).size} distinct`); if (shots) await page.screenshot({ path: `${shots}/p5-unknown-pleasures.png` }); }
  await wait(300);
  const bigMid = [...jsSizes].filter((e) => isBig(e) && !bigBefore.has(e[0]));
  check('Butterchurn chunk is not requested before Butterchurn is chosen', bigMid.length === 0, bigMid.map(([u, s]) => `${u.split('/').pop()}:${s}`).join(' '));
  const bcOk = await pickAndCheck('butterchurn', 'Butterchurn');
  await wait(500);
  const bigAfter = [...jsSizes].filter((e) => isBig(e) && !bigBefore.has(e[0]));
  check('Butterchurn chunk is requested when Butterchurn is chosen', bigAfter.length >= 1, bigAfter.map(([u, s]) => `${u.split('/').pop()}:${s}`).join(' '));
  if (bcOk) { const h = await canvasHashes(page, 5, 500); check('Butterchurn: pixels change over time', changes(h), `${new Set(h).size} distinct`); if (shots) await page.screenshot({ path: `${shots}/p5-butterchurn.png` }); }
  const kwOk = await pickAndCheck('kawarp', 'Kawarp');
  if (kwOk) { await wait(1500); const h = await canvasHashes(page, 5, 500); check('Kawarp: pixels change over time', changes(h), `${new Set(h).size} distinct`); if (shots) await page.screenshot({ path: `${shots}/p5-kawarp.png` }); }
  await pickAndCheck('particles', 'Particles (back)');

  // Settings plumbing
  const preset = await page.evaluate(() => window.__music.settings.visualizerPreset());
  check('chosen preset persists in settings.visualizerPreset', preset === 'particles', preset);
  // Cycle button
  await page.click('app-music-visualizer button[aria-label="Auto-cycle presets"]');
  check('auto-cycle toggle is a pressed button and persisted', (await page.getAttribute('app-music-visualizer button[aria-label="Auto-cycle presets"]', 'aria-pressed')) === 'true' && (await page.evaluate(() => JSON.parse(localStorage.getItem('fiesta:music:visualizer') || '{}').cycle)) === true);
  await page.click('app-music-visualizer button[aria-label="Auto-cycle presets"]');
  check('no uncaught page errors (visualizer)', errors.length === 0, errors.slice(0, 2).join(' | '));
  await page.context().close();
}

// ───────────── Unknown Pleasures without WebGL: canvas-2D fallback ─────────────
{
  const { page, errors } = await newPage({
    initScript: () => {
      const orig = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
        if (type === 'webgl' || type === 'webgl2' || type === 'experimental-webgl') return null;
        return orig.call(this, type, ...rest);
      };
    },
  });
  await playFirstTrack(page);
  await openVisualizer(page);
  await isolate(page);
  await waitViz(page);
  await page.selectOption('select[aria-label="Visualizer preset"]', 'unknown-pleasures');
  const ok = await waitViz(page, 'ready', 20000);
  const h = await canvasHashes(page, 5, 400);
  const is2d = await page.evaluate(() => { const c = document.querySelector('app-music-visualizer canvas'); return !!c.getContext('2d'); });
  check('Unknown Pleasures falls back to canvas 2D when WebGL is unavailable and still draws', ok && is2d && changes(h), `2d=${is2d} distinct=${new Set(h).size}`);
  check('no uncaught page errors (2D fallback)', errors.length === 0, errors.slice(0, 2).join(' | '));
  await page.context().close();
}

// ───────────── Waveform + silence bounds + crossfade ─────────────
{
  const { page, errors, reqs } = await newPage();
  await playFirstTrack(page);
  const lowCount = () => reqs.filter((u) => u.includes('action=manifest') && u.includes('quality=LOW')).length;
  const trackId = () => page.evaluate(() => window.__music.player.track()?.id);

  // Off by default: nothing extra on the network.
  const low0 = lowCount();
  await page.evaluate(() => window.__music.player.next());
  await wait(4000);
  check('waveform off: no waveform network requests (no LOW manifest) and no peak strip', lowCount() === low0 && (await page.locator('app-music-waveform svg').count()) === 0, `LOW manifests +${lowCount() - low0}`);

  // On: peaks within ~5 s of track start.
  await page.evaluate(() => window.__music.settings.waveformSeekbar.set(true));
  const tNext = Date.now();
  await page.evaluate(() => window.__music.player.next());
  const id = await trackId();
  let shown = false;
  while (Date.now() - tNext < 15000) {
    shown = await page.evaluate(() => { const p = document.querySelector('app-music-waveform svg[data-waveform=played] path'); return !!p && (p.getAttribute('d') || '').length > 50; });
    if (shown) break;
    await wait(100);
  }
  const took = ((Date.now() - tNext) / 1000).toFixed(1);
  check('waveform on: SVG peak strip behind the seek input within ~5 s of track start', shown && Date.now() - tNext < 6500, `${took}s, LOW manifests +${lowCount() - low0}`);
  const sw = await page.evaluate(() => { const t = document.querySelector('[data-seek-track]'); const w = t?.querySelector('app-music-waveform'); const i = t?.querySelector('input[aria-label="Seek"]'); return { inTrack: !!w && !!i, before: !!w && !!i && !!(w.compareDocumentPosition(i) & Node.DOCUMENT_POSITION_FOLLOWING), pe: w && getComputedStyle(w).pointerEvents }; });
  check('peak strip sits before the Seek input and ignores pointer events', sw.inTrack && sw.before && sw.pe === 'none', JSON.stringify(sw));
  const peaksLen = await page.evaluate((i) => window.__music.player.waveform().peaks(i)()?.length ?? 0, id);
  check('1000 peaks computed from the LOW rendition', peaksLen === 1000, `${peaksLen}`);
  const idb = await page.evaluate((i) => new Promise((res) => {
    const r = indexedDB.open('fiesta-music-waveform');
    r.onsuccess = () => { const db = r.result; const g = db.transaction('peaks').objectStore('peaks').get(i); g.onsuccess = () => res(g.result ? { n: g.result.peaks.length, d: g.result.duration } : null); g.onerror = () => res(null); };
    r.onerror = () => res(null);
  }), id);
  check('peaks cached in IndexedDB fiesta-music-waveform', !!idb && idb.n === 1000, JSON.stringify(idb));
  if (shots) await page.screenshot({ path: `${shots}/p5-waveform.png` });
  const prog = await page.evaluate(() => document.querySelector('app-music-waveform svg[data-waveform=played]')?.style.clipPath);
  check('played part is revealed by progress (clip-path inset)', /inset\(/.test(prog || ''), prog);

  // Cached: a second visit to the same track needs no new LOW manifest.
  await page.evaluate(() => window.__music.player.prev()); // the previous track was played with the waveform off: not cached
  await wait(3500);
  const lowBefore = lowCount();
  await page.evaluate(() => window.__music.player.next()); // back to the track whose peaks are cached
  await wait(3000);
  const peaksBack = await page.evaluate((i) => window.__music.player.waveform().peaks(i)()?.length ?? 0, id);
  check('cached peaks are reused (no new LOW manifest when returning to a known track)', lowCount() === lowBefore && peaksBack === 1000 && (await trackId()) === id, `+${lowCount() - lowBefore}`);

  // Off again.
  await page.evaluate(() => window.__music.settings.waveformSeekbar.set(false));
  await wait(300);
  check('waveform switched off removes the strip', (await page.locator('app-music-waveform svg').count()) === 0);

  // Silence bounds.
  await page.evaluate(() => window.__music.settings.removeSilence.set(true));
  await page.evaluate(() => window.__music.player.next());
  const id2 = await trackId();
  let b = null;
  for (let i = 0; i < 100 && !b; i++) { b = await page.evaluate((x) => window.__music.player.waveform().bounds(x), id2); if (!b) await wait(150); }
  const dur = await page.evaluate(() => window.__music.player.duration());
  check('removeSilence: bounds(trackId) returns leading/trailing boundaries', !!b && b.start >= 0 && b.end > b.start && b.end <= dur + 1, JSON.stringify({ b, dur }));
  await page.evaluate(() => window.__music.settings.removeSilence.set(false));

  // Crossfade.
  const volOk = await page.evaluate(() => { const a = new Audio(); a.volume = 0.5; return Math.abs(a.volume - 0.5) < 0.01; });
  check('supportsElementVolume probe is true where volume is writable (desktop Chrome)', volOk);
  await page.evaluate(() => window.__music.settings.crossfadeSeconds.set(5));
  await page.evaluate(() => window.__music.player.next());
  await page.waitForFunction(() => window.__music.player.duration() > 8 && window.__music.player.position() >= 1, null, { timeout: 30000 });
  await wait(1500); // let the standby deck preload
  await page.evaluate(() => {
    const els = window.__music.player.elements();
    const first = window.__music.player.activeElement();
    window.__cf = { rows: [], first: els.indexOf(first), stop: false };
    const t0 = performance.now();
    const tick = () => { window.__cf.rows.push([performance.now() - t0, els[0].volume, els[1].volume, window.__music.player.position(), window.__music.player.index()]); if (!window.__cf.stop) setTimeout(tick, 40); };
    tick();
  });
  // jump to 8 s before the end so the 5 s fade runs inside the window
  await page.evaluate(() => { const d = window.__music.player.duration(); window.__music.player.seek(Math.max(0, d - 9)); });
  const startIdx = await page.evaluate(() => window.__music.player.index());
  await page.waitForFunction((i) => window.__music.player.index() !== i, startIdx, { timeout: 30000 }).catch(() => {});
  await wait(6500); // the index flips when the fade starts; let all 5 s of it play out
  const cf = await page.evaluate(() => { window.__cf.stop = true; return window.__cf; });
  const rows = cf.rows;
  if (process.env.P5_DEBUG) console.log('DEBUG rows', JSON.stringify(rows.filter((r, i) => i % 6 === 0).map((r) => r.map((x) => +x.toFixed(2)))));
  const base = Math.max(...rows.map((r) => Math.max(r[1], r[2])));
  const out = cf.first, inc = 1 - cf.first;
  const mid = rows.filter((r) => r[1 + out] < base * 0.97 && r[1 + inc] < base * 0.97 && r[1 + out] > 0.02 && r[1 + inc] > 0.02);
  const crossed = mid.find((r) => Math.abs(r[1 + out] - r[1 + inc]) < base * 0.06);
  const power = mid.map((r) => (r[1 + out] ** 2 + r[1 + inc] ** 2) / base ** 2);
  const powerOk = power.length > 8 && power.every((p) => p > 0.85 && p < 1.15);
  const monoOut = mid.every((r, i) => i === 0 || r[1 + out] <= mid[i - 1][1 + out] + 0.02);
  const monoIn = mid.every((r, i) => i === 0 || r[1 + inc] >= mid[i - 1][1 + inc] - 0.02);
  const span = mid.length ? (mid[mid.length - 1][0] - mid[0][0]) / 1000 : 0;
  check('crossfade: outgoing ramps down and incoming ramps up (monotonic) over ~5 s', mid.length > 8 && monoOut && monoIn && span > 3 && span < 6.5, `${mid.length} samples over ${span.toFixed(1)}s, base=${base.toFixed(2)}`);
  check('crossfade: equal-power - the two gains cross near 0.707 of full volume', !!crossed && Math.abs(crossed[1 + out] / base - 0.707) < 0.12, crossed ? `at ${(crossed[1 + out] / base).toFixed(3)}/${(crossed[1 + inc] / base).toFixed(3)}` : 'no crossing');
  check('crossfade: gains keep constant power (g1^2 + g2^2 = 1)', powerOk, power.length ? `min ${Math.min(...power).toFixed(2)} max ${Math.max(...power).toFixed(2)}` : 'no samples');
  const finalIdx = await page.evaluate(() => window.__music.player.index());
  check('crossfade: the queue advanced to the next track', finalIdx !== startIdx, `${startIdx} -> ${finalIdx}`);
  await page.evaluate(() => window.__music.settings.crossfadeSeconds.set(0));
  check('no uncaught page errors (waveform/crossfade)', errors.length === 0, errors.slice(0, 2).join(' | '));
  await page.context().close();
}

await browser.close();
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
