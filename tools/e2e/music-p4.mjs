// E2E for package P4: lazy audio graph, graphic / parametric / M-S equalizer, AutoEQ, mono / crossfeed / widener.
//   node tools/e2e/music-p4.mjs [baseUrl=http://localhost:4204] [--shots=dir] [--token-file=path]
// Needs a running app + /api/music harness (see conventions); plays 30 s previews without a TIDAL user token.
// AutoEQ steps use the network (raw.githubusercontent.com / cdn.jsdelivr.net).
// Run from a dir whose node_modules has playwright(-core) (or set NODE_PATH).
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright-core')); } catch { ({ chromium } = require('playwright')); }

const base = process.argv.find((a) => a.startsWith('http')) || 'http://localhost:4204';
const shots = (process.argv.find((a) => a.startsWith('--shots=')) || '').slice(8);
const tokenFile = (process.argv.find((a) => a.startsWith('--token-file=')) || '').slice(13);
const userToken = tokenFile ? (await import('node:fs')).readFileSync(tokenFile, 'utf8').trim() : '';
const results = [];
const check = (name, ok, extra = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };

const browser = await chromium.launch({ channel: 'chrome', args: ['--autoplay-policy=no-user-gesture-required'] })
  .catch(() => chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] }));
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
if (userToken) await ctx.route('**/api/music*', (r) => r.continue({ headers: { ...r.request().headers(), 'x-tidal-token': userToken } }));
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const shot = async (p, name) => { if (shots) await p.screenshot({ path: `${shots}/music-p4-${name}.png` }); };

const G = (expr) => page.evaluate(`(() => { const g = window.__musicGraph; return ${expr}; })()`);
const sleep = (ms) => page.waitForTimeout(ms);
const setRange = (loc, v) => loc.evaluate((el, val) => { el.value = String(val); el.dispatchEvent(new Event('input', { bubbles: true })); }, v);
const sw = (label) => page.locator(`button[role=switch][aria-label="${label}"]`);
const near = (a, b, tol = 0.15) => Math.abs(a - b) <= tol;
const playingInfo = () => page.evaluate(() => {
  const els = window.__music.player.elements();
  const a = els.find((e) => !e.paused);
  return { anyPlaying: !!a, t: a ? a.currentTime : -1, n: els.length };
});
/** Peak deviation from silence on the graph's analyser over ~0.4 s (null when no analyser). */
const analyserPeak = () => page.evaluate(async () => {
  const an = window.__musicGraph.graph.analyser();
  if (!an) return null;
  const buf = new Uint8Array(an.fftSize);
  let peak = 0;
  for (let i = 0; i < 8; i++) {
    an.getByteTimeDomainData(buf);
    for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
    await new Promise((r) => setTimeout(r, 50));
  }
  return peak;
});

// ── 1. Lazy graph while a track plays ────────────────────────────────────────
await page.goto(base + '/music?q=radiohead&musicdebug=1', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.__musicGraph && !!window.__music, null, { timeout: 15000 });
await page.waitForSelector('app-music-track-row', { timeout: 25000 });
await page.locator('app-music-track-row button').first().click();
await page.waitForSelector('app-music-player-bar section', { timeout: 15000 });
await page.waitForFunction(() => window.__music.player.elements().some((e) => !e.paused && e.currentTime > 1.5), null, { timeout: 25000 });
check('no AudioContext exists while a track plays and no effect is on', (await G('g.contextCreations()')) === 0 && (await G('g.graph.active()')) === false && (await G('g.graph.context()')) === null);

// Client-side navigation to Settings > Audio keeps the track playing.
await page.evaluate(() => window.__music.settings.lastSettingsTab.set('audio'));
await page.locator('nav[aria-label="Music sections"] a:has-text("Settings")').click();
await page.waitForSelector('app-music-settings-audio', { timeout: 10000 });
await page.evaluate(() => { window.__marker = 'same-page'; });

check('Audio section: Equalizer switch, three mode tabs', (await sw('Equalizer').count()) === 1
  && (await page.locator('[role=tablist][aria-label="Equalizer mode"] button[role=tab]').allTextContents()).map((s) => s.trim()).join(',') === 'Graphic,Parametric,AutoEQ');
