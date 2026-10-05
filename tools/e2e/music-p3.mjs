// E2E for package P3 (lyrics engine, panel, karaoke view, settings section).
//   node tools/e2e/music-p3.mjs [baseUrl=http://localhost:4203] [--shots=dir] [--token-file=path]
// Every lyric provider and Google Translate is answered by page.route fixtures, so there is no
// live dependency besides the app's own /api/music (search + playback; 30 s previews are fine).
// Run from a dir whose node_modules has playwright(-core) (or set NODE_PATH).
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright-core')); } catch { ({ chromium } = require('playwright')); }

const base = process.argv.find((a) => a.startsWith('http')) || 'http://localhost:4203';
const shots = (process.argv.find((a) => a.startsWith('--shots=')) || '').slice(8);
const tokenFile = (process.argv.find((a) => a.startsWith('--token-file=')) || '').slice(13);
const userToken = tokenFile ? readFileSync(tokenFile, 'utf8').trim() : '';
const results = [];
const check = (name, ok, extra = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };
const note = (name, extra = '') => console.log(`SKIP  ${name}${extra ? '  ' + extra : ''}`);

const browser = await chromium.launch({ channel: 'chrome', args: ['--autoplay-policy=no-user-gesture-required'] })
  .catch(() => chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] }));
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true });
if (userToken) await ctx.route('**/api/music*', (r) => r.continue({ headers: { ...r.request().headers(), 'x-tidal-token': userToken } }));

// ── fixtures ────────────────────────────────────────────────────────────────
const LRC = [
  '[00:02.00]First lyric line', '[00:06.00]Second lyric line', '[00:10.00]Third lyric line', '[00:14.00]Fourth lyric line',
  '[00:16.00]', '[00:26.00]Fifth lyric line', '[00:27.50]Sixth lyric line',
].join('\n');
const CYRILLIC = ['[00:02.00]Привет мир', '[00:06.00]Как дела сегодня', '[00:10.00]Доброе утро'].join('\n');
const ARABIC = ['[00:02.00]مرحبا بالعالم', '[00:06.00]كيف حالك اليوم'].join('\n');
const TTML = `<?xml version="1.0" encoding="UTF-8"?>
<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttm="http://www.w3.org/ns/ttml#metadata" xmlns:itunes="http://music.apple.com/lyric-ttml-internal" xml:lang="en">
<head><metadata><ttm:agent type="person" xml:id="v1"/><ttm:agent type="person" xml:id="v2"/></metadata></head>
<body><div>
<p begin="00:02.000" end="00:06.000" ttm:agent="v1"><span begin="00:02.000" end="00:03.000">Hello </span><span begin="00:03.000" end="00:04.000">wide </span><span begin="00:04.000" end="00:06.000">world</span></p>
<p begin="00:08.000" end="00:12.000" ttm:agent="v2"><span begin="00:08.000" end="00:10.000">Other </span><span begin="00:10.000" end="00:12.000">singer</span><span ttm:role="x-bg"><span begin="00:09.000" end="00:11.000">(ooh)</span></span></p>
</div></body></tt>`;

/** What the mocked providers answer. Reset per scenario. */
let S = {};
const calls = [];
const cors = { 'access-control-allow-origin': '*' };
const json = (route, body) => route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify(body) });
const miss = (route) => route.fulfill({ status: 404, headers: cors, body: '' });

