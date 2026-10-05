// E2E for the artist page glass theme: the `artist-images` action, per-artist theme
// variables, glass panels, reduced motion, overflow, text contrast, gallery lightbox,
// graceful fallback.
//   node tools/e2e/music-artist-glass.mjs [baseUrl=http://localhost:4219] [--api=http://localhost:3999]
//        [--shots=dir] [--browsers=chromium,webkit]
// Needs `ng serve --port 4219` and `PORT=3999 node tools/fiesta-proxy/local-test-server.mjs`
// (src/proxy.conf.json sends /api/music to :3999) and playwright-core on NODE_PATH.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let pw;
try { pw = require('playwright-core'); } catch { pw = require('playwright'); }

const base = process.argv.find((a) => a.startsWith('http')) || 'http://localhost:4219';
const api = (process.argv.find((a) => a.startsWith('--api=')) || '--api=http://localhost:3999').slice(6);
const shots = (process.argv.find((a) => a.startsWith('--shots=')) || '').slice(8);
const browserNames = ((process.argv.find((a) => a.startsWith('--browsers=')) || '--browsers=chromium,webkit').slice(11)).split(',');
const results = [];
const check = (name, ok, extra = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };

const ARTISTS = [
  { name: 'Daft Punk', id: 8847 },
  { name: 'Radiohead', id: 64518 },
  { name: 'Splin (Russian)', id: 5133827 },
];
const ALLOWED = /^https:\/\/(resources\.tidal\.com|image\.tidal\.com|cdn-images\.dzcdn\.net|e-cdns-images\.dzcdn\.net|upload\.wikimedia\.org|assets\.fanart\.tv)\//;