const preamp = page.locator('input[aria-label="Preamp (dB)"]');
check('preamp slider spans -20..+20 dB', (await preamp.getAttribute('min')) === '-20' && (await preamp.getAttribute('max')) === '20');
const presetVals = await page.locator('select[aria-label="Preset"] optgroup[label="Presets"] option').allTextContents();
check('preset select lists the 16 built-in presets', presetVals.length === 16 && presetVals.includes('Bass Boost') && presetVals.includes('Podcast / Speech'), `${presetVals.length} presets`);
const countOpts = await page.locator('select[aria-label="Band count"] option').evaluateAll((o) => o.map((x) => +x.value));
check('band count select 3..32, graphic default 10', countOpts[0] === 3 && countOpts[countOpts.length - 1] === 32 && (await page.locator('select[aria-label="Band count"]').inputValue()) === '10');
check('graphic mode: 10 vertical sliders labelled by frequency', await page.locator('input[aria-label$=" Hz gain"]').evaluateAll((l) => l.map((x) => x.getAttribute('aria-label')).join('|')) === ['31','62','125','250','500','1K','2K','4K','8K','16K'].map((f) => `${f} Hz gain`).join('|'));
await shot(page, 'graphic-off');

// Changing settings while the equalizer is off must not create a context.
await page.locator('select[aria-label="Preset"]').selectOption('rock');
check('editing the EQ while it is off creates no AudioContext', (await G('g.contextCreations()')) === 0);

const before = await playingInfo();
await sw('Equalizer').click();
await sleep(1200);
const after = await playingInfo();
check('enabling the EQ creates exactly one running AudioContext and graph.active() is true',
  (await G('g.contextCreations()')) === 1 && (await G('g.graph.active()')) === true && (await G('g.contextState()')) === 'running');
check('playback continues after enabling (element not paused, currentTime advancing)', before.anyPlaying && after.anyPlaying && after.t > before.t + 0.5, `${before.t.toFixed(1)}s -> ${after.t.toFixed(1)}s`);
const peak = await analyserPeak();
check('audio is audible through the graph (analyser sees signal)', peak !== null && peak > 2, `peak deviation ${peak}`);
check('each of the 2 deck elements has exactly one MediaElementSource', (await G('g.sourceCount()')) === 2 && after.n === 2);
check('window did not reload when the preset changed', (await page.evaluate(() => window.__marker)) === 'same-page');

for (let i = 0; i < 6; i++) await sw('Equalizer').click();
await sleep(200);
check('toggling the EQ repeatedly: no InvalidStateError, still one context and 2 sources',
  errors.length === 0 && (await G('g.contextCreations()')) === 1 && (await G('g.sourceCount()')) === 2 && (await sw('Equalizer').getAttribute('aria-checked')) === 'true', errors[0] || '');
check('chain is analyser-fed EQ only', JSON.stringify(await G('g.chain()')) === '["eq"]');

// ── 2. Graphic mode drives the BiquadFilters ─────────────────────────────────
await page.locator('select[aria-label="Preset"]').selectOption('flat');
await setRange(page.locator('input[aria-label="500 Hz gain"]'), 6);
await sleep(400);
let gains = await G('g.filterGains()');
check('graphic slider 500 Hz moves exactly that BiquadFilter gain', gains.length === 10 && near(gains[4], 6) && gains.filter((_, i) => i !== 4).every((v) => Math.abs(v) < 0.01), gains.map((v) => v.toFixed(1)).join(','));
await page.locator('select[aria-label="Preset"]').selectOption('bass_boost');
await sleep(400);
gains = await G('g.filterGains()');
check('picking a preset applies it to the live filters', gains[0] > 3 && Math.abs(gains[9]) < 0.1, gains.map((v) => v.toFixed(1)).join(','));
await setRange(preamp, -6);
await sleep(200);
check('preamp persists to storage', (await page.evaluate(() => JSON.parse(localStorage.getItem('fiesta:music:eq')).preamp)) === -6);
await page.locator('select[aria-label="Band count"]').selectOption('16');
await sleep(300);
check('graphic band count 16 builds 16 filters and sliders', (await G('g.filterGains().length')) === 16 && (await page.locator('input[aria-label$=" Hz gain"]').count()) === 16);
await page.locator('select[aria-label="Band count"]').selectOption('10');
// Custom preset save / delete.
await setRange(page.locator('input[aria-label="1K Hz gain"]'), -4);
await page.fill('#music-eq-preset-name', 'E2E curve');
await page.click('button:has-text("Save preset")');
check('custom graphic preset saves and lists', (await page.locator('ul[aria-label="Your presets"] li:has-text("E2E curve")').count()) === 1);
await page.click('button[aria-label="Delete preset E2E curve"]');
check('custom graphic preset deletes', (await page.locator('ul[aria-label="Your presets"] li:has-text("E2E curve")').count()) === 0);
await shot(page, 'graphic');

