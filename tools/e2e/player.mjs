// Player suite — the Video.js v10 skin around our own <video> + hls.js.
//
// Per browser, in a fresh context, against a deployment:
//   engine    hls.js drives playback (blob: src), not the browser's native HLS
//   play      click on the video and Space toggle play/pause
//   arrows    one ArrowRight / ArrowLeft press moves exactly ±10 s (not 20)
//   quality   the Settings menu lists the stream's levels (from our
//             videoRenditions shim); 720p pins hls.js, Auto releases it
//   speed     picking 1.5× sets playbackRate
//   captions  picking English shows a track with cues and saves the pref
//   native    the Native switch swaps to browser controls at the same position,
//             survives a reload, and the Fiesta switch swaps back
//   mobile    on a phone (390 and 360 wide) with the player open, the page has no
//             horizontal overflow and <main> is not a sideways-scrollable box
//   fallback  ?hls=native plays natively; with hls.js's requests blocked the
//             player falls back to native HLS (WebKit/Chromium only)
//
// Usage: node player.mjs [baseUrl] [--browsers=chrome,webkit,firefox] [--headed] [--shots=dir] [--proxy=socks5://…]
// (ESM ignores NODE_PATH: run from a dir whose node_modules has `playwright`.)

import { chromium, webkit, firefox } from 'playwright';

const args = process.argv.slice(2);
const base = (args.find((a) => !a.startsWith('--')) || 'https://fiesta.show').replace(/\/$/, '');
const browsers = ((args.find((a) => a.startsWith('--browsers=')) || '').slice(11) || 'chrome,webkit,firefox').split(',');
const shots = (args.find((a) => a.startsWith('--shots=')) || '').slice(8);
const proxy = (args.find((a) => a.startsWith('--proxy=')) || '').slice(8);
// --headed shows the browsers (useful when watching a failure happen).
const headless = !args.includes('--headed');
const TITLE = '/movie/tt0111161';

const LAUNCH = {
  chrome: () => chromium.launch({ channel: 'chrome', args: ['--autoplay-policy=no-user-gesture-required'], ...(proxy ? { proxy: { server: proxy } } : {}) }),
  webkit: () => webkit.launch({ headless, ...(proxy ? { proxy: { server: proxy } } : {}) }),
  firefox: () => firefox.launch({ headless, firefoxUserPrefs: { 'media.autoplay.default': 0 }, ...(proxy ? { proxy: { server: proxy } } : {}) }),
};

const videoState = () => {
  const v = document.querySelector('video');
  if (!v) {
    return {
      missing: true,
      url: location.pathname + location.search,
      player: !!document.getElementById('player'),
      text: (document.getElementById('player')?.innerText || document.body.innerText).replace(/\s+/g, ' ').slice(0, 100),
    };
  }
  const showing = [...v.textTracks].find((t) => t.mode === 'showing');
  return {
    engine: v.currentSrc.startsWith('blob:') ? 'hls.js' : v.currentSrc ? 'native' : 'none',
    t: v.currentTime,
    paused: v.paused,
    rate: v.playbackRate,
    controls: v.hasAttribute('controls'),
    skin: !!document.querySelector('video-skin'),
    size: `${v.videoWidth}x${v.videoHeight}`,
    showing: showing ? { label: showing.label, cues: showing.cues ? showing.cues.length : 0 } : null,
    // manualLevel is the viewer's pin (-1 = Auto); nextLevel is just the next fragment's level.
    hls: window.__hls ? { auto: window.__hls.autoLevelEnabled, manual: window.__hls.manualLevel } : null,
  };
};

