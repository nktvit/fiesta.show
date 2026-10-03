// Settings > "Subtitle sync" checkbox + the 0.9x control scale.
// node subsync-menu.mjs <baseUrl> [--shots=dir] [--browser=chrome|webkit|firefox]
import { chromium, webkit, firefox } from 'playwright';
const args = process.argv.slice(2);
const base = args.find((a) => !a.startsWith('--'));
const opt = Object.fromEntries(args.filter((a) => a.startsWith('--')).map((a) => a.slice(2).split('=')));
const kind = opt.browser || 'chrome';
const b = await { chrome: chromium, webkit, firefox }[kind].launch(kind === 'chrome' ? { channel: 'chrome', args: ['--autoplay-policy=no-user-gesture-required'] } : {});
const page = await b.newPage({ viewport: { width: 1920, height: 1080 } });
const results = [];
const check = async (name, fn) => { try { const r = await fn(); results.push([name, r === true ? 'ok' : r]); } catch (e) { results.push([name, 'FAIL ' + e.message.split('\n')[0]]); } };
const open = async () => {
  // 'load', not 'domcontentloaded': on a same-URL reload Firefox keeps the old
  // document around, and the checks below would run against it
  await page.goto(`${base}/movie/tt0903747?s=1&e=1&play=1&hlsdebug=1`, { waitUntil: 'load' });
  await page.locator('#player').waitFor({ timeout: 60_000 });
  await page.waitForFunction(() => document.querySelector('video')?.currentSrc, null, { timeout: 60_000 });
  await page.waitForTimeout(1500);
  const start = page.locator('button[aria-label="Play"], button:has-text("Continue from")').first();
  if (await start.isVisible().catch(() => false)) await start.click();
  await page.waitForFunction(() => { const v = document.querySelector('video'); return v && v.currentTime > 0.5; }, null, { timeout: 60_000 });
  await page.evaluate(() => { document.querySelector('video').muted = true; });
};
const wake = async () => {
  const box = await page.locator('#player').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height - 30, { steps: 5 });
  await page.waitForTimeout(400);
};
const openSettings = async () => { await wake(); const s = page.getByRole('button', { name: 'Settings' }); await s.hover(); await s.click(); await page.waitForTimeout(300); };
const item = () => page.getByRole('menuitemcheckbox', { name: 'Subtitle sync' });

await open();
// The real controls live in the skin's shadow DOM: measure the control size there.
await check('controls 0.9x (36px -> 32.4px)', async () => {
  const px = await page.evaluate(() => {
    const inner = document.querySelector('video-skin').shadowRoot.querySelector('media-container');
    const probe = document.createElement('div');
    probe.style.width = 'var(--media-control-size)';
    inner.appendChild(probe); const w = probe.getBoundingClientRect().width; probe.remove(); return w;
  });
  return Math.abs(px - 32.4) < 0.2 || `control ${px}px`;
});
await check('menu item checked by default', async () => {
  await openSettings();
  if (opt.shots) await page.locator('#player').screenshot({ path: `${opt.shots}/menu-${kind}.png` });
  const c = await item().getAttribute('aria-checked');
  return c === 'true' || `aria-checked ${c}`;
});
await check('pick English, cues present', async () => {
  await page.keyboard.press('Escape');
  const label = await page.evaluate(() => { const t = [...document.querySelector('video').textTracks].find((x) => x.language === 'en' && x.label === 'English') || [...document.querySelector('video').textTracks].find((x) => x.language === 'en'); t.mode = 'showing'; return t.label; });
  await page.waitForFunction(() => [...document.querySelector('video').textTracks].some((t) => t.mode === 'showing' && t.cues?.length), null, { timeout: 20_000 });
  return !!label;
});
await check('uncheck -> off and saved', async () => {
  await openSettings();
  await item().click();
  await page.waitForTimeout(300);
  const c = await item().getAttribute('aria-checked');
  const stored = await page.evaluate(() => localStorage.getItem('fiesta:subsync'));
  return (c === 'false' && stored === '0') || `aria ${c} stored ${stored}`;
});
await check('recheck -> on and saved', async () => {
  await item().click();
  await page.waitForTimeout(300);
  const c = await item().getAttribute('aria-checked');
  const stored = await page.evaluate(() => localStorage.getItem('fiesta:subsync'));
  return (c === 'true' && stored === '1') || `aria ${c} stored ${stored}`;
});
await check('off survives reload', async () => {
  await item().click();
  await page.keyboard.press('Escape');
  await open();
  await openSettings();
  const c = await item().getAttribute('aria-checked');
  return c === 'false' || `aria ${c}`;
});
await check('fullscreen 1920px: 0.9 x 1.75 -> 56.7px', async () => {
  await page.keyboard.press('Escape');
  await page.evaluate(() => { localStorage.setItem('fiesta:subsync', '1'); });
  await wake();
  await page.getByRole('button', { name: /fullscreen/i }).first().click();
  await page.waitForTimeout(1500);
  const px = await page.evaluate(() => {
    const root = document.querySelector('video-skin').shadowRoot;
    const inner = root.fullscreenElement || document.fullscreenElement;
    if (!inner) return 'not fullscreen';
    const probe = document.createElement('div');
    probe.style.width = 'var(--media-control-size)';
    inner.appendChild(probe); const w = probe.getBoundingClientRect().width; probe.remove(); return w;
  });
  return (typeof px === 'number' && Math.abs(px - 56.7) < 0.3) || `control ${px}px`;
});
for (const [n, r] of results) console.log((r === 'ok' ? 'ok   ' : 'FAIL ') + n + (r === 'ok' ? '' : '  -> ' + r));
await b.close();