await ctx.route(/^https:\/\/(lrc\.red|lyrics-api\.binimum\.org|unison\.boidu\.dev|lyricsplus\.binimum\.org|lyricsplus-seven\.vercel\.app|lyricsplus\.prjktla\.workers\.dev|lyrics-plus-backend\.vercel\.app|lrclib\.net|fetch-genius\.samidy\.workers\.dev|translate\.googleapis\.com)\//, async (route) => {
  const url = new URL(route.request().url());
  calls.push(url.host + url.pathname + url.search);
  if (S.google === 'fail' && url.host === 'translate.googleapis.com') return route.abort('failed');
  if (S.down && url.host !== 'translate.googleapis.com') return route.abort('failed');
  if (url.host === 'lrclib.net') return S.lrclib ? json(route, [S.lrclib]) : miss(route);
  if (url.host === 'unison.boidu.dev') return S.unison ? json(route, { success: true, data: { lyrics: S.unison, format: 'lrc', syncType: 'linesync' } }) : miss(route);
  if (url.host === 'translate.googleapis.com') {
    const q = url.searchParams.get('q') || '';
    const rows = q.split('\n');
    if (url.searchParams.get('dt') === 'rm') return json(route, [rows.map((l) => [null, null, null, `rom:${l}`])]);
    const tl = url.searchParams.get('tl');
    return json(route, [rows.map((l, i) => [`tr-${tl}:${l}${i < rows.length - 1 ? '\n' : ''}`, l])]);
  }
  return miss(route);
});
await ctx.route('**/assets/music/lyrics/**', (route) => {
  const name = route.request().url().split('/').pop().split('?')[0];
  const body = S.owner?.[name];
  return body ? route.fulfill({ status: 200, contentType: 'text/plain', body }) : route.fulfill({ status: 404, body: '' });
});

const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const wait = (ms) => page.waitForTimeout(ms);
const until = async (fn, arg, ms = 12000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await page.evaluate(fn, arg).catch(() => false)) return true; await wait(150); }
  return false;
};
const view = page.locator('app-music-lyrics-view');
const activeText = async () => ((await view.locator('[aria-current="true"]').first().textContent({ timeout: 300 }).catch(() => '')) || '').trim();
const untilActive = async (re, ms = 6000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (re.test(await activeText())) return true; await wait(120); }
  return false;
};
const untilNoActive = async (ms = 6000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if ((await view.locator('[aria-current="true"]').count()) === 0) return true; await wait(120); }
  return false;
};
const seek = (t) => page.evaluate((x) => window.__music.player.seek(x), t);
const sourceText = async () => ((await view.locator('[data-source]').first().textContent({ timeout: 4000 }).catch(() => '')) || '').replace(/\s+/g, ' ').trim();

// ── boot, search, play ──────────────────────────────────────────────────────
await page.goto(base + '/music?musicdebug=1', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.__music, null, { timeout: 20000 });
const tracks = await page.evaluate(async () => {
  const r = await fetch('/api/music?action=search&q=daft+punk&limit=30');
  return (await r.json()).tracks || [];
});
const uniq = [...new Map(tracks.map((t) => [t.id, t])).values()];
check('search returned enough tracks to use one per scenario', uniq.length >= 8, `${uniq.length} tracks`);

async function playTrack(t, scenario) {
  S = scenario;
  await page.evaluate((tr) => window.__music.player.play(tr), t);
  await until(() => (window.__music.player.position() || 0) > 0.6, null, 20000);
  await page.evaluate(() => window.__music.player.pause());
}

// ── scenario 1: synced LRC through LRCLIB ───────────────────────────────────
const T0 = uniq[0];
S = { lrclib: { syncedLyrics: LRC, plainLyrics: 'x' } };
await page.evaluate((tr) => window.__music.player.play(tr), T0);
await until(() => (window.__music.player.position() || 0) > 0.6, null, 20000);
await page.evaluate(() => window.__music.player.pause());

