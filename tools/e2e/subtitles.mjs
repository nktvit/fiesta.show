// Subtitle reliability suite — runs the real player against a deployment.
//
// For every title, in a FRESH browser context (no cue cache, no saved prefs):
//   list    /api/subs returned tracks (incl. English) and the player rendered a <track> each
//   cues    picking English, as a first-time viewer would, fills it with cues
//           within CUE_TIMEOUT_MS (subtitles are off until the first pick)
//   active  after seeking to 25% of the film, a cue is actually on screen
//   saved   after a reload, the remembered English choice comes back by itself
//   pick    switching to a non-English track (on-demand path) gets cues too
// and records how each subtitle file arrived: our proxy (/api/subs?file=) or
// the direct OpenSubtitles download fallback, with HTTP statuses.
//
// Usage (see README.md for the one-time playwright install):
//   node subtitles.mjs [baseUrl] [--only=tt123,...] [--json=out.json] [--proxy=socks5://host:port]
// (ESM ignores NODE_PATH: run from a dir whose node_modules has `playwright`.)
// Exit code is non-zero when any title fails a check.

import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const base = (args.find((a) => !a.startsWith('--')) || 'https://fiesta.show').replace(/\/$/, '');
const only = (args.find((a) => a.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean);
const jsonOut = (args.find((a) => a.startsWith('--json=')) || '').slice(7);
// e.g. --proxy=socks5://127.0.0.1:1080 (an `ssh -D 1080 mm` tunnel) to test
// from another IP once OpenSubtitles has CAPTCHA-walled this one.
const proxy = (args.find((a) => a.startsWith('--proxy=')) || '').slice(8);
// --block-proxy: every /api/subs?file= request answers 502, the way it does
// once Vercel's shared IPs are over OpenSubtitles' cap, to exercise the
// player's direct-download fallback on purpose.
const blockProxy = args.includes('--block-proxy');
const CUE_TIMEOUT_MS = 20_000;

// A spread of old/new, popular/obscure films and series episodes. LOTR and The
// Matrix are here on purpose: their general OpenSubtitles search holds no
// English SRT, which once left them with no English track at all.
const TITLES = [
  { id: 'tt0111161', name: 'Shawshank Redemption' },
  { id: 'tt0068646', name: 'The Godfather' },
  { id: 'tt1375666', name: 'Inception' },
  { id: 'tt0468569', name: 'The Dark Knight' },
  { id: 'tt0120737', name: 'LOTR: Fellowship' },
  { id: 'tt0133093', name: 'The Matrix' },
  { id: 'tt15398776', name: 'Oppenheimer' },
  { id: 'tt6791350', name: 'Guardians 3' },
  { id: 'tt9362722', name: 'Spider-Verse 2' },
  { id: 'tt0056172', name: 'Lawrence of Arabia' },
  { id: 'tt22022452', name: 'Inside Out 2' },
  { id: 'tt1517268', name: 'Barbie' },
  { id: 'tt0903747', name: 'Breaking Bad S1E1', tv: [1, 1] },
  { id: 'tt0903747', name: 'Breaking Bad S2E3', tv: [2, 3] },
  { id: 'tt0944947', name: 'Game of Thrones S1E1', tv: [1, 1] },
  { id: 'tt11280740', name: 'Severance S1E1', tv: [1, 1] },
].filter((t) => !only.length || only.includes(t.id));

function urlFor(t) {
  return t.tv
    ? `${base}/movie/${t.id}?type=tv&s=${t.tv[0]}&e=${t.tv[1]}&play=1`
    : `${base}/movie/${t.id}?play=1`;
}

// Snapshot of every text track on the page's <video>.
const tracksState = () =>
  [...(document.querySelector('video')?.textTracks || [])].map((tt) => ({
    lang: tt.language,
    label: tt.label,
    mode: tt.mode,
    cues: tt.cues ? tt.cues.length : 0,
    active: tt.activeCues && tt.activeCues[0] ? tt.activeCues[0].text.slice(0, 40) : null,
  }));

async function selectTrack(page, target) {
  await page.evaluate((o) => {
    for (const tt of document.querySelector('video').textTracks) {
      tt.mode = tt.language === o.lang && tt.label === o.label ? 'showing' : 'disabled';
    }
  }, target);
}

// Resolves to the showing track once it holds cues (optionally of `lang`), else null.
async function waitShowingCues(page, lang) {
  await page.waitForFunction(
    (l) => [...(document.querySelector('video')?.textTracks || [])].some(
      (tt) => tt.mode === 'showing' && (!l || tt.language === l) && tt.cues && tt.cues.length > 0,
    ),
    lang || null,
    { timeout: CUE_TIMEOUT_MS },
  ).catch(() => {});
  const s = (await page.evaluate(tracksState)).find((x) => x.mode === 'showing');
  return s && s.cues > 0 && (!lang || s.lang === lang) ? s : null;
}

async function runTitle(browser, t) {
  const r = { name: t.name, id: t.id, checks: {}, files: [], notes: [] };
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => r.notes.push('pageerror: ' + e.message.slice(0, 120)));
  if (blockProxy) {
    await page.route('**/api/subs?file=*', (route) =>
      route.fulfill({ status: 502, contentType: 'application/json', body: '{"error":"blocked by test"}' }),
    );
  }
  page.on('response', (res) => {
    const u = res.url();
    if (u.includes('/api/subs?file=')) r.files.push({ via: 'proxy', status: res.status() });
    else if (u.includes('dl.opensubtitles.org')) r.files.push({ via: 'direct', status: res.status() });
  });
  page.on('requestfailed', (req) => {
    if (req.url().includes('dl.opensubtitles.org')) r.files.push({ via: 'direct', status: 'failed: ' + req.failure()?.errorText });
  });

  try {
    const listRes = page.waitForResponse((res) => res.url().includes('/api/subs?') && !res.url().includes('file='), {
      timeout: 30_000,
    });
    await page.goto(urlFor(t), { waitUntil: 'domcontentloaded' });
    const list = await (await listRes).json().catch(() => ({}));
    const listed = (list.tracks || []).length;
    r.listed = listed;
    r.english = (list.tracks || []).filter((x) => x.lang === 'en').length;

    await page.waitForFunction((n) => (document.querySelector('video')?.textTracks.length || 0) >= n, listed, {
      timeout: 15_000,
    }).catch(() => {});
    let state = await page.evaluate(tracksState);
    if (state.length < listed) {
      r.notes.push(`player rendered ${state.length}/${listed} tracks; ` + JSON.stringify(await page.evaluate(() => ({
        video: !!document.querySelector('video'),
        text: document.body.innerText.replace(/\s+/g, ' ').slice(0, 160),
      }))));
    }
    r.checks.list = listed > 0 && r.english > 0 && state.length >= listed;

    // First-time viewer: nothing shows until a pick. Pick the first English
    // track through the TextTrack API, exactly what the native captions menu does.
    const en = state.find((s) => s.lang === 'en');
    if (en) await selectTrack(page, en);
    const showing = await waitShowingCues(page);
    r.showing = showing ? `${showing.label} (${showing.cues} cues)` : null;
    r.checks.cues = !!showing && showing.cues > 0;

    // Seek to 25% and confirm a cue is on screen. Dialogue gaps exist, so try
    // a few nearby points before failing. activeCues follows currentTime even
    // while paused, so this doesn't depend on playback actually running.
    if (r.checks.cues) {
      const dur = await page.waitForFunction(() => {
        const v = document.querySelector('video');
        return v && isFinite(v.duration) && v.duration > 0 ? v.duration : 0;
      }, null, { timeout: 30_000 }).then((h) => h.jsonValue()).catch(() => 0);
      const anchor = dur ? dur * 0.25 : 900;
      let active = null;
      for (const off of [0, 7, 19, 41, 83]) {
        // activeCues only update once the seek completes, which on a slow link
        // (or through a proxy) can take seconds: wait for `seeked`.
        await page.evaluate((x) => new Promise((resolve) => {
          const v = document.querySelector('video');
          const done = () => { clearTimeout(timer); resolve(); };
          const timer = setTimeout(done, 15000);
          v.addEventListener('seeked', done, { once: true });
          v.currentTime = x;
        }), anchor + off);
        await page.waitForTimeout(300);
        active = (await page.evaluate(tracksState)).find((s) => s.mode === 'showing')?.active;
        if (active) break;
      }
      r.active = active;
      r.checks.active = !!active;
      if (!active) {
        // Separate "no cue rendered" from "the film itself never loaded" (a seek
        // on a <video> without metadata is ignored, so no cue can be active).
        const v = await page.evaluate(() => {
          const el = document.querySelector('video');
          return { t: el.currentTime, dur: el.duration, rs: el.readyState, err: el.error && el.error.code };
        });
        r.notes.push(`video at active check: ${JSON.stringify(v)}`);
        if (!(v.rs >= 1)) r.checks.active = null; // stream problem, not a subtitle one
      }
    } else {
      r.checks.active = false;
    }

    // Reload: the saved preference must bring English back with no action.
    if (r.checks.cues) {
      await page.reload({ waitUntil: 'domcontentloaded' });
      const again = await waitShowingCues(page);
      r.saved = again ? `${again.label} (${again.cues} cues)` : null;
      r.checks.saved = !!again && again.lang === 'en';
      state = await page.evaluate(tracksState);
    } else {
      r.checks.saved = false;
    }

    // On-demand path: pick a non-English track (never preloaded).
    const other = state.find((s) => s.lang && s.lang !== 'en');
    if (other) {
      await selectTrack(page, other);
      const after = await waitShowingCues(page, other.lang);
      r.picked = `${other.label} -> ${after ? `${after.label} (${after.cues} cues)` : 'no cues'}`;
      r.checks.pick = !!after;
    } else {
      r.checks.pick = null; // nothing to pick; not a failure
    }
  } catch (e) {
    r.notes.push('error: ' + String(e.message || e).split('\n')[0]);
  } finally {
    await ctx.close();
  }
  r.pass = Object.values(r.checks).every((v) => v === true || v === null) && Object.keys(r.checks).length >= 5;
  return r;
}

