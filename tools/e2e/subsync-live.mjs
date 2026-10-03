// Live subtitle-sync trial: real stream, real subtitle file, the player's own
// buffered audio. Prints what utils/subsync.ts decides as playback runs.
//
// node subsync-live.mjs <baseUrl> <path> <seekTo> <watchS> [--label=English] [--rate=2] [--browser=chrome]
// e.g. node subsync-live.mjs http://localhost:4300 /movie/tt15398776 1800 240
import { chromium, webkit, firefox } from 'playwright';

const args = process.argv.slice(2);
const pos = args.filter((a) => !a.startsWith('--'));
const opt = Object.fromEntries(args.filter((a) => a.startsWith('--')).map((a) => a.slice(2).split('=')));
const [base, path, seekTo, watchS] = [pos[0], pos[1], +pos[2], +pos[3]];
const label = opt.label || 'English';
const rate = +(opt.rate || 2);
const kind = { chrome: chromium, webkit, firefox }[opt.browser || 'chrome'];

const browser = await kind.launch(opt.browser === 'chrome' || !opt.browser ? { channel: 'chrome', args: ['--autoplay-policy=no-user-gesture-required'] } : {});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('pageerror', e.message));
await page.goto(`${base}${path}${path.includes("?") ? "&" : "?"}play=1&subsync=1&hlsdebug=1`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => document.querySelector('video')?.currentSrc, null, { timeout: 60_000 });
await page.waitForTimeout(1500);
const start = page.locator('button[aria-label="Play"], button:has-text("Continue from")').first();
if (await start.isVisible().catch(() => false)) await start.click();
await page.waitForFunction(() => { const v = document.querySelector('video'); return v && !v.paused && v.currentTime > 0.5; }, null, { timeout: 60_000 });
await page.evaluate(({ seekTo, rate }) => { const v = document.querySelector('video'); v.muted = true; v.currentTime = seekTo; v.playbackRate = rate; }, { seekTo, rate });
await page.waitForTimeout(1500);
const picked = await page.evaluate((label) => {
  const ts = [...document.querySelector('video').textTracks];
  const t = ts.find((x) => x.label === label) || ts.find((x) => x.language === 'en');
  if (!t) return ts.map((x) => x.label);
  for (const x of ts) if (x !== t && x.mode === 'showing') x.mode = 'disabled';
  t.mode = 'showing';
  return t.label;
}, label);
console.log('track', picked);
// --seekAt=<wall s>:<media s> jumps once mid-run (does the line extrapolate?)
const [seekAtWall, seekAtMedia] = (opt.seekAt || '').split(':').map(Number);
let didSeek = false;
const t0 = Date.now();
let seen = 0;
while ((Date.now() - t0) / 1000 < watchS) {
  await page.waitForTimeout(10_000);
  const s = await page.evaluate(() => {
    const v = document.querySelector('video');
    const st = window.__fiestaSubsync;
    const tr = [...v.textTracks].find((t) => t.mode === 'showing');
    return { t: v.currentTime, rate: v.playbackRate, paused: v.paused, cues: tr?.cues?.length ?? 0, offset: st?.offset, a: st?.a, b: st?.b, locked: st?.locked, known: st?.known, tickMs: st?.tickMs, decodeMs: st?.decodeMs, chunks: st?.chunks, buf: [...Array(v.buffered.length).keys()].map((i) => `${v.buffered.start(i).toFixed(0)}-${v.buffered.end(i).toFixed(0)}`).join(','), log: st?.log ?? [] };
  });
  for (const l of s.log.slice(seen)) console.log(`   [t=${l.t}] ${l.action.padEnd(8)} est ${l.est} slope ${l.slope} ratio ${l.ratio}`);
  seen = s.log.length;
  console.log(`t=${s.t.toFixed(0)} shift=${s.offset} line a=${s.a} b=${s.b} locked=${s.locked} known=${s.known}s tickMs=${s.tickMs} decodeMs=${s.decodeMs} chunks=${s.chunks} buf=${s.buf} cues=${s.cues}${s.paused ? ' PAUSED' : ''}`);
  if (seekAtWall && !didSeek && (Date.now() - t0) / 1000 >= seekAtWall) {
    didSeek = true;
    console.log(`--- seek to ${seekAtMedia}`);
    await page.evaluate((t) => { document.querySelector('video').currentTime = t; }, seekAtMedia);
  }
  if (s.paused) await page.evaluate(() => document.querySelector('video').play().catch(() => {}));
}
await browser.close();