const barButton = page.locator('app-music-player-bar button[aria-label="Lyrics"], app-music-player-bar button[aria-label="Show lyrics"], app-music-player-bar button[aria-label="Open lyrics"]');
if (await barButton.count()) {
  await barButton.first().click();
  await page.waitForSelector('[role=dialog] h2:text-is("Lyrics")', { timeout: 8000 }).catch(() => {});
  check("pressing the bar's Lyrics button opens the panel", await page.locator('[role=dialog] h2:text-is("Lyrics")').count() === 1);
} else {
  note("the player bar has no Lyrics button yet (package P1 owns it); opening through ui.openPanel('lyrics')");
  await page.evaluate(() => window.__music.ui.openPanel('lyrics'));
}
await page.waitForSelector('[role=dialog] h2:text-is("Lyrics")', { timeout: 8000 }).catch(() => {});
check("panel is a dialog titled 'Lyrics'", (await page.locator('[role=dialog] h2:text-is("Lyrics")').count()) === 1);
await view.locator('li[data-row]').first().waitFor({ timeout: 10000 }).catch(() => {});
check('synced lyrics render as seekable lines', (await view.locator('li[data-row] button').count()) === 6, `${await view.locator('li[data-row] button').count()} lines`);
check('source footer names the provider', /Source:\s*LRCLIB/.test(await sourceText()), await sourceText());
if (shots) await page.screenshot({ path: `${shots}/p3-panel.png` });

await seek(4);
check("active line gets aria-current='true' (First)", await untilActive(/First lyric line/), await activeText());
await seek(8);
check('active line changes as the player seeks (Second)', await untilActive(/Second lyric line/), await activeText());
await seek(26.5);
check('active line follows a later seek (Fifth)', await untilActive(/Fifth lyric line/), await activeText());

// click a line -> seek
await view.locator('li[data-row] button', { hasText: 'Third lyric line' }).click();
await wait(500);
const posAfterClick = await page.evaluate(() => window.__music.player.position());
check("clicking a line seeks the player to that line's start", Math.abs(posAfterClick - 10) < 1.5, `position ${posAfterClick}s`);
check('clicking a line also resumes playback', await until(() => window.__music.player.playing(), null, 4000));
await page.evaluate(() => window.__music.player.pause());

// auto-scroll keeps the active line in the upper part of the panel
await seek(26.5);
await untilActive(/Fifth/);
await wait(900);
const geo = await page.evaluate(() => {
  const el = document.querySelector('app-music-lyrics-view [aria-current="true"]');
  let sc = el; while (sc && !(getComputedStyle(sc).overflowY === 'auto' && sc.scrollHeight > sc.clientHeight + 1)) sc = sc.parentElement;
  if (!el || !sc) return null;
  const r = el.getBoundingClientRect(); const s = sc.getBoundingClientRect();
  return { rel: (r.top - s.top) / s.height, scrollTop: sc.scrollTop };
});
check('auto-scroll puts the active line in the upper half of the panel', !!geo && geo.scrollTop > 50 && geo.rel < 0.5, JSON.stringify(geo));

// user scroll pauses auto-scroll and offers the pill
await page.mouse.move(1100, 400);
await page.mouse.wheel(0, -400);
await wait(300);
const pill = view.locator('button:has-text("Back to current line")');
check("scrolling by hand shows a 'Back to current line' pill", (await pill.count()) === 1);
await pill.click();
await wait(900);
check('the pill resumes auto-scroll and disappears', (await pill.count()) === 0 && (await page.evaluate(() => {
  const el = document.querySelector('app-music-lyrics-view [aria-current="true"]');
  let sc = el; while (sc && !(getComputedStyle(sc).overflowY === 'auto' && sc.scrollHeight > sc.clientHeight + 1)) sc = sc.parentElement;
  if (!el || !sc) return false;
  return (el.getBoundingClientRect().top - sc.getBoundingClientRect().top) / sc.clientHeight < 0.5;
})));

// instrumental gap: three dots, static under reduced motion
await seek(20);
await untilNoActive();
check('no line is highlighted inside an instrumental gap (16s to 26s)', (await view.locator('[aria-current="true"]').count()) === 0);
const dots = view.locator('[data-gap] span');
check('an instrumental gap shows three dots', (await dots.count()) === 3);
await page.emulateMedia({ reducedMotion: 'no-preference' });
await wait(200);
const animNormal = await dots.first().evaluate((el) => getComputedStyle(el).animationName);
await page.emulateMedia({ reducedMotion: 'reduce' });
await wait(200);
const animReduced = await dots.first().evaluate((el) => getComputedStyle(el).animationName);
check('gap dots animate normally and are static under prefers-reduced-motion', animNormal !== 'none' && animReduced === 'none', `${animNormal} -> ${animReduced}`);
await page.emulateMedia({ reducedMotion: 'no-preference' });

