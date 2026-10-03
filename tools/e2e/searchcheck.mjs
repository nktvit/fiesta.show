// Search works when OMDB is out of quota (TMDB fallback): dropdown + results page.
// node searchcheck.mjs <baseUrl>
import { chromium } from 'playwright';
const base = process.argv[2];
const b = await chromium.launch({ channel: 'chrome' });
const page = await b.newPage({ viewport: { width: 1280, height: 900 } });
const out = [];
// dropdown: type, pick "Breaking Bad" (a TV show, TMDB id) -> movie page resolves its IMDb id
await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
const box = page.locator('input[type="search"], input[placeholder*="earch" i]').first();
await box.click();
await box.fill('breaking bad');
const opt = page.locator('text=Breaking Bad').first();
await opt.waitFor({ timeout: 15000 });
out.push(['dropdown shows results', true]);
await page.getByText('Breaking Bad', { exact: true }).first().click();
await page.waitForURL(/\/movie\//, { timeout: 15000 });
await page.waitForFunction(() => /Breaking Bad/i.test(document.title) || /Breaking Bad/.test(document.querySelector('h1')?.textContent || ''), null, { timeout: 30000 }).catch(() => {});
const h1 = await page.locator('h1').first().textContent().catch(() => '');
out.push(['suggestion opens the show', /Breaking Bad/.test(h1 || '') ? true : `url ${page.url()} h1 ${h1}`]);
// results page
await page.goto(base + '/search?query=matrix', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => document.querySelectorAll('img[src*="image.tmdb.org"], img[src*="m.media-amazon"]').length >= 5, null, { timeout: 30000 }).catch(() => {});
const n = await page.evaluate(() => document.querySelectorAll('img[src*="image.tmdb.org"], img[src*="m.media-amazon"]').length);
const count = await page.locator('text=/\\d[\\d,]* res/').first().textContent().catch(() => '');
out.push(['results page has posters', n >= 5 ? true : `${n} posters`]);
out.push(['result count shown', count ? true : 'no count']);
for (const [k, v] of out) console.log((v === true ? 'ok   ' : 'FAIL ') + k + (v === true ? '' : ' -> ' + v));
console.log('count text:', (count || '').trim(), '| landed on:', page.url().replace(base, ''));
await b.close();