// ── 3. Parametric mode ───────────────────────────────────────────────────────
await page.locator('button[role=tab]:has-text("Parametric")').click();
await page.locator('select[aria-label="Preset"]').selectOption('flat');
await page.locator('select[aria-label="Band count"]').selectOption('8');
await page.waitForSelector('app-music-parametric-graph, app-music-eq-parametric-graph canvas');
await sleep(500);
check('parametric: canvas graph draws (grid and curve pixels)', await page.evaluate(() => {
  const c = document.querySelector('app-music-eq-parametric-graph canvas');
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
  return n > 500;
}));
check('parametric: 8 bands in numeric controls and live filters', (await page.locator('app-music-eq-band-controls [data-band]').count()) === 8 && (await G('g.filterGains().length')) === 8);

const canvas = page.locator('app-music-eq-parametric-graph canvas');
const geo = async () => {
  const r = await canvas.boundingBox();
  const freq = +(await page.locator('input[aria-label="Band 4 frequency (Hz)"]').inputValue());
  const gain = +(await page.locator('input[aria-label="Band 4 gain (dB)"]').inputValue());
  const PAD = { l: 36, r: 12, t: 12, b: 22 };
  const px = (f) => r.x + PAD.l + (r.width - PAD.l - PAD.r) * Math.log(f / 20) / Math.log(1000);
  const py = (g) => r.y + PAD.t + (r.height - PAD.t - PAD.b) * (1 - (g + 15) / 30);
  return { r, freq, gain, x: px(freq), y: py(gain), px, py };
};
let s = await geo();
await page.mouse.move(s.x, s.y);
await page.mouse.down();
await page.mouse.move(s.x + 40, s.y - 30, { steps: 6 });
await page.mouse.move(s.px(2500), s.py(6), { steps: 8 });
await page.mouse.up();
await sleep(300);
const f4 = +(await page.locator('input[aria-label="Band 4 frequency (Hz)"]').inputValue());
const g4 = +(await page.locator('input[aria-label="Band 4 gain (dB)"]').inputValue());
const live = { f: (await G('g.filterFreqs()'))[3], g: (await G('g.filterGains()'))[3] };
check('parametric: dragging a node changes frequency and gain (numeric inputs and live filter mirror it)',
  f4 > 1800 && f4 < 3500 && g4 > 4 && g4 < 8 && Math.abs(live.f - f4) < 40 && near(live.g, g4, 0.3), `${f4} Hz ${g4} dB; live ${Math.round(live.f)} Hz ${live.g.toFixed(1)} dB`);

const q0 = +(await page.locator('input[aria-label="Band 4 Q"]').inputValue());
s = await geo();
await page.mouse.move(s.x, s.y);
await page.mouse.wheel(0, -300);
await sleep(300);
const q1 = +(await page.locator('input[aria-label="Band 4 Q"]').inputValue());
check('parametric: wheel over a node changes Q', q1 > q0 * 1.2, `${q0} -> ${q1}`);

const fInput = page.locator('input[aria-label="Band 2 frequency (Hz)"]');
await fInput.fill('777'); await fInput.press('Enter'); await sleep(300);
check('parametric: numeric input drives the filter', Math.abs((await G('g.filterFreqs()'))[1] - 777) < 5);

// Mid/side per band.
const gIn = page.locator('input[aria-label="Band 3 gain (dB)"]');
await gIn.fill('5'); await gIn.press('Enter'); await sleep(200);
await page.locator('select[aria-label^="Band 3 channel"]').selectOption('side');
await sleep(500);
const mid = await G('g.filterGains()'); const side = await G('g.sideFilterGains()');
check('parametric: M/S toggle moves band 3 to the side chain (mid gain 0, side gain 5)', side.length === 8 && Math.abs(mid[2]) < 0.05 && near(side[2], 5, 0.2), `mid ${mid[2].toFixed(2)} side ${side[2]?.toFixed(2)}`);
check('M/S playback stays audible', (await analyserPeak()) > 2 && (await playingInfo()).anyPlaying);
await page.locator('select[aria-label^="Band 3 channel"]').selectOption('stereo');
await sleep(400);
check('back to stereo: single chain again', (await G('g.sideFilterGains().length')) === 0 && near((await G('g.filterGains()'))[2], 5, 0.2));