// timing offset
await seek(6.2);
await untilActive(/Second lyric line/);
const plusBtn = view.locator('button:text-is("+0.5s")');
const minusBtn = view.locator('button:text-is("-0.5s")');
check("offset buttons '+0.5s' and '-0.5s' exist", (await plusBtn.count()) === 1 && (await minusBtn.count()) === 1);
await plusBtn.click();
check("'+0.5s' shifts highlighting (6.2s now shows First)", await untilActive(/First lyric line/), await activeText());
await minusBtn.click();
check("'-0.5s' shifts it back (Second)", await untilActive(/Second lyric line/), await activeText());
await plusBtn.click();
const stored = await page.evaluate(() => localStorage.getItem('fiesta:music:lyrics-offsets'));
check('the offset is stored per track under fiesta:music:lyrics-offsets', !!stored && JSON.parse(stored)[String(T0.id)] === 0.5, stored);
await page.waitForTimeout(400);
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.__music, null, { timeout: 20000 });
S = { lrclib: { syncedLyrics: LRC, plainLyrics: 'x' } };
await page.evaluate((tr) => window.__music.player.play(tr), T0);
await until(() => (window.__music.player.position() || 0) > 0.6, null, 20000);
await page.evaluate(() => { window.__music.player.pause(); window.__music.ui.openPanel('lyrics'); });
await view.locator('li[data-row]').first().waitFor({ timeout: 10000 }).catch(() => {});
await seek(6.2);
check('the offset survives a reload (6.2s still shows First)', await untilActive(/First lyric line/), await activeText());
check('the offset label reads +0.5s after reload', ((await view.locator('[data-offset]').textContent()) || '').trim() === '+0.5s');
await minusBtn.click(); // back to 0 for the download test

// download menu
const menuBtn = view.locator('button[aria-haspopup="menu"]');
await menuBtn.click();
check('download menu offers Auto / LRC / TTML / Plain text', (await view.locator('[role=menuitem]').allTextContents()).map((s) => s.trim()).join('|') === 'Auto|LRC|TTML|Plain text');
const dl = async (label) => {
  if (!(await view.locator('[role=menu]').count())) await menuBtn.click();
  const [d] = await Promise.all([page.waitForEvent('download', { timeout: 8000 }), view.locator(`[role=menuitem]:text-is("${label}")`).click()]);
  return { name: d.suggestedFilename(), text: readFileSync(await d.path(), 'utf8') };
};
const lrcFile = await dl('LRC');
const lrcLines = lrcFile.text.split('\n').filter((l) => /^\[\d\d:\d\d\.\d\d\]/.test(l));
check('LRC download matches the generator (header, timestamps, text)',
  lrcFile.name.endsWith('.lrc') && /\[ti:.+\]/.test(lrcFile.text) && /\[re:LRCLIB\]/.test(lrcFile.text)
  && lrcLines.join('|') === '[00:02.00]First lyric line|[00:06.00]Second lyric line|[00:10.00]Third lyric line|[00:14.00]Fourth lyric line|[00:26.00]Fifth lyric line|[00:27.50]Sixth lyric line', lrcFile.name);
const ttmlFile = await dl('TTML');
check('TTML download is a TTML document with the same lines',
  ttmlFile.name.endsWith('.ttml') && ttmlFile.text.startsWith('<?xml') && ttmlFile.text.includes('<span begin="00:00:02.000" end="00:00:06.000">First lyric line</span>') && ttmlFile.text.includes('Sixth lyric line'));