const browser = await chromium.launch({
  channel: 'chrome',
  args: ['--autoplay-policy=no-user-gesture-required'],
  ...(proxy ? { proxy: { server: proxy } } : {}),
});
const results = [];
console.log(`Subtitle suite against ${base} — ${TITLES.length} titles\n`);
for (const t of TITLES) {
  const r = await runTitle(browser, t);
  results.push(r);
  const mark = (v) => (v === true ? 'ok' : v === null ? '–' : 'FAIL');
  const files = r.files.map((f) => `${f.via}:${f.status}`).join(' ');
  console.log(
    `${r.pass ? 'PASS' : 'FAIL'}  ${r.name.padEnd(22)} list=${mark(r.checks.list)}(${r.listed ?? '?'}/${r.english ?? '?'}en) ` +
      `cues=${mark(r.checks.cues)} active=${mark(r.checks.active)} saved=${mark(r.checks.saved)} pick=${mark(r.checks.pick)}`,
  );
  console.log(`      showing: ${r.showing ?? '-'} | on screen: ${JSON.stringify(r.active ?? null)} | pick: ${r.picked ?? '-'}`);
  console.log(`      files: ${files || '(none)'}${r.notes.length ? ' | ' + r.notes.join(' ; ') : ''}`);
}
await browser.close();

const passed = results.filter((r) => r.pass).length;
const tally = (k) => results.filter((r) => r.checks[k] === true).length + '/' + results.filter((r) => r.checks[k] !== null && r.checks[k] !== undefined).length;
console.log(
  `\n${passed}/${results.length} titles passed  (list ${tally('list')}, cues ${tally('cues')}, on-screen ${tally('active')}, ` +
    `saved ${tally('saved')}, pick ${tally('pick')})`,
);
const proxyFail = results.flatMap((r) => r.files).filter((f) => f.via === 'proxy' && f.status !== 200).length;
const direct = results.flatMap((r) => r.files).filter((f) => f.via === 'direct');
console.log(`subtitle files: proxy non-200 = ${proxyFail}, direct downloads = ${direct.length} (${direct.filter((f) => f.status === 200).length} ok)`);
if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ base, at: new Date().toISOString(), results }, null, 2));
process.exit(passed === results.length ? 0 : 1);