async function openPlayer(page, query = '') {
  await page.goto(`${base}${TITLE}?play=1${query}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('video')?.currentSrc, null, { timeout: 45_000 });
  // ?play=1 autostarts where autoplay is allowed. Otherwise press the big Play
  // button, or "Continue from …" when a saved position brings up the resume prompt.
  await page.waitForTimeout(1500);
  const start = page.locator('button[aria-label="Play"], button:has-text("Continue from")').first();
  if (await start.isVisible().catch(() => false)) await start.click();
  await page.waitForFunction(() => { const v = document.querySelector('video'); return v && !v.paused && v.currentTime > 1; }, null, { timeout: 45_000 });
  await page.locator('#player').scrollIntoViewIfNeeded();
}

// The skin hides its bar after a moment without pointer movement, and a hidden
// bar lets clicks through to the <video>. Move like a viewer would, toward the
// bar, so it is showing before anything in it is clicked.
async function wakeControls(page) {
  // The video's own box, not #player's: #player also contains the Fiesta/Native
  // switch strip under the video, and hovering that wouldn't wake the controls.
  await page.locator('#player video').first().scrollIntoViewIfNeeded();
  const box = await page.locator('#player video').first().boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height - 30, { steps: 5 });
  // The bar fades in; it takes clicks once the skin marks it visible.
  await page.waitForFunction(() => {
    const controls = document.querySelector('video-skin')?.shadowRoot?.querySelector('media-controls');
    return !controls || controls.hasAttribute('data-visible');
  }, null, { timeout: 5_000 }).catch(() => {});
  await page.waitForTimeout(300);
}

// Open the skin's Settings menu and pick an item, entering its submenu
// ("Quality", "Speed", "Captions") first. Names match exactly: "720p" must not
// hit "Auto (720p)", nor "English" hit "English 2".
async function pickSetting(page, section, item) {
  await wakeControls(page);
  const settings = page.getByRole('button', { name: 'Settings' });
  await settings.hover();
  await settings.click();
  const target = page.getByRole('menuitemradio', { name: item, exact: true }).first();
  if (!(await target.isVisible().catch(() => false))) {
    await page.getByRole('menuitem', { name: new RegExp(section, 'i') }).first().click();
  }
  await target.click();
  await page.keyboard.press('Escape').catch(() => {});
}

async function seekDelta(page, key) {
  const before = (await page.evaluate(videoState)).t;
  await page.keyboard.press(key);
  await page.waitForTimeout(900);
  const after = (await page.evaluate(videoState)).t;
  return after - before;
}

async function run(name) {
  const res = { browser: name, checks: {}, notes: [] };
  const browser = await LAUNCH[name]();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => res.notes.push('pageerror: ' + e.message.slice(0, 140)));
  const check = async (key, fn) => {
    try {
      const out = await fn();
      // true / null (not applicable) pass; a string is a failure explanation.
      res.checks[key] = out === true || out === null ? out : false;
      if (typeof out === 'string') res.notes.push(`${key}: ${out}`);
    } catch (e) {
      res.checks[key] = false;
      res.notes.push(`${key}: ${String(e.message || e).split('\n')[0].slice(0, 160)}`);
    }
    if (res.checks[key] === false && shots) {
      await page.screenshot({ path: `${shots}/fail-${name}-${key}.png` }).catch(() => {});
    }
  };

  try {
    await openPlayer(page, '&hlsdebug=1'); // '=1': the router rewrites a bare flag and re-renders the page
    await check('engine', async () => (await page.evaluate(videoState)).engine === 'hls.js');
    if (shots) await page.locator('#player').screenshot({ path: `${shots}/10-${name}-player.png` });

    await check('play', async () => {
      await page.locator('#player').scrollIntoViewIfNeeded();
      const box = await page.locator('#player').boundingBox();
      await page.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.4);
      await page.waitForTimeout(600);
      const pausedByClick = (await page.evaluate(videoState)).paused;
      await page.keyboard.press('Space');
      await page.waitForTimeout(600);
      const playingBySpace = !(await page.evaluate(videoState)).paused;
      return (pausedByClick && playingBySpace) || `paused by click: ${pausedByClick}, playing after Space: ${playingBySpace}`;
    });

    await check('arrows', async () => {
      await page.mouse.click(5, 5); // focus the page, not a control
      const fwd = await seekDelta(page, 'ArrowRight');
      const back = await seekDelta(page, 'ArrowLeft');
      const ok = fwd > 8.5 && fwd < 12 && back < -8 && back > -12;
      return ok || `forward ${fwd.toFixed(1)} s, back ${back.toFixed(1)} s`;
    });

    await check('quality', async () => {
      await pickSetting(page, 'Quality', '720p');
      await page.waitForTimeout(300);
      const pinned = (await page.evaluate(videoState)).hls;
      await pickSetting(page, 'Quality', 'Auto');
      await page.waitForTimeout(300);
      const auto = (await page.evaluate(videoState)).hls;
      const ok = pinned && !pinned.auto && pinned.manual >= 0 && auto && auto.auto;
      return ok || `pinned ${JSON.stringify(pinned)} auto ${JSON.stringify(auto)}`;
    });

    await check('speed', async () => {
      await pickSetting(page, 'Speed', '1.5×');
      const rate = (await page.evaluate(videoState)).rate;
      await pickSetting(page, 'Speed', '1×');
      return rate === 1.5 || `rate ${rate}`;
    });

    await check('captions', async () => {
      await pickSetting(page, 'Captions', 'English');
      await page.waitForFunction(() => [...document.querySelector('video').textTracks].some((t) => t.mode === 'showing' && t.cues && t.cues.length > 0), null, { timeout: 20_000 });
      const pref = await page.evaluate(() => localStorage.getItem('fiesta:subtitle-pref'));
      if (shots) await page.locator('#player').screenshot({ path: `${shots}/11-${name}-captions.png` });
      return (pref && pref.includes('"en"')) || `pref ${pref}`;
    });

    await check('native', async () => {
      const before = (await page.evaluate(videoState)).t;
      await wakeControls(page);
      await page.getByRole('radio', { name: 'Native' }).click();
      await page.waitForFunction(() => { const v = document.querySelector('video'); return v && v.hasAttribute('controls') && v.readyState >= 2; }, null, { timeout: 30_000 });
      await page.waitForTimeout(1500);
      const native = await page.evaluate(videoState);
      if (shots) await page.locator('#player').screenshot({ path: `${shots}/12-${name}-native.png` });
      await page.reload({ waitUntil: 'domcontentloaded' });
      // The movie page renders in stages after a reload; wait for the player's
      // <video> to be attached, then read which UI it came back in.
      await page.waitForFunction(() => {
        const v = document.querySelector('#player video');
        return v && v.currentSrc && v.readyState >= 1;
      }, null, { timeout: 45_000 });
      await page.waitForTimeout(500);
      const remembered = await page.evaluate(videoState);
      await page.evaluate(() => localStorage.setItem('fiesta:player-ui', 'custom'));
      const drift = Math.abs(native.t - before);
      const ok = native.controls && !native.skin && native.engine === 'hls.js' && drift < 6 && remembered.controls && !remembered.skin;
      return ok || `native ${JSON.stringify(native)} drift ${drift.toFixed(1)} remembered ${JSON.stringify(remembered)}`;
    });

    await check('switchBack', async () => {
      await page.evaluate(() => localStorage.setItem('fiesta:player-ui', 'native'));
      await openPlayer(page);
      await wakeControls(page);
      await page.getByRole('radio', { name: 'Fiesta' }).click();
      await page.waitForFunction(() => !!document.querySelector('video-skin video'), null, { timeout: 30_000 });
      return (await page.evaluate(videoState)).skin;
    });

    await check('mobile', async () => {
      const fails = [];
      for (const width of [390, 360]) {
        const mctx = await browser.newContext({ viewport: { width, height: 800 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
        const mpage = await mctx.newPage();
        try {
          await openPlayer(mpage);
          const m = await mpage.evaluate(() => {
            const main = document.querySelector('main');
            main.scrollLeft = 30; // overflow-x:hidden still lets script and focus move it
            const moved = main.scrollLeft;
            main.scrollLeft = 0;
            return { iw: innerWidth, sw: document.documentElement.scrollWidth, moved };
          });
          if (m.sw > m.iw) fails.push(`${width}px: page ${m.sw}px wide`);
          if (m.moved) fails.push(`${width}px: <main> scrolls sideways`);
        } finally {
          await mctx.close();
        }
      }
      return fails.length === 0 || fails.join('; ');
    });

    if (name !== 'firefox') {
      await check('forcedNative', async () => {
        await openPlayer(page, '&hls=native');
        return (await page.evaluate(videoState)).engine === 'native';
      });
      await check('fallback', async () => {
        // Block only hls.js's own loads (fetch/xhr); the browser's native HLS
        // requests are resourceType 'media' and still pass.
        await page.route('**/relay.fiesta.show/**', (route) =>
          ['fetch', 'xhr'].includes(route.request().resourceType()) ? route.abort() : route.continue(),
        );
        await page.goto(`${base}${TITLE}?play=1`, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => { const v = document.querySelector('video'); return v && v.currentSrc && !v.currentSrc.startsWith('blob:'); }, null, { timeout: 90_000 });
        await page.unroute('**/relay.fiesta.show/**');
        return true;
      });
    } else {
      res.checks.forcedNative = null; // Firefox has no native HLS
      res.checks.fallback = null;
    }
  } catch (e) {
    res.notes.push('fatal: ' + String(e.message || e).split('\n')[0].slice(0, 200));
  } finally {
    await browser.close();
  }
  res.pass = Object.keys(res.checks).length >= 9 && Object.values(res.checks).every((v) => v === true || v === null);
  return res;
}

let failed = 0;
for (const name of browsers) {
  const r = await run(name);
  if (!r.pass) failed++;
  const mark = (v) => (v === true ? 'ok' : v === null ? '–' : 'FAIL');
  console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${name.padEnd(8)} ` + Object.entries(r.checks).map(([k, v]) => `${k}=${mark(v)}`).join(' '));
  if (r.notes.length) console.log('      ' + r.notes.join('\n      '));
}
process.exit(failed ? 1 : 0);