const plainFile = await dl('Plain text');
check('plain download is the bare text', plainFile.name.endsWith('.txt') && plainFile.text === 'First lyric line\nSecond lyric line\nThird lyric line\nFourth lyric line\nFifth lyric line\nSixth lyric line');
if (await view.locator('[role=menu]').count()) await page.keyboard.press('Escape');
await menuBtn.click();
await page.keyboard.press('Escape');
check('Escape closes the download menu but not the panel', (await view.locator('[role=menu]').count()) === 0 && (await page.locator('[role=dialog] h2:text-is("Lyrics")').count()) === 1);

// ── scenario 2: owner file wins over every provider; word sync + duet + background ──
const T7 = uniq[7];
calls.length = 0;
await playTrack(T7, { lrclib: { syncedLyrics: LRC }, owner: { [`${T7.id}.ttml`]: TTML } });
await view.locator('li[data-row]').first().waitFor({ timeout: 10000 }).catch(() => {});
check('an owner file in /assets/music/lyrics wins over every provider', /Source:\s*Fiesta/.test(await sourceText()), await sourceText());
check('the provider cascade never asked a remote provider for it', !calls.some((c) => c.startsWith('lrclib.net') || c.startsWith('lrc.red')), calls.join(' '));
await seek(3.5);
await untilActive(/Hello wide world/);
const sylStyle = await view.locator('[aria-current="true"] span[style*="--p"]').evaluateAll((els) => els.map((e) => ({ t: e.textContent, p: parseFloat(e.style.getPropertyValue('--p')) })));
check('karaoke: syllables of the active line carry a --p progress (done, half, not yet)', sylStyle.length === 3 && sylStyle[0].p === 100 && sylStyle[1].p > 20 && sylStyle[1].p < 80 && sylStyle[2].p === 0, JSON.stringify(sylStyle));
await seek(10.5);
await untilActive(/Other singer/);
const duet = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('app-music-lyrics-view li[data-row]')];
  return rows.map((r) => ({ end: r.classList.contains('justify-end'), text: r.textContent.trim().slice(0, 12) }));
});
check('duet: the second singer sits on the right, the first on the left', duet.length >= 3 && duet[0].end === false && duet[1].end === true, JSON.stringify(duet));
check('a background vocal renders as its own dimmer line', (await view.locator('li[data-row]', { hasText: 'ooh' }).count()) === 1);
if (shots) await page.screenshot({ path: `${shots}/p3-karaoke.png` });

// ── scenario 3: plain (unsynced) lyrics ─────────────────────────────────────
const T1 = uniq[1];
await playTrack(T1, { lrclib: { plainLyrics: 'Plain one\nPlain two\nPlain three' } });
await view.locator('li[data-row]').first().waitFor({ timeout: 10000 }).catch(() => {});
check('plain lyrics render without highlighting or seek buttons', (await view.locator('li[data-row]').count()) === 3 && (await view.locator('[aria-current="true"]').count()) === 0 && (await view.locator('li[data-row] button').count()) === 0);
check('plain lyrics say they are not synced and name the source', (await view.textContent()).includes('not time-synced') && /LRCLIB \(unsynced\)/.test(await sourceText()));

// ── scenario 4: nothing found ───────────────────────────────────────────────
await playTrack(uniq[2], {});
await view.locator('text=No lyrics found').waitFor({ timeout: 15000 }).catch(() => {});
const tried = ((await view.locator('text=Tried:').textContent().catch(() => '')) || '');
check("no lyrics: 'No lyrics found' with the sources that were tried", (await view.locator('text=No lyrics found').count()) === 1 && /lrc\.red/.test(tried) && /LRCLIB/.test(tried), tried.trim());