// ---- Backend --------------------------------------------------------------------------------
async function get(q) {
  const r = await fetch(`${api}/api/music?${q}`);
  let body = null; try { body = await r.json(); } catch { /* not json */ }
  return { status: r.status, cc: r.headers.get('cache-control') || '', body, type: r.headers.get('content-type') || '' };
}
for (const a of ARTISTS) {
  const r = await get(`action=artist-images&id=${a.id}`);
  const list = (r.body && r.body.images) || [];
  const sources = [...new Set(list.map((i) => i.source))].join('+');
  check(`api artist-images ${a.name}: 200, >= 2 distinct images`, r.status === 200 && list.length >= 2 && new Set(list.map((i) => i.url.split('?')[0])).size === list.length, `${list.length} (${sources})`);
  check(`api artist-images ${a.name}: <= 8, shape, https allow-listed hosts`, list.length <= 8 && list.every((i) => ALLOWED.test(i.url) && i.w > 0 && i.h > 0 && ['photo', 'cover'].includes(i.kind) && !!i.source));
  check(`api artist-images ${a.name}: long s-maxage`, /s-maxage=(\d+)/.test(r.cc) && Number(/s-maxage=(\d+)/.exec(r.cc)[1]) >= 86400, r.cc);
  const wiki = list.filter((i) => i.source === 'wikimedia');
  check(`api artist-images ${a.name}: every Wikimedia image carries credit + licence`, wiki.every((i) => /,\s*(CC|Public domain|PD)/i.test(i.credit || '')), `${wiki.length} wikimedia`);
}
{
  const r = await get('action=artist-images&id=999999999');
  check('api artist-images unknown artist: 200 and [] (soft failure)', r.status === 200 && Array.isArray(r.body.images), `${r.status} ${JSON.stringify(r.body).slice(0, 40)}`);
  check('api artist-images bad id -> 400', (await get('action=artist-images&id=abc')).status === 400);
  const b64 = (u) => Buffer.from(u).toString('base64url');
  const dz = (await get('action=artist-images&id=8847')).body.images.find((i) => i.source === 'deezer');
  const wk = (await get('action=artist-images&id=8847')).body.images.find((i) => i.source === 'wikimedia');
  for (const [label, im] of [['deezer', dz], ['wikimedia', wk]]) {
    const r2 = await fetch(`${api}/api/music?action=img&u=${b64(im.url)}`);
    check(`img proxy serves ${label} (CORS, image/*)`, r2.status === 200 && /^image\//.test(r2.headers.get('content-type') || '') && r2.headers.get('access-control-allow-origin') === '*', `${r2.status}`);
  }
  check('img proxy still refuses other hosts', (await fetch(`${api}/api/music?action=img&u=${b64('https://example.com/a.jpg')}`)).status === 400);
}

// ---- Browser helpers ------------------------------------------------------------------------
const lum = (r, g, b) => { const f = (c) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
const ratio = (a, b) => { const [x, y] = a > b ? [a, b] : [b, a]; return (x + 0.05) / (y + 0.05); };
const parseRgb = (s) => (s.match(/[\d.]+/g) || []).map(Number);

async function openArtist(page, id, { waitImages = true } = {}) {
  await page.goto(`${base}/music/artist/${id}`);
  await page.waitForSelector('[data-glass-panel]', { timeout: 30000 });
  // Theme (palette) and the sharp portrait.
  await page.waitForFunction(() => /--ag-accent/.test(document.querySelector('[data-artist-theme]')?.getAttribute('style') || ''), null, { timeout: 30000 });
  if (waitImages) {
    await page.waitForFunction(() => { const i = document.querySelector('[data-artist-portrait]'); return !i || (i.complete && i.naturalWidth > 0); }, null, { timeout: 30000 });
    await page.waitForSelector('[data-artist-gallery]', { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(1500);
  }
}
const themeOf = (page) => page.evaluate(() => {
  const s = getComputedStyle(document.querySelector('[data-artist-theme]'));
  return { accent: s.getPropertyValue('--ag-accent').trim(), deep: s.getPropertyValue('--ag-deep').trim(), secondary: s.getPropertyValue('--ag-secondary').trim() };
});

/** Contrast of the main texts against the rendered pixels behind them (text made transparent). */
async function textContrast(page) {
  const targets = await page.evaluate(() => {
    const pick = (label, sel, nth = 0) => { const el = [...document.querySelectorAll(sel)][nth]; return el ? { label, el } : null; };
    const list = [
      pick('hero name', 'h1'),
      pick('hero label', '[data-artist-theme] p.uppercase'),
      pick('Popular heading', 'section[aria-label="Popular songs"] h2'),
      pick('track title', 'section[aria-label="Popular songs"] app-music-track-row p.text-sm.font-medium'),
      pick('track artist', 'section[aria-label="Popular songs"] app-music-track-row p.text-xs'),
      pick('bio text', 'app-music-artist-bio p.text-sm'),
      pick('link chip', 'app-music-artist-bio ul[aria-label="Artist links"] a'),
      pick('Show all', 'section[aria-label="Popular songs"] button.rounded-full'),
      pick('filter pill (inactive)', 'section[aria-label="Discography"] [role="group"] button[aria-pressed="false"]'),
      pick('filter pill (active)', 'section[aria-label="Discography"] [role="group"] button[aria-pressed="true"]'),
      pick('Play button', '[data-artist-play]'),
      pick('Shuffle button', 'button.backdrop-blur-md.rounded-full'),
      pick('album title', 'section[aria-label="Discography"] app-music-album-card p'),
    ].filter(Boolean);
    return list.map(({ label, el }) => {
      // The element's own text colour; the text node box is what sits on the background.
      const range = document.createRange(); range.selectNodeContents(el);
      const rects = [...range.getClientRects()].filter((r) => r.width > 2 && r.height > 2);
      const cs = getComputedStyle(el);
      el.setAttribute('data-ct', label);
      return { label, color: cs.color, rects: rects.map((r) => ({ x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height })) };
    });
  });
  await page.addStyleTag({ content: '[data-artist-theme] * { color: transparent !important; text-shadow: none !important; } [data-artist-theme] svg { visibility: hidden !important; }' });
  await page.waitForTimeout(900);
  const out = [];
  for (const t of targets) {
    if (!t.rects.length) continue;
    const r = t.rects[0];
    const box = { x: Math.max(0, Math.floor(r.x)), y: Math.floor(r.y), width: Math.max(2, Math.ceil(r.w)), height: Math.max(2, Math.ceil(r.h)) };
    await page.evaluate((y) => window.scrollTo(0, Math.max(0, y - 300)), box.y);
    await page.waitForTimeout(150);
    const vy = await page.evaluate(() => scrollY);
    const buf = await page.screenshot({ clip: { x: box.x, y: box.y, width: box.width, height: box.height }, fullPage: true });
    const b64 = buf.toString('base64');
    const bg = await page.evaluate(async (data) => {
      const img = new Image(); img.src = 'data:image/png;base64,' + data; await img.decode();
      const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
      const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0);
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      const px = [];
      for (let i = 0; i < d.length; i += 4) px.push([d[i], d[i + 1], d[i + 2]]);
      return px;
    }, b64);
    void vy;
    const col = parseRgb(t.color);
    const tl = lum(col[0], col[1], col[2]);
    // Worst case: the pixel whose luminance is closest to the text's.
    let worst = Infinity;
    for (const p of bg) worst = Math.min(worst, ratio(tl, lum(p[0], p[1], p[2])));
    out.push({ label: t.label, ratio: worst, color: t.color });
  }
  return out;
}

async function suite(name, launcher) {
  const browser = await launcher.launch();
  const sfx = `[${name}]`;
  try {
    // ---- Theme per artist, glass, gallery, contrast at desktop width ----
    const themes = [];
    for (const a of ARTISTS) {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      const page = await ctx.newPage();
      await openArtist(page, a.id);
      const t = await themeOf(page);
      themes.push(t);
      check(`${sfx} ${a.name}: theme variables set`, /^#[0-9a-f]{6}$/.test(t.accent) && /^#[0-9a-f]{6}$/.test(t.deep), `${t.accent} ${t.deep}`);

      const glass = await page.evaluate(() => [...document.querySelectorAll('[data-glass-panel]')].map((el) => { const s = getComputedStyle(el); return { bf: s.backdropFilter || s.webkitBackdropFilter || '', wbf: s.getPropertyValue('-webkit-backdrop-filter'), border: s.borderTopWidth + ' ' + s.borderTopColor, radius: s.borderTopLeftRadius }; }));
      check(`${sfx} ${a.name}: >= 4 glass panels, each with backdrop blur, 1px border, rounded-2xl`, glass.length >= 4 && glass.every((g) => /blur/.test(g.bf || g.wbf) && g.border.startsWith('1px') && g.radius === '16px'), `${glass.length} panels, ${glass[0]?.bf}`);
      if (name === 'webkit') check(`${sfx} ${a.name}: -webkit-backdrop-filter in effect`, glass.every((g) => /blur/.test(g.wbf || g.bf)), glass[0]?.wbf);

      const anim = await page.evaluate(() => { const i = document.querySelector('[data-backdrop-layer]'); return i ? { name: getComputedStyle(i).animationName, filter: getComputedStyle(i).filter } : null; });
      check(`${sfx} ${a.name}: blurred backdrop with Ken-Burns drift animation`, !!anim && anim.name === 'ag-drift' && /blur/.test(anim.filter), JSON.stringify(anim));

      const play = await page.evaluate(() => getComputedStyle(document.querySelector('[data-artist-play]')).backgroundColor);
      check(`${sfx} ${a.name}: Play button uses the accent (not the indigo fallback)`, play !== 'rgb(79, 70, 229)', play);

      const g = await page.evaluate(() => ({ tiles: document.querySelectorAll('[data-gallery-tile]').length, credit: !!document.querySelector('[data-gallery-credits]'), scrollers: [...document.querySelectorAll('[data-artist-gallery] *')].filter((e) => /(auto|scroll)/.test(getComputedStyle(e).overflowX) && e.scrollWidth > e.clientWidth + 1).length }));
      check(`${sfx} ${a.name}: gallery of >= 2 tiles that wraps (no horizontal scroller)`, g.tiles >= 2 && g.scrollers === 0, `${g.tiles} tiles, credits ${g.credit}`);

      if (a.id === 8847) {
        // Lightbox: opens in the dialog shell with a credit, arrow keys step, Escape closes and returns focus.
        const tile = page.locator('[data-gallery-tile]').first();
        await tile.scrollIntoViewIfNeeded();
        await tile.focus();
        await page.keyboard.press('Enter'); // keyboard open: Safari does not focus buttons on click
        await page.waitForSelector('[role="dialog"] [data-lightbox-image]');
        const before = await page.locator('[data-lightbox-image]').getAttribute('src');
        check(`${sfx} lightbox opens with the image and a credit/licence line`, /(CC|Public domain|Image:)/.test(await page.locator('[data-lightbox-credit]').innerText()));
        await page.keyboard.press('ArrowRight');
        const after = await page.locator('[data-lightbox-image]').getAttribute('src');
        check(`${sfx} lightbox ArrowRight shows the next photo`, before !== after);
        await page.keyboard.press('Escape');
        await page.waitForSelector('[role="dialog"]', { state: 'detached' });
        check(`${sfx} Escape closes the lightbox and focus returns to the tile`, await page.evaluate(() => document.activeElement?.hasAttribute('data-gallery-tile')));
        await page.evaluate(() => window.scrollTo(0, 0));
      }

      // Existing features still there.
      const feat = await page.evaluate(() => ({
        pills: document.querySelectorAll('section[aria-label="Discography"] [role="group"] button').length,
        like: !!document.querySelector('app-music-like-button'),
        share: !!document.querySelector('button[aria-label="Share artist"]'),
        radio: [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Radio'),
        shuffle: [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Shuffle'),
        similar: !!document.querySelector('section[aria-label="Similar artists"]'),
        links: !!document.querySelector('ul[aria-label="Artist links"]'),
        title: document.title,
      }));
      check(`${sfx} ${a.name}: filters, like, share, radio, shuffle, similar artists, links, title all present`, feat.pills >= 1 && feat.like && feat.share && feat.radio && feat.shuffle && feat.similar && feat.links && /\| Stream Fiesta$/.test(feat.title), JSON.stringify(feat));

      if (shots) {
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.screenshot({ path: `${shots}/${name}-${a.id}-1280.png`, fullPage: true });
      }

      if (a.id !== 5133827) {
        const c = await textContrast(page);
        const bad = c.filter((x) => x.ratio < 4.5);
        console.log(`      ${sfx} ${a.name} contrast: ` + c.map((x) => `${x.label} ${x.ratio.toFixed(1)}`).join(', '));
        check(`${sfx} ${a.name}: main text >= 4.5:1 on the rendered themed backgrounds`, c.length >= 8 && bad.length === 0, bad.map((x) => `${x.label} ${x.ratio.toFixed(2)}`).join(', '));
      }
      await ctx.close();
    }
    check(`${sfx} theme differs per artist (accent and deep tint)`, new Set(themes.map((t) => t.accent)).size === 3 && new Set(themes.map((t) => t.deep)).size === 3, themes.map((t) => t.accent).join(' '));

    // ---- Mobile: no horizontal overflow, screenshots ----
    for (const w of [390, 360]) {
      for (const a of ARTISTS) {
        const ctx = await browser.newContext({ viewport: { width: w, height: 844 }, isMobile: false, hasTouch: true });
        const page = await ctx.newPage();
        await openArtist(page, a.id);
        const o = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth, body: document.body.scrollWidth }));
        check(`${sfx} ${a.name} @${w}: no horizontal overflow`, o.sw <= o.iw && o.body <= o.iw, `${o.sw}/${o.iw}`);
        if (w === 390) {
          const small = await page.evaluate(() => [...document.querySelectorAll('[data-artist-theme] button, [data-artist-theme] a[href]')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && (r.height < 39.5 || r.width < 39.5) && !e.closest('app-music-track-row') && !e.closest('app-music-album-card') && !e.closest('app-music-artist-card') && !e.hasAttribute('tabindex'); }).map((e) => (e.getAttribute('aria-label') || e.textContent.trim()).slice(0, 24) + ` ${Math.round(e.getBoundingClientRect().width)}x${Math.round(e.getBoundingClientRect().height)}`));
          check(`${sfx} ${a.name} @390: page-level touch targets >= 40px`, small.length === 0, small.join('; '));
        }
        if (shots) {
          await page.evaluate(() => window.scrollTo(0, 0));
          await page.screenshot({ path: `${shots}/${name}-${a.id}-${w}.png`, fullPage: true });
          if (w === 390) await page.screenshot({ path: `${shots}/${name}-${a.id}-390x844.png` });
        }
        await ctx.close();
      }
    }

    // ---- Reduced motion: backdrop is static ----
    {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' });
      const page = await ctx.newPage();
      await openArtist(page, 8847);
      const r = await page.evaluate(() => { const i = document.querySelector('[data-backdrop-layer]'); const s = i && getComputedStyle(i); return i ? { an: s.animationName, tr: s.transitionProperty } : null; });
      check(`${sfx} prefers-reduced-motion: backdrop animation off, no fade transition`, !!r && r.an === 'none' && r.tr === 'none', JSON.stringify(r));
      await page.waitForTimeout(10500);
      const n = await page.evaluate(() => document.querySelectorAll('[data-backdrop-layer]').length);
      check(`${sfx} prefers-reduced-motion: backdrop never rotates to a second picture`, n === 1, `${n} layer(s)`);
      await ctx.close();
    }

    // ---- Rotation with motion allowed: a second layer joins and fades in ----
    {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      const page = await ctx.newPage();
      await openArtist(page, 8847);
      let n = 0;
      for (let i = 0; i < 45 && n < 2; i++) { await page.waitForTimeout(1000); n = await page.evaluate(() => document.querySelectorAll('[data-backdrop-layer]').length); }
      check(`${sfx} backdrop cross-fades to a second picture (loaded only when its turn comes)`, n >= 2, `${n} layers`);
      await ctx.close();
    }

    // ---- Navigation artist -> artist: theme resets, no leaking ----
    {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      const page = await ctx.newPage();
      await openArtist(page, 8847);
      const first = await themeOf(page);
      await page.evaluate(() => {
        window.__samples = [];
        const el = document.querySelector('[data-artist-theme]');
        new MutationObserver(() => window.__samples.push(el.getAttribute('style') || '')).observe(el, { attributes: true, attributeFilter: ['style'] });
      });
      const card = page.locator('section[aria-label="Similar artists"] a[href^="/music/artist/"]').first();
      await card.scrollIntoViewIfNeeded();
      const nextName = await page.locator('section[aria-label="Similar artists"] app-music-artist-card').first().innerText();
      await card.click({ force: true });
      await page.waitForFunction((n) => !!document.querySelector('h1') && document.querySelector('h1').textContent.trim() !== 'Daft Punk' && /--ag-accent/.test(document.querySelector('[data-artist-theme]').getAttribute('style') || ''), nextName, { timeout: 30000 });
      const samples = await page.evaluate(() => window.__samples);
      const second = await themeOf(page);
      check(`${sfx} navigating artist -> artist clears the old theme first`, samples.some((s) => !/--ag-accent/.test(s)), `${samples.length} style updates`);
      check(`${sfx} after navigation the new artist's own theme is applied`, second.accent !== first.accent, `${first.accent} -> ${second.accent}`);
      check(`${sfx} no old-artist colour leaks after navigation`, !(await page.evaluate((old) => (document.querySelector('[data-artist-theme]').getAttribute('style') || '').includes(old), first.deep)));
      await ctx.close();
    }

    // ---- Graceful degradation: no images, no palette = the previous look ----
    {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      const page = await ctx.newPage();
      await page.route('**/api/music?action=artist-images*', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"images":[]}' }));
      await page.route('**/api/music?action=img*', (r) => r.fulfill({ status: 502, body: '{}' }));
      await page.goto(`${base}/music/artist/8847`);
      await page.waitForSelector('[data-glass-panel]', { timeout: 30000 });
      await page.waitForTimeout(2500);
      const d = await page.evaluate(() => ({
        style: document.querySelector('[data-artist-theme]').getAttribute('style') || '',
        play: getComputedStyle(document.querySelector('[data-artist-play]')).backgroundColor,
        backdrop: !!document.querySelector('[data-backdrop-layer]') && false,
        gallery: !!document.querySelector('[data-artist-gallery]'),
        panels: document.querySelectorAll('[data-glass-panel]').length,
      }));
      check(`${sfx} no images + no palette: indigo accent, no gallery, no theme variables, page still renders`, !/--ag-accent/.test(d.style) && d.play === 'rgb(79, 70, 229)' && !d.gallery && d.panels >= 3, `${d.play}`);
      await ctx.close();
    }

    // ---- Opaque fallbacks exist in the stylesheet ----
    {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      const page = await ctx.newPage();
      await openArtist(page, 8847, { waitImages: false });
      const css = await page.evaluate(() => { let t = ''; for (const s of document.styleSheets) { try { for (const r of s.cssRules) t += r.cssText.slice(0, 400) + '\n'; } catch { /* cross-origin */ } } return { supportsNot: /@supports not/.test(t) && /backdrop-filter/.test(t.split('@supports not').slice(1).join('')), reducedTransparency: /prefers-reduced-transparency/.test(t) }; });
      check(`${sfx} stylesheet has the @supports-not-backdrop-filter and prefers-reduced-transparency opaque fallbacks`, css.supportsNot && css.reducedTransparency, JSON.stringify(css));
      await ctx.close();
    }
  } finally {
    await browser.close();
  }
}

for (const n of browserNames) {
  console.log(`\n== ${n} ==`);
  await suite(n, pw[n]);
}
const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