// Long-press (touch) opens the band menu.
s = await geo();
await canvas.evaluate((c, p) => {
  c.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 9, pointerType: 'touch', isPrimary: true, clientX: p.x, clientY: p.y, button: 0, bubbles: true }));
}, { x: s.x, y: s.y });
await sleep(800);
check('parametric: long-press on touch opens the band menu', (await page.locator('[role=menu][aria-label="Band options"]').count()) === 1);
await page.locator('[role=menuitemradio]:has-text("Mid only")').click();
await sleep(200);
check('band menu sets the channel (select mirrors it)', (await page.locator('select[aria-label^="Band 4 channel"]').inputValue()) === 'mid');
await shot(page, 'parametric-menu');
await page.keyboard.press('Escape');
check('Escape closes the band menu', (await page.locator('[role=menu]').count()) === 0);
await canvas.evaluate((c) => c.dispatchEvent(new PointerEvent('pointerup', { pointerId: 9, pointerType: 'touch', bubbles: true })));
await page.locator('select[aria-label^="Band 4 channel"]').selectOption('stereo');
await shot(page, 'parametric');

// M/S preset.
await page.locator('select[aria-label="Preset"]').selectOption('ms_vocal_clarity');
await sleep(500);
check('M/S preset: bands carry mid/side channels and the side chain exists', (await G('g.sideFilterGains().length')) === 6 && (await page.locator('select[aria-label^="Band 1 channel"]').inputValue()) === 'side');

// ── 4. Export / import ───────────────────────────────────────────────────────
await page.locator('select[aria-label="Preset"]').selectOption('rock');
await page.locator('select[aria-label="Band count"]').selectOption('6');
await sleep(300);
await page.locator('button:has-text("Import and export")').click();
const text1 = await page.locator('textarea[aria-label="Equalizer settings text"]').inputValue();
check('export is EqualizerAPO text (Preamp line + Filter lines)', /^Preamp: -?\d+\.\d dB\nFilter 1: ON PK Fc \d+ Hz Gain -?\d+\.\d dB Q \d+\.\d\d/.test(text1) && text1.split('\n').length === 7, text1.split('\n').slice(0, 2).join(' / '));
const bandsDump = () => page.evaluate(() => Array.from(document.querySelectorAll('app-music-eq-band-controls [data-band]')).map((row) => Array.from(row.querySelectorAll('input[type=number]')).map((i) => i.value).join(',')).join(';'));
const dump1 = await bandsDump();
await page.locator('select[aria-label="Preset"]').selectOption('flat');
await sleep(200);
const dumpFlat = await bandsDump();
await page.locator('textarea[aria-label="Equalizer settings text"]').fill(text1);
await page.click('button:has-text("Import text")');
await sleep(400);
const dump2 = await bandsDump();
check('importing the exported text restores the same bands', dumpFlat !== dump1 && dump1 === dump2, dump1.slice(0, 60));
await page.locator('textarea[aria-label="Equalizer settings text"]').fill('garbage');
await page.click('button:has-text("Import text")');
check('importing garbage shows an amber error and changes nothing', (await page.locator('[role=alert].text-amber-400').count()) >= 1 && (await bandsDump()) === dump1);