// ── scenario 5: network failure, amber text and Retry ───────────────────────
const T3 = uniq[3];
await playTrack(T3, { down: true });
const errBox = view.locator('p.text-amber-400');
await errBox.waitFor({ timeout: 20000 }).catch(() => {});
check('network failure shows amber text', (await errBox.count()) === 1 && /Couldn't load lyrics/.test(await errBox.textContent()));
S = { lrclib: { syncedLyrics: LRC } };
await view.locator('button:text-is("Retry")').click();
await view.locator('li[data-row]').first().waitFor({ timeout: 15000 }).catch(() => {});
check('Retry loads the lyrics once the network is back', (await view.locator('li[data-row]').count()) === 6);

// ── scenario 6: Switch source cycles through the available sources ──────────
const T4 = uniq[4];
await playTrack(T4, { unison: LRC.replace('First lyric line', 'Unison first'), lrclib: { syncedLyrics: LRC } });
await view.locator('li[data-row]').first().waitFor({ timeout: 15000 }).catch(() => {});
check('first source is Unison (line synced; LRCLIB not asked yet)', /Source:\s*Unison/.test(await sourceText()), await sourceText());
const sw = view.locator('button:text-is("Switch source")');
await sw.click();
await view.locator('[data-source]:has-text("LRCLIB")').waitFor({ timeout: 15000 }).catch(() => {});
check("'Switch source' moves to another available source (LRCLIB)", /Source:\s*LRCLIB/.test(await sourceText()) && (await view.locator('li[data-row]', { hasText: 'First lyric line' }).count()) === 1, await sourceText());
await sw.click();
await view.locator('[data-source]:has-text("Unison")').waitFor({ timeout: 8000 }).catch(() => {});
check("'Switch source' cycles back around (Unison)", /Source:\s*Unison/.test(await sourceText()), await sourceText());

// ── scenario 7: romanize + translate through Google (mocked), and failures ──
const T5 = uniq[5];
await playTrack(T5, { lrclib: { syncedLyrics: CYRILLIC } });
await view.locator('li[data-row]').first().waitFor({ timeout: 15000 }).catch(() => {});
await view.locator('button:text-is("Romanize")').click();
await view.locator('[data-extra=romanized]').first().waitFor({ timeout: 8000 }).catch(() => {});
check('Romanize adds a line under each lyric (translate.googleapis.com dt=rm)', (await view.locator('[data-extra=romanized]').count()) === 3 && /^rom:Привет мир/.test((await view.locator('[data-extra=romanized]').first().textContent()).trim()) && calls.some((c) => c.includes('translate.googleapis.com') && c.includes('dt=rm')));
await view.locator('select[aria-label="Translate to"]').selectOption('es');
await view.locator('button:text-is("Translate")').click();
await view.locator('[data-extra=translation]').first().waitFor({ timeout: 8000 }).catch(() => {});
check('Translate adds the translation in the chosen language (dt=t&tl=es)', (await view.locator('[data-extra=translation]').count()) === 3 && /^tr-es:Привет мир/.test((await view.locator('[data-extra=translation]').first().textContent()).trim()) && calls.some((c) => c.includes('tl=es') && c.includes('dt=t')));
check('the original lyrics stay on screen next to the extras', (await view.locator('li[data-row]', { hasText: 'Привет мир' }).count()) === 1);
S = { lrclib: { syncedLyrics: CYRILLIC }, google: 'fail' };
await view.locator('select[aria-label="Translate to"]').selectOption('de');
await page.locator('text=/Couldn.t translate the lyrics/').first().waitFor({ timeout: 12000 }).catch(() => {});
check('a translation failure toasts and leaves the lyrics intact', (await page.locator('text=/Couldn.t translate the lyrics/').count()) >= 1 && (await view.locator('li[data-row]').count()) === 3 && (await view.locator('button:text-is("Translate")').getAttribute('aria-pressed')) === 'false');

// ── scenario 8: RTL (Romanize is still on from the last scenario, and Google is down now) ──
await playTrack(uniq[6], { lrclib: { syncedLyrics: ARABIC }, google: 'fail' });
await view.locator('li[data-row]').first().waitFor({ timeout: 15000 }).catch(() => {});
check("right-to-left lyrics render with dir='rtl'", (await view.locator('li[data-row] button[dir="rtl"]').count()) === 2);
await page.locator('text=/Couldn.t romanize the lyrics/').first().waitFor({ timeout: 12000 }).catch(() => {});
check('a romanization failure toasts and leaves the lyrics intact', (await page.locator('text=/Couldn.t romanize the lyrics/').count()) >= 1 && (await view.locator('li[data-row]').count()) === 2 && (await view.locator('button:text-is("Romanize")').getAttribute('aria-pressed')) === 'false');

// ── settings section ────────────────────────────────────────────────────────
await page.evaluate(() => window.__music.ui.closePanel());
await page.goto(base + '/music/settings?tab=lyrics&musicdebug=1', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('app-music-settings-lyrics', { timeout: 15000 });
const sec = page.locator('app-music-settings-lyrics');
check('Settings > Lyrics lists the providers', (await sec.locator('input[name^="lyrics-provider-"]').count()) === 6);
await sec.locator('input[name="lyrics-provider-genius"]').uncheck();
await sec.locator('input[name="lyrics-blur"]').uncheck();
await sec.locator('input[name="lyrics-hide-played"]').check();
await sec.locator('input[name="lyrics-karaoke"]').uncheck();
await sec.locator('input[name="lyrics-romanize"]').check();
await sec.locator('input[name="lyrics-translate"]').check();
await sec.locator('select[name="lyrics-target-language"]').selectOption('fr');
await page.waitForTimeout(300);
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('app-music-settings-lyrics', { timeout: 15000 });
const st = await page.evaluate(() => JSON.parse(localStorage.getItem('fiesta:music:lyrics') || '{}'));
const again = page.locator('app-music-settings-lyrics');
check('Settings > Lyrics values persist across a reload',
  st.providers?.genius === false && st.blur === false && st.hidePlayed === true && st.karaoke === false && st.romanize === true && st.translate === true && st.targetLang === 'fr'
  && !(await again.locator('input[name="lyrics-provider-genius"]').isChecked()) && !(await again.locator('input[name="lyrics-blur"]').isChecked())
  && (await again.locator('input[name="lyrics-hide-played"]').isChecked()) && (await again.locator('select[name="lyrics-target-language"]').inputValue()) === 'fr', JSON.stringify(st));
if (shots) await page.screenshot({ path: `${shots}/p3-settings.png`, fullPage: true });

// a disabled provider is not asked, and defaults seed the footer toggles
S = { lrclib: { syncedLyrics: LRC } };
calls.length = 0;
await page.goto(base + '/music?musicdebug=1', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.__music, null, { timeout: 20000 });
await playTrack({ ...uniq[9 % uniq.length] }, { lrclib: { syncedLyrics: LRC } });
await page.evaluate(() => window.__music.ui.openPanel('lyrics'));
await view.locator('li[data-row]').first().waitFor({ timeout: 15000 }).catch(() => {});
check('a provider switched off in settings is never asked (Genius)', !calls.some((c) => c.startsWith('fetch-genius')));
check('Romanize/Translate defaults from settings are on in the footer', (await view.locator('button:text-is("Romanize")').getAttribute('aria-pressed')) === 'true' && (await view.locator('button:text-is("Translate")').getAttribute('aria-pressed')) === 'true' && (await view.locator('select[aria-label="Translate to"]').inputValue()) === 'fr');
check('"Hide played lines" and blur-off from settings take effect (no filter, played lines faded)', await (async () => {
  await seek(12);
  await untilActive(/Third/);
  await wait(600);
  return page.evaluate(() => {
    const rows = [...document.querySelectorAll('app-music-lyrics-view li[data-row] button')];
    return rows.every((b) => !b.style.filter) && rows[0].classList.contains('opacity-0');
  });
})());

check('no uncaught page errors', errors.length === 0, errors.slice(0, 2).join(' | '));

await browser.close();
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