// ── 5. AutoEQ ────────────────────────────────────────────────────────────────
await page.locator('button[role=tab]:has-text("AutoEQ")').click();
await page.waitForSelector('#music-autoeq-search');
await page.fill('#music-autoeq-search', 'HD 600');
await page.waitForSelector('ul[aria-label="Headphone results"] button', { timeout: 15000 });
const idxInfo = await page.evaluate(async () => {
  const dbs = (await indexedDB.databases?.()) || [];
  return dbs.map((d) => d.name);
});
await page.waitForFunction(() => document.querySelectorAll('ul[aria-label="Headphone results"] button').length > 0);
await sleep(1500);
const resCount = await page.locator('ul[aria-label="Headphone results"] button').count();
check('AutoEQ: searching the headphone index returns models', resCount >= 2, `${resCount} results for "HD 600"`);
check('AutoEQ: the index is cached in IndexedDB fiesta-music-autoeq', (await page.evaluate(async () => {
  const dbs = (await indexedDB.databases?.()) || [];
  if (!dbs.some((d) => d.name === 'fiesta-music-autoeq')) return false;
  return await new Promise((res) => {
    const rq = indexedDB.open('fiesta-music-autoeq');
    rq.onsuccess = () => { try { const g = rq.result.transaction('kv').objectStore('kv').get('index-v3'); g.onsuccess = () => { const ok = !!g.result && g.result.data.length > 100; rq.result.close(); res(ok); }; g.onerror = () => res(false); } catch { res(false); } };
    rq.onerror = () => res(false);
  });
})) , `dbs: ${idxInfo.join(',')}`);
await page.locator('ul[aria-label="Headphone results"] button').first().click();
await page.waitForSelector('button:has-text("Apply to equalizer")', { timeout: 30000 });
const previewText = await page.locator('#music-autoeq-result').innerText();
check('AutoEQ: picking a model computes a parametric correction (preview with bands and preamp)', /Preview/.test(previewText) && (await page.locator('text=/\\d+ bands, preamp -?\\d/').count()) >= 1, (await page.locator('text=/\\d+ bands, preamp/').first().textContent()).trim());
await shot(page, 'autoeq-preview');
await page.fill('input[aria-label="AutoEQ band count"]', '6'); await page.press('input[aria-label="AutoEQ band count"]', 'Enter');
await sleep(300);
const nb = +((await page.locator('text=/\\d+ bands, preamp/').first().textContent()).match(/(\d+) bands/)[1]);
check('AutoEQ: band count option limits the result', nb >= 1 && nb <= 6, `${nb} bands`);
await page.click('button:has-text("Apply to equalizer")');
await sleep(600);
const aeq = await G('g.filterGains()');
check('AutoEQ: Apply puts the bands on the live filters in AutoEQ mode', aeq.length === nb && aeq.some((v) => Math.abs(v) > 0.3) && (await page.locator('[role=tablist][aria-label="Equalizer mode"] button[aria-selected=true]').textContent()).includes('AutoEQ') && (await page.evaluate(() => JSON.parse(localStorage.getItem('fiesta:music:eq')).mode)) === 'autoeq', `${nb} filters`);
check('AutoEQ: playback still audible with the correction', (await analyserPeak()) > 2);
// Save, apply, delete a profile.
await page.fill('#music-autoeq-profile-name', 'E2E profile');
await page.click('button:has-text("Save profile")');
check('AutoEQ: profile saves', (await page.locator('ul[aria-label="Saved AutoEQ profiles"] li:has-text("E2E profile")').count()) === 1);
await page.locator('select[aria-label="Band count"]').count();
await page.click('button[aria-label="Apply profile E2E profile"]');
await sleep(400);
check('AutoEQ: profile applies', (await G('g.filterGains().length')) === nb);
// Custom measurement CSV + custom target CSV.
const rows = [];
for (let f = 20; f <= 20000; f *= Math.pow(2, 1 / 12)) rows.push(`${f.toFixed(1)},${(75 + 6 * Math.exp(-Math.pow(Math.log2(f / 3000) / 0.6, 2)) - 4 * Math.exp(-Math.pow(Math.log2(f / 100) / 0.7, 2))).toFixed(2)}`);
await page.locator('input[aria-label="Import measurement CSV"]').setInputFiles({ name: 'my-cans.csv', mimeType: 'text/csv', buffer: Buffer.from('frequency,raw\n' + rows.join('\n')) });
await page.waitForSelector('button:has-text("Apply to equalizer")', { timeout: 10000 });
const cust = await page.locator('text=/\\d+ bands, preamp/').first().textContent();
check('AutoEQ: custom measurement CSV import works', /my-cans/.test(await page.locator('#music-autoeq-result').innerText()) && /\d+ bands/.test(cust), cust.trim());
await page.locator('input[aria-label="Import target CSV"]').setInputFiles({ name: 'flat-ish.csv', mimeType: 'text/csv', buffer: Buffer.from('freq,spl\n' + rows.map((r) => r.split(',')[0] + ',75').join('\n')) });
await sleep(300);
check('AutoEQ: custom target CSV import works', (await page.locator('text=flat-ish').count()) >= 1);
await page.locator('input[aria-label="Import measurement CSV"]').setInputFiles({ name: 'bad.csv', mimeType: 'text/csv', buffer: Buffer.from('not a table') });
await sleep(200);
check('AutoEQ: bad CSV shows an amber message', (await page.locator('p[role=alert].text-amber-400').count()) >= 1);
await page.click('button:has-text("Discard")').catch(() => {});
await page.click('button[aria-label="Delete profile E2E profile"]');
check('AutoEQ: profile deletes', (await page.locator('ul[aria-label="Saved AutoEQ profiles"] li:has-text("E2E profile")').count()) === 0);
await shot(page, 'autoeq');

// ── 6. Mono / crossfeed / widener ────────────────────────────────────────────
await sw('Mono audio').click();
await sw('Crossfeed').click();
await sw('Stereo widener').click();
await setRange(page.locator('input[aria-label="Crossfeed level (dB)"]'), -8);
await setRange(page.locator('input[aria-label="Crossfeed cutoff (Hz)"]'), 900);
await setRange(page.locator('input[aria-label="Stereo width"]'), 1.5);
await sleep(500);
check('DSP: mono, crossfeed and widener join the chain in order before the EQ', JSON.stringify(await G('g.chain()')) === '["mono","crossfeed","widener","eq"]');
check('DSP: playback stays audible through the full chain', (await playingInfo()).anyPlaying && (await analyserPeak()) > 2);
const dsp = await page.evaluate(() => JSON.parse(localStorage.getItem('fiesta:music:dsp')));
check('DSP: crossfeed level/cutoff and width persist', dsp.mono && dsp.crossfeed.enabled && dsp.crossfeed.level === -8 && dsp.crossfeed.cutoff === 900 && dsp.widener.enabled && dsp.widener.width === 1.5, JSON.stringify(dsp));
await sw('Mono audio').click();
await sleep(200);
check('DSP: switching mono off drops that stage', JSON.stringify(await G('g.chain()')) === '["crossfeed","widener","eq"]');
await sw('Mono audio').click();
await shot(page, 'dsp');

// Context resumes after it is suspended (statechange path).
await page.evaluate(() => window.__musicGraph.graph.context().suspend());
await page.waitForFunction(() => window.__musicGraph.contextState() === 'running', null, { timeout: 5000 }).catch(() => {});
check('AudioContext resumes after being suspended', (await G('g.contextState()')) === 'running');

check('no uncaught page errors during the run', errors.length === 0, errors.slice(0, 2).join(' | '));

// ── 7. Reload: settings survive and are re-applied after the next gesture ────
await page.goto(base + '/music/settings?tab=audio&musicdebug=1', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('app-music-settings-audio');
await page.waitForFunction(() => !!window.__musicGraph);
check('after reload no AudioContext exists until a gesture', (await G('g.contextCreations()')) === 0);
check('after reload: EQ switch, mode and DSP states are restored', (await sw('Equalizer').getAttribute('aria-checked')) === 'true'
  && (await page.locator('[role=tablist][aria-label="Equalizer mode"] button[aria-selected=true]').textContent()).includes('AutoEQ')
  && (await sw('Crossfeed').getAttribute('aria-checked')) === 'true' && (await sw('Mono audio').getAttribute('aria-checked')) === 'true'
  && (await page.locator('input[aria-label="Stereo width"]').inputValue()) === '1.5' && (await page.locator('input[aria-label="Preamp (dB)"]').inputValue()) !== '0');
await page.mouse.click(600, 120);
await sleep(600);
check('after the first user gesture the graph is rebuilt with the saved settings', (await G('g.contextCreations()')) === 1 && JSON.stringify(await G('g.chain()')) === '["mono","crossfeed","widener","eq"]' && (await G('g.filterGains().length')) === nb);

// ── 8. Mobile layout ─────────────────────────────────────────────────────────
const m = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const mp = await m.newPage();
await mp.goto(base + '/music/settings?tab=audio', { waitUntil: 'domcontentloaded' });
await mp.waitForSelector('app-music-settings-audio');
const noOverflow = async (label) => {
  const o = await mp.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
  check(`mobile: no horizontal page scroll (${label})`, o.sw <= o.iw + 1, `${o.sw} <= ${o.iw}`);
};
await noOverflow('graphic');
await mp.locator('button[role=tab]:has-text("Parametric")').click();
await mp.waitForSelector('app-music-eq-parametric-graph canvas');
await noOverflow('parametric');
await mp.screenshot({ path: shots ? `${shots}/music-p4-mobile-parametric.png` : '/tmp/music-p4-mobile.png' });
await mp.locator('button[role=tab]:has-text("AutoEQ")').click();
await mp.waitForSelector('#music-autoeq-search');
await noOverflow('autoeq');
const small = await mp.evaluate(() => Array.from(document.querySelectorAll('app-music-settings-audio button, app-music-settings-audio select, app-music-settings-audio input:not([type=file]):not([type=range]):not([type=checkbox])')).filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && (r.height < 39.5); }).map((e) => (e.getAttribute('aria-label') || e.textContent || e.tagName).trim().slice(0, 30)));
check('mobile: touch targets are at least 40px tall', small.length === 0, small.slice(0, 5).join(' | '));

await browser.close();
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
