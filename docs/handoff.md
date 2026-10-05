# Session handoff

## STATE AT END OF SESSION (2026-10-05) - READ THIS FIRST

**This file is the ONLY handoff. It lives on `main` (docs/handoff.md) and is updated by a docs-only commit on
`main`. Do NOT keep or edit copies of it on feature branches** (an earlier session did, and had to merge them back).

`main` = `4f052d4`, in sync with origin. Everything under "Live" is merged AND verified on production.
Git worktrees for all of this are under `.claude/worktrees/` (`music-tab`, `relay-sot`, plus merged ones that can
be removed: `empty-seasons`, `player-switch`, `sticky-footer`). Always work in a worktree, never in this checkout.

### Live on production (user asked for each merge)
- **Empty seasons hidden** (`c3626a5`, `lib/seasons.js`): Rick and Morty shows S1-9, header "9 Seasons" (OMDB said
  12); a stale `?s=10` link redirects to the latest real season.
- **Fiesta/Native player switch** moved from an overlay to a segmented control in a strip BELOW the video
  (`5b403c3`, `de9ac8a`): it covered iOS's native fullscreen button. Player e2e 10/10 Chrome + WebKit. Not
  checked on a real iPhone.
- **Sticky footer** (`4f052d4`): footer sits at the bottom on short pages; 30 page/viewport combos measured.

### Open branches (pushed, NOT merged) - the user decides when
1. **`feature/music-tab`** (13 commits ahead): the whole Music tab. Full details: section "MUSIC TAB - details" below. Summary:
   - `/music`, `/music/album/:id`, `/music/artist/:id`, mini player bar, Music = LAST tab in both navs with a red
     pulsing "New" badge; `api/music.js` + `lib/tidal.js` (search/album/artist/manifest/segment proxy);
     Media-Source-Extensions player (FLAC, AAC fallback; dash.js rejects the `flac` codec).
   - **Full lossless** comes from the owner's TIDAL web session kept fresh on the Mac mini relay
     (`/tidal/token`, `tools/fiesta-proxy/tidal-session.mjs`). Rule
     (`relaySessionAllowed()` in `lib/tidal.js`): previews + local dev use it automatically, PRODUCTION only if
     `MUSIC_SHARED_SESSION=1` (explicit opt-in; it makes every visitor listen on one personal account).
     Anyone with a preview URL can therefore listen on the owner's account (user accepted this).
   - Latest preview: `streamfiesta-64kyr9nzu-nktvit.vercel.app/music` (e2e 14/14, no key/token needed).
   - **Before merging:** add `TIDAL_CLIENT_ID` and `TIDAL_CLIENT_SECRET` to Vercel PRODUCTION (currently 0
     TIDAL/MUSIC vars there; Preview has the two). Without them `/music` errors on production; with them it
     serves 30 s previews only. Two copies of the sticky-footer CSS now exist (main + this branch): keep one.
   - Viewer login (PKCE, each visitor on their own TIDAL account) is NOT built: TIDAL error `11102` on the
     authorize page; needs the exact redirect URI(s) + scopes from the developer dashboard.
2. **`chore/relay-source-of-truth`** (1 commit): the Mac mini relay in git + `relayctl` (see below). The GitHub
   token cannot create PRs; open https://github.com/nktvit/fiesta.show/compare/main...chore/relay-source-of-truth

### Mac mini relay (`ssh mm`, `/Users/ms/Server/relay.fiesta.show`, launchd `show.fiesta.relay`)
- It is the HLS extractor AND now the TIDAL session keeper. The repo copy was a dead 369-line snapshot; the box
  had 1,221 lines. Branch `chore/relay-source-of-truth` fixes that: `npm run relay:status | relay:pull |
  relay:deploy` (`tools/fiesta-proxy/relayctl.mjs`; README "Source of truth and deploying"). Until that branch is
  merged, run these from `.claude/worktrees/relay-sot`.
- **Autofix agent** (`scripts/autofix-watchdog.sh`, runs `claude -p`) edits `relay.mjs` IN PLACE when upstream
  video sources change. Intentional. `relayctl deploy` refuses to overwrite a box file changed since the last
  sync (`mini-ahead`): `relay:pull`, review `git diff`, commit.
- TIDAL session on the box: `tidal-session.json` (0600; client_id `49YxDN9a2aFV6RTG` = "Tidal Web Player -
  HiRes", token host auth.tidal.com; TIDAL ROTATES the refresh token, the module persists it). If it stops
  (`/tidal/token` 502 `refresh_failed`, music falls back to previews): rerun `npm run tidal:relay-setup` from
  `.claude/worktrees/music-tab` (script header explains how to capture the token from DevTools - TIDAL's web SDK
  encrypts it in localStorage, so it must be caught in flight; the client_id is in the
  `login.tidal.com/api/refreshlogin?...client_id=` URL).
- Restarting the relay briefly interrupts live streams. NOT tested live: `relayctl`'s auto-rollback after a
  failed health check (it needs a deliberate outage; do it in a quiet window).

### Other findings / decisions
- **Angular audit** (research only, no code changed): `docs/angular-refactor-report-2026-10-04.md`.
  Headlines: latest stable 22.2, v20 LTS ends 2026-11-28; only 4/22 components OnPush; hls.js runs inside the
  zone (easiest big win); Buy Me a Coffee script blocks startup; unused `provideAnimationsAsync`; dead
  `tmdbImageLoader`. Constraint: nothing may raise the iOS/Safari 15 floor (needs a real iOS 15 test).
- Unit tests: 86 pass + 5 KNOWN failures (`MovieService` specs expect a hardcoded OMDB key).
- Preview URLs are publicly reachable (Deployment Protection is off for previews).

### Working conventions that bit us this session (so they don't again)
- Never type a secret from memory (a made-up value was once shown to the user as if it were real). Deliver secrets via the
  clipboard (`pbcopy`) or a file, never retype them.
- `EnterWorktree` cannot enter another repo's worktree; create it with `git worktree add` under
  `.claude/worktrees/`, symlink `node_modules`, copy `.env`/`.env.local`, copy `.vercel` for `vercel deploy`.
- Playwright lives in the global CLI: `NODE_PATH=/Users/nick-mbp/.nvm/versions/node/v24.11.0/lib/node_modules/@playwright/cli/node_modules`
  works for CJS-style `require`; ESM `import 'playwright'` (e.g. `tools/e2e/player.mjs`) needs a scratch dir whose
  `node_modules` symlinks that folder.
- The auto-mode safety check blocks weakening access controls and reading browser credential stores; ask the user
  to decide or to add a permission rule instead of working around it.
- Pending user-supplied data: nothing is waiting on the user except the production decisions above and the
  optional viewer-login dashboard details. The TIDAL web access token pasted in chat earlier expired
  ~01:41 UTC 2026-10-05; the refresh token pasted in chat was rotated away by the relay (dead).

## MUSIC TAB - details (branch `feature/music-tab`, preview verified, NOT merged; written before the relay-session automation, so where this differs from the summary at the top, the top wins)

Worktree: `.claude/worktrees/music-tab` (branch `feature/music-tab`, based on `1b96d91`). Preview:
`streamfiesta-l8fq2qgmi-nktvit.vercel.app`. Ported nothing from monochrome except the idea: it used
borrowed TIDAL app credentials and a `client_credentials` token; this uses OUR developer app.

**What exists**
- `/music` (search: songs/albums/artists, `?q=` in URL), `/music/album/:id`, `/music/artist/:id`; mini
  player bar (persists across routes, Media Session); "Music" is the LAST tab in both navs with a red
  pulsing "New" badge; sticky footer fix for every page (`styles.css`); donation widget lifts above the bar.
- `api/music.js` + `lib/tidal.js`: `search|album|artist` (app token, no login, cached), `manifest`
  (segment list; `PREVIEW` = 30 s or `FULL`), `seg` (audio proxy: TIDAL's CDN 403s a browser Origin, so
  a proxy is mandatory). Segment host allow-list `*.tidal.com`.
- Player = Media Source Extensions driven by hand (`music-player.service.ts`): dash.js rejects the
  `flac` codec string even though Chrome plays it. FLAC (lossless) where `isTypeSupported`, else AAC
  (`HIGH`). iPhone Safari < 17.1 has no MSE: shows "can't play this format".
- Tests: `tools/e2e/music.mjs` 14/14 on local AND on the preview (real Vercel functions);
  `music.service.spec.ts`; unit suite 86 pass + the 5 known MovieService apikey failures.
  Measured on preview: first sound 1.1 s, segment latency median ~125 ms (one ~1 s outlier), no
  mid-song stalls over 75 s, 40 s buffered ahead.

**Full-length playback needs a USER token (the open item).** The app token only gets 30 s previews
(`FULL_REQUIRES_SUBSCRIPTION`). Production therefore plays previews until per-viewer login ships.
- Dev: `npm run tidal:token` (reads clipboard, writes `TIDAL_DEV_ACCESS_TOKEN` to `.env.local`; token
  = a `Bearer` from a REQUEST header of api.tidal.com on listen.tidal.com; ~4 h life). Honoured only
  when `VERCEL_ENV !== 'production'`. It is NOT set on Vercel on purpose (a shared personal
  subscription must not stream to the public); the e2e sends it as `X-Tidal-Token` via
  `--token-file=`.
- Per-viewer login (PKCE) is NOT built: the authorize page returned TIDAL error `11102` (generic, raised
  before login). Cause unconfirmed; needs the redirect URI(s) and scopes exactly as shown in the TIDAL
  developer dashboard (I assumed `http://localhost:4200/music/callback`). `login.tidal.com` also rejects
  our client_credentials ("Invalid client credentials") while `auth.tidal.com` accepts them, so the app is
  registered on the legacy host. Playwright's Chrome is blocked by TIDAL bot protection (DataDome); the
  home IP is blocked on tidal.com web pages (api/openapi hosts are fine).
- Refresh plan: viewer's refresh token in an HttpOnly cookie, silently refreshed in `api/music.js`.

**Config done**
- `.env`: `TIDAL_CLIENT_ID`, `TIDAL_CLIENT_SECRET` (user-supplied). Vercel **Preview only** has the same two
  (secret stored sensitive); Production does not have them yet, so `/music` errors there until added.
- `auth.tidal.com` token endpoint is reachable from Vercel's servers (verified on the preview).

**Next**
1. User: fix/confirm the TIDAL dashboard redirect URI + scopes, then build `api/music.js?action=login|callback|refresh`.
2. Relay for segments (agreed direction, not built): `MUSIC_RELAY_URL` + the existing HMAC token scheme,
   because lossless is ~430 MB per listener-hour through Vercel. The Mac mini reaches TIDAL fine
   (`api.tidal.com` 200). Vercel `seg` stays as fallback. Do not deploy to the mini without asking.
3. Add TIDAL vars to Production before merging; decide on the "New" badge lifetime.
4. The pasted dev web-player token was shared in chat: treat it as exposed (it expires ~01:41 UTC 2026-10-05).

## RESEARCH (2026-10-04): third-party API inventory + monochrome comparison

Read-only audit, no code changed. Clone of github.com/monochrome-music/monochrome @ `5b1e6ef` (Vite SPA + Cloudflare Pages Functions) was used for comparison; its audit is grep-based, nothing run.

**fiesta.show external calls** (all `api/*.js` are Vercel Node functions; Angular calls TMDB/OMDB directly only in dev):
- TMDB `api.themoviedb.org/3` (`TMDB_API_KEY`): movie, tv, season, find, videos, recs, credits, person, search, genres, discover, lists. `api/tmdb.js`, `_tmdb-search.js`, `movie.js`, `middleware.js`. Images `image.tmdb.org/t/p`.
- OMDB `omdbapi.com` (`OMDB_API_KEY`): `?s=`, `?i=`, `?i=&Season=`. `api/omdb.js`, `suggestions.js`, `movie.js`.
- OpenSubtitles legacy REST `rest.opensubtitles.org/search/imdbid-X`, `dl.opensubtitles.org/en/download/file/{id}.gz` (browser fetches .gz direct, falls back to `/api/subs`).
- Stream relay (`STREAM_RELAY_URL`, `STREAM_RELAY_SECRET`): `api/stream.js` -> `/resolve`; relay (`tools/fiesta-proxy/relay.mjs`) scrapes `vidsrc.me`, `cloudnestra.com`, `vsembed.ru`, headless browser for Turnstile.
- Upstash Redis (`UPSTASH_REDIS_REST_*` / `KV_REST_API_*`): likes, comments, rate limit.
- Vercel AI Gateway, `openai/gpt-5.4-nano`: comment moderation (`lib/moderation.js`, OIDC token).
- YouTube iframe API (trailers), Vercel Analytics + Speed Insights, Google Fonts (Roboto), Buy Me a Coffee widget.
- Gaps: OMDB key plaintext in gitignored `src/environments/environment.ts` (ends up in dev client JS). Dev `tmdb.service.ts` reads undefined `environment.TMDB_API_KEY`. `.env.example` has unused `BACKEND_URL`, `USE_STATIC_DATA`.

**monochrome external calls** (music app):
- TIDAL: OAuth `auth.tidal.com/v1/oauth2/token` (client id/secret hardcoded in `js/HiFi.ts`, `functions/*/[id].js`); API v1 `api.tidal.com/v1` (tracks, playbackinfo, lyrics, mix, albums, artists, playlists, search); OpenAPI v2 `openapi.tidal.com/v2` (trackManifests = stream URLs, similar artists/albums, searchResults); images `resources.tidal.com`; proxy `tidal-proxy.monochrome.tf`.
- Own backends: `tracks.monochrome.st` (search, releases, track, goal, contributors; primary stream resolver), `auth.monochrome.st` (better-auth, parties WS), PocketBase `data.monochrome.st`, `hot.monochrome.tf`.
- Stream resolve order: `tracksStreamerAPI.resolveTrackStream` only. "Unified Playback" code (`js/api.js` ~2040-2790: Turnstile -> JWT) base URL not traced.
- Deezer fallback: `getDeezerStreamUrl(isrc, quality)` `js/api.js:1911` -> HEAD `https://dzr.tabs-vs-spaces.wtf/stream/?isrc=&format=FLAC|MP3_320|MP3_128` (12 s timeout), toggle in Settings, default on. No caller outside tests in `js/*.js` (orphaned at this commit; subfolders not grepped).
- Scrobbling: Last.fm `ws.audioscrobbler.com/2.0` (default key/secret hardcoded), Libre.fm, ListenBrainz, Maloja.
- Metadata: MusicBrainz, Apple Music API (`api.music.apple.com`, token from `am-mint.binimum.org`), AMP video covers, PodcastIndex, Panora, AOTY (`aoty.edideaur.works`), ArtistGrid, YouTube Music import worker.
- Lyrics: LRCLIB, Genius (via `api.allorigins.win`, tokens hardcoded), `@uimaxbai/am-lyrics`, kuromoji/kuroshiro via jsDelivr.
- Misc: `corsproxy.io`, `wsrv.nl`, DiceBear, GitHub (AutoEq), Plausible, Sentry (+replay), Turnstile, Google Fonts, upload workers `*.qzz.io`.
- Overlap with fiesta.show: Google Fonts, YouTube embeds, CDN scripts only.

**What the services are:**
- TIDAL: paid lossless/hi-res music streaming (FLAC up to 24-bit, Dolby Atmos). Price (US): Individual $10.99/mo (HiFi + HiFi Plus merged 2024-04-10), Family up to 6 $16.99/mo, Student $4.99/mo, DJ extension +$9; free tier gone. Sources: musicbusinessworldwide.com, billboard.com, androidauthority.com (TIDAL price articles).
- monochrome reaches TIDAL via borrowed app credentials plus community "HiFi" instances; `public/instances.json` is dead config (loader list empty).
- Last.fm: listening-history tracker; clients scrobble plays and read top artists/albums back. No audio.
- ISRC: universal recording id used to match the same track across services (Deezer fallback keys on it).

## SHIPPED (2026-10-03): search works again when OMDB is out of quota; "$7" budget fix; paid OMDB key

- **Search was dead on production**: `/api/omdb?action=search` and `/api/suggestions` both
  returned OMDB's `"Request limit reached!"` (free key, 1,000/day). New `api/_tmdb-search.js`
  (`_` = not a route) runs TMDB `/search/multi` whenever OMDB has no answer; both
  endpoints return it in their usual shapes (results: `imdbID: ''` + `tmdbId` +
  `mediaType`, like the home lists; cached 10 min). Client: search-box passes `?type=tv`
  for TMDB TV ids (ids overlap between movie/tv); search page stops paging on
  `_lastPage` (TMDB's total counts people, which are dropped, so the count is an
  upper bound). Verified on preview `streamfiesta-kh8h6fc5p` with
  `tools/e2e/searchcheck.mjs`: dropdown, suggestion -> Breaking Bad page, results page.
- **"$7" budget/gross**: TMDB user data had 7 for both. `usd()` in `api/movie.js` now hides
  amounts under $1,000.
- **Paid OMDB key** (user bought it) is set in Vercel (Production/Preview/Development)
  and in the gitignored `.env`, `.env.local`, `src/environments/environment.ts`. Verified
  live: OMDB search, and Shawshank shows IMDb votes, Metascore, awards, US box office.
  The TMDB search fallback now only runs if OMDB fails again.

## SHIPPED (2026-10-03): subtitle sync in Settings + controls 10% smaller

User tried the prototype ("works pretty good") and asked for (1) a normal on/off in the
player's Settings, no URL flags, and (2) a smaller control panel via the skin's own
size option, not hand-tuned sizes. Both done, verified on preview
`streamfiesta-dureqf109-nktvit.vercel.app`. Pushed to `main` 2026-10-03.

- **Settings > "Subtitle sync"**: Video.js's own `<media-menu-checkbox-item>` (loaded
  from `/vendor/videojs-10.0.1/ui/menu-checkbox-item.js`, a separate UI entry, with the
  main bundle in `loadVideoJs`). The skin has no slot, so `installSubsyncItem()` appends
  it to the Settings menu's top-level content inside the skin's shadow root, with the
  skin's menu classes, a check indicator and an inline sync SVG icon. **On by default**;
  `fiesta:subsync` = '0'/'1' in localStorage; `?subsync=0|1` still overrides (tests).
  Off = `SubtitleSync.destroy()`, which puts the cues back at file times (verified:
  cue 29.109 -> 29.764 = file time). Only on the hls.js path; not shown for native HLS.
- **Size**: `--media-scale-unit: 14.4px` (16px default * 0.9) on `.fiesta-skin`. The skin
  computes every size as `--media-spacing = var(--media-scale-unit,16px) * --media-scale / 4`
  and never declares the unit, so it inherits into the shadow DOM and also shrinks the
  fullscreen steps (1.25/1.5/1.75 at 1280/1536/1920 px). `--media-scale` itself does NOT
  work from outside: Chrome fullscreens the inner `media-container` in the shadow root,
  which re-declares it. Measured: control 36 -> 32.4 px; fullscreen 1920 px 63 -> 56.7 px.
- Tests: `tools/e2e/subsync-menu.mjs <url> [--browser=]`: Chrome 7/7, WebKit 7/7,
  Firefox 5/7. Firefox's 2 failures are a reload-after-opening-the-menu quirk that
  production shows identically (player appears ~15 s late in Playwright Firefox), not
  this change. Unit tests 83 + the 5 known MovieService failures; build clean.
- Sync engine details (still accurate):
- Audio: copies hls.js `BUFFER_APPENDING` audio (fMP4), `decodeAudioData(init+frag)` at
  16 kHz (verified Chrome/WebKit/Firefox), 300–3400 Hz biquads, log energy per 10 ms.
  Media time = tfdt/timescale + append `offset`. No extra requests; playback audio untouched.
- Every 10 s: speech mask over [now−150, now+60] vs showing track's cues; searches
  offset ±90 s × slope ±5% (41 steps) cold, ±4 s × slope ±0.2% when locked. Lock needs
  two agreeing confident estimates ≥20 s apart. Locked: points → least-squares line
  `audio = a·file + b` (outliers >1 s dropped, local 15 min), applied to ALL cues
  (original times in a WeakMap), so seeks extrapolate. A point >1 s off the line
  needs a second agreeing one before the line is replaced.
- Live results (2× playback): Oppenheimer default −0.8 s → locked −0.83 in ~35 s (Chrome),
  −0.55..−0.61 (Firefox); Shawshank default (file 36919) **+13 s** → locked +13.0 (Chrome,
  WebKit); Breaking Bad "English" (1.85% drift) tracked within ±0.4 s, lock ~35 s, seek
  13→38 min landed 0.3 s from truth; Matrix control held 0 ± 0.06.
- Cost (M1 Max): worst cold estimate 41 ms, decode ~10 ms per 5 s fragment, main thread.
  Slow TVs may need a Worker. Energy VAD misfires on loud scores (Inception offline);
  the agreement rules absorbed it in trials, but Silero (ML VAD) is the fallback.
- Live track lists differ from fresh searches: production's Shawshank "English" is the
  +13 s file and "English 2–5" look like CD1/CD2 pairs.

## RESEARCH (2026-10-03): subtitle sync vs our stream audio

User: "poor synchronization for subtitles … constantly". Measured 9 titles (Shawshank,
Matrix, Inception, Oppenheimer, Dune 2, GoT/BB/The Bear S1E1), 68 English candidates,
by transcribing 2-min fragments of OUR stream (faster-whisper, word timestamps) and
voting each subtitle file's offset. Tools: `tools/subsync/` (uncommitted; README there).
Precision ~0.3 s (ASR and VAD-only methods agree to that).

- **Default pick (most downloaded) is badly wrong sometimes**: Shawshank's is a 25 fps
  DVD file: +28 s early at 6 min, +341 s by the end. Oppenheimer's default is ~0.8 s
  late, Breaking Bad's ~1.4 s late. Matrix/Inception/Dune 2/GoT/Bear defaults fine.
- **Alternates (English 2–5) are often worse**: constant offsets (+13, +23, +57 s
  CAM), linear drift (Bear r=1.0045 −10→−6 s; BB r=1.0185 to +41 s; Shawshank's
  Blu-ray files r≈0.9992 → −4.5 s by the end), CD1/CD2 halves (CD2 restarts at 0),
  truncated or wrong files.
- Error is always constant offset + linear scale (fit residual ≤0.6 s), so
  `t' = r·t + c` per file fixes every non-garbage file.
- `MovieFPS` tag is unreliable (Matrix file tagged 25 fps is timed right); `MovieTimeMS`
  is always 0. Ranking by metadata cannot fix this; it must be measured.
- Both stream servers serve the identical encode (same duration/segments): a
  correction measured once per title applies to every viewer.
- A cheap energy VAD (300–3400 Hz band, no ML) gives the same offsets as ASR on 2-min
  windows, so a browser or the relay can measure without a speech model. VAD alone
  can't reject garbage files; cross-file agreement or ASR match rate does.
- Player hook point: `fillTrack()` (movie-player.component.ts ~838) — every cue goes
  through it.
- OpenSubtitles per-IP download cap hit from this Mac after ~40 files (401).
- Also this session: removed the duplicate "Seasons" row from movie details
  (`movie.service.ts`), pushed with the player.

## SHIPPED (2026-10-03): Video.js v10 player replaces native controls

Last verified preview: `streamfiesta-iynksh5g6-nktvit.vercel.app`. Committed and pushed to `main`
on 2026-10-03 (user: "merge the changes for new player"). Pre-push: `ng build` OK,
unit tests 74/79 (the 5 known `MovieService` apikey failures only). Production
verified after deploy: `player.mjs` 10/10 Chrome, WebKit, Firefox (first WebKit/Firefox
run had flaky captions/quality checks, clean on rerun).

- **UI**: Video.js v10 (`@videojs/*` 10.0.1, released 2026-10-02; the npm `video.js`
  package is still v8) Default skin around OUR `<video>` + OUR tuned hls.js.
  `src/app/utils/hls-renditions.ts` (+spec) exposes hls.js levels as
  `video.videoRenditions` for the Quality menu (`manualLevel` = the pin; NOT
  `nextLevel`). Captions menu reads our TextTracks, so the subtitle pipeline is unchanged.
- **Video.js is NOT bundled by Angular.** `@videojs/cdn` (devDep, exact 10.0.1)
  is copied by angular.json to `/vendor/videojs-10.0.1/` (immutable cache header
  in vercel.json) and loaded at runtime (`VIDEOJS_URL`). Reason (verified): with
  zone.js, Angular downlevels async/await in node_modules too, and Video.js
  elements then ran their first update before they were wired. Every tooltip
  became an empty pill and the bar could stay hidden. Bump all three places together.
- Engine: hls.js wherever supported; native only for `?hls=native`, or after
  hls.js fails fatally (new `hlsFailed`), before server-2 escalation. A fatal
  MANIFEST_* error now skips the pointless `startLoad()` retries (it used to hang).
- "Native player" / "Fiesta player" toggle (top-left), persisted in
  `fiesta:player-ui`. It keeps position, play/pause and subtitles.
- Arrow keys: capture-phase document listener + preventDefault, so the skin's
  own arrow hotkeys skip and a press seeks 10 s once.
- Subtitle lift: global rule in `src/styles.css` applies the skin's
  `--media-caption-track-y` to our slotted video's cue container (-56 px with
  the bar, -8 px without). Chromium/Safari only; Firefox can't style it.
- Tests: `tools/e2e/player.mjs <url> [--browsers=chrome,webkit,firefox]`: 10/10
  Chrome, 10/10 WebKit, 8/8 Firefox. `subtitles.mjs`: 4/4. Not checked: a real
  iPhone/Safari, the Samsung TV (lite client untouched), long viewing sessions.
- Gotchas: test URLs must use `hlsdebug=1` (a bare flag gets rewritten by the
  router, which re-renders the page). Bar must be visible before clicks
  (`wakeControls`). "Auto (720p)" matches `name: '720p'` unless `exact: true`.


## IN PROGRESS (2026-10-02): movie details fixed + shipped; subtitles + native HLS on preview, NOT committed

**Shipped (`2d90980`, live, verified):** movie pages were nearly empty because
the OMDB key is out of quota (`"Request limit reached!"`, free tier 1,000/day;
the crawler noted below burns it). `api/movie.js` treated that as "not found",
served a TMDB stub with every field `N/A`, and cached it 7 days. Now it pulls
TMDB's full record (`/movie|tv/{id}?append_to_response=credits,release_dates|content_ratings`)
and fills every missing field. It adds `_budget`, `_revenue` (worldwide),
`_tagline`, `_network`, `_status`. A failed OMDB is cached 1 h (quota) or 1 day
(title missing). The movie page shows new rows: Network, Status, Seasons, Budget,
Box Office (US) (OMDB), Worldwide Gross (TMDB), Tagline. OMDB-only data (IMDb
votes, RT/Metacritic, awards, US box office) returns when the quota resets.
Decision for the user: a paid OMDB key ($1/mo patreon tier) would bring those back.

**Uncommitted in the working tree (verified preview: `streamfiesta-bxrv0xiyw`):**

1. **Native HLS in Chromium** (user asked to bring the TV player's approach to
   Chromium; they chose "native playback only", keeping the main UI).
   `movie-player.component.ts`: `preferNativeHls()` + `attachNative()`. Chrome
   151/152 answer `canPlayType('application/vnd.apple.mpegurl') === "maybe"`, so
   Chromium gets `video.src = master` and falls back to hls.js once on a media
   error. Desktop Safari and Firefox keep hls.js. `?hls=js|native` forces an
   engine. Verified on preview: plays, climbs to 1920x1072 on its own, seeks
   land. NOT verified: long-watch stability, real users' seeks.
   Test-harness quirk (not a bug, prod does it too): under Playwright Chrome
   the video emits a native `pause` ~1.1 s after play, with either engine.
2. **Subtitles ("fail ~80%", user)**. Root cause, measured: OpenSubtitles
   caps downloads **per IP**. All Vercel functions share a few egress IPs, so
   `/api/subs?file=` 401s (we relay as 502) for every file not already in the
   CDN cache. Every deploy empties that cache. The player also preloaded ~17
   files per title view. Production baseline with the new suite: **0/16 titles**.
   Fixes:
   - `utils/vtt.ts fetchSubtitleDirect()`: on proxy failure the browser fetches
     `dl.opensubtitles.org/.../<file>.gz` itself (CORS `*`), then gunzips,
     decodes and strips ads. This uses the viewer's own IP/allowance.
   - Preload only the saved-preference track (`preloadPreferredSubtitle`); nothing
     without a preference. Others load on pick.
   - `api/subs.js`: a second `sublanguageid-eng` search when the general one has
     no English **SRT** (LOTR and The Matrix had none).
   - Pref-saving bugs: `hlsTouchedTracksAt` started at 0, so any pick in the
     first second after page load was treated as machine-driven and never
     saved (now `-Infinity`); the `change` listener is now wired when tracks
     render, not at stream attach.
   Results on preview: 13/16 titles got English cues (vs 0/16); with warm cache
   7/7 saved-pref after the fix. **Blocked:** this Mac's IP is now CAPTCHA-walled
   by OpenSubtitles (301 -> http captcha page, shows as ERR_ABORTED) after ~80
   test downloads in 10 minutes. That cap applies to viewers too (a heavy viewer could hit it).
   Next: rerun `tools/e2e/subtitles.mjs` from a clean IP. Options: Tailscale is
   **stopped** on this Mac, so `ssh mm` (relay box) times out. Start it and use
   `ssh -D` as a SOCKS proxy for Playwright, or a Webshare proxy
   (`WEBSHARE_API_TOKEN` is not set here).
   Longer-term options if the per-IP cap still bites: persist VTTs once
   downloaded (Vercel Blob keyed by file id) so each file is fetched once ever,
   or the official api.opensubtitles.com with an API key.
   Not touched: the lite/TV client still uses only the proxy (Tizen's Chrome 47
   has no `DecompressionStream`).

**Verified 2026-10-03 from a clean IP** (`ssh -f -N -D 1080 mm`, then
`--proxy=socks5://127.0.0.1:1080`; Tailscale/Cloudflare back on): normal run 12/16,
with the 4 failures explained (3 were test seek timing, since fixed and re-passed;
Inside Out 2's player intermittently never got a video mid-run, and it passes
alone). With `--block-proxy` (every `/api/subs?file=` forced to 502, so only the
direct fallback works): **15/16**. The 16th failed because mm's IP got
CAPTCHA-walled after ~50 downloads in ~10 min, so the per-IP cap is roughly
50 per short window. Do not run the full suite twice in a row from one IP.

**Cache lifetimes raised (uncommitted, user request: "cache for 30 days"):**
`api/movie.js` 30 d, or 1 d for releases under 90 days old (gross still
changing), or 1 h while OMDB is failing. `api/tmdb.js` movie/find/credits/person/videos
30 d. `api/subs.js` list 30 d if English found, 1 d if not, 1 h if empty.
Vercel purges the CDN cache on every deploy, so this only holds between deploys.

**New test:** `tools/e2e/subtitles.mjs <baseUrl> [--only=tt..] [--json=out]`.
Each title runs in a fresh Chrome context: list, pick English -> cues, cue on
screen at 25%, reload -> remembered, pick non-English -> cues. It also logs proxy
vs direct downloads. ESM ignores `NODE_PATH`: run it from a dir whose
`node_modules/playwright` exists (symlinking `playwright-core` works).


## CHECKED: relay state vs "seeking stutters" (2026-09-29, late night IST) — relay is healthy, not reproducible from here

User: "films very often glitch and stall when seeking — check the relay."
Checked live over `ssh mm` and from this Mac; **nothing on the relay explains it
right now**:

- Box: up 7h46 (rebooted ~16:30 IST on the 28th), load 1.3, memory free 81%
  (a 3.6 GB `com.apple.Virtualization` VM + a supabase CLI run on the same
  box — someone develops there; not hurting today), disk 10% used, Ethernet
  `en0`, ping 1.1.1.1 jitter 0.3 ms. `show.fiesta.relay` pid 551, 235 MB RSS,
  0% CPU. `[segstats] bad=0` all session.
- Relay code (scp'd `relay.mjs`, 1219 lines, unchanged since 13 Sep):
  `handleHls` aborts the upstream fetch on client `close` and streams via
  `pipeline`, no concurrency cap on segments — so a seek storm cannot leave
  orphan downloads. **Gap:** upstream segment `fetch()` has no timeout (only
  hls.js's own fragLoadPolicy would end a hung upstream socket).
- Measured through the relay from here: mid-film segments (cold for me)
  TTFB 0.1–0.2 s, 12–25 Mbit/s; direct from the box to upstream 5.4 MB/s,
  `cf-cache-status: HIT`.
- **Seek reproduction on production with `?hlsdebug`** (`seek-test.mjs`,
  `seek-rapid.mjs` in the scratchpad): 9 seeks across Shawshank: resume
  74–608 ms, 0 stalls/nudges/holes, ≤2 dropped frames, top level, bandwidth
  estimate ~50 Mbit/s, fragment TTFB p50 68 ms / max 139 ms. 6 seeks 120 ms
  apart ×3: resume ≤1.3 s, 0 stalls. Lawrence of Arabia (cold): resume ≤481
  ms, one non-fatal `fragParsingError` (a corrupt upstream fragment; hls.js
  recovered) — the only blemish, and a plausible source of a visible hiccup.
- cloudflared log: dozens of `stream N canceled by remote with error code 0`
  = the client aborting fragment loads (seeks/level switches), benign. One
  real outage: 2026-09-28T15:33Z cloudflared shut down on a local DNS failure
  (`[::1]:53 connection refused`), before the reboot.
- `relay.log`: a steady stream of `[resolve] ttNNN srv=1/2 api status_code
  404` every ~10 s for random titles = something (a JS-rendering crawler?)
  loading many movie pages; the player resolves the stream on page load, not
  on Play. Load, not a seek problem — but worth throttling one day.

**Shipped as a precaution (this commit):** repeated/held Left/Right presses
now coalesce into ONE seek in both players (160 ms window). A held key
auto-repeats ~30×/s; on the TV each seek makes native HLS rebuffer, on the
web each makes hls.js abort+refetch.

**To actually catch it:** ask the user WHERE it happens (TV vs Mac/phone,
which browser, time of day) and try `?hlsdebug` on their device, then read
`window.__fiestaTelemetry` after a seek. If it is the TV: native Tizen HLS
seeking is out of our hands beyond coalescing. A `[slow]` log line in the
relay for segments taking >2 s would give evidence for their sessions, but
that is a relay edit + restart — the user's call.

## SHIPPED TO PRODUCTION (2026-09-28, later the same day): lite client pushed, main-site subtitles + arrow keys

Everything from the section below this one is now **committed and pushed**
(`79b24d6`, `5b5f9f3`, `73adc07`), plus three follow-ups:

- **Lite player fullscreen** (`5b5f9f3`): user reported the TV still showed
  the browser's address bar after Play. Now the request is retried on the
  player stage element, there is a Full screen button in the bar, and when
  no request takes effect a toast tells the viewer to use the browser's own
  Full Screen mode. Whether any of this actually hides Samsung's bar is
  **unverified** — the user must report back; Tizen's browser may simply not
  support element fullscreen at all.
- **Lite subtitle timing** (`73adc07`): user reported cues lagging. Overlay
  is now driven by a 100 ms interval instead of `timeupdate` (which some TVs
  fire at ~1 Hz). If it still drifts, the source file is out of sync for that
  release — the CC menu offers "English 2…5" variants for that.
- **Main site player** (`6ab95da`, verified on preview
  `streamfiesta-3t05efimt` with Playwright, then pushed to `main`):
  - Subtitles no longer rely on `<track src>` at all. Every `<track>` gets an
    inert `data:text/vtt,WEBVTT` src; the player fetches the VTT, parses it
    (`src/app/utils/vtt.ts`) and calls `TextTrack.addCue()`. `vttCache`,
    `trackSrc`, `assignTrackSrc` are gone; replaced by `cueCache`,
    `fetchCues` (one retry, de-duplicated in-flight), `fillTrack`,
    `ensureCues`. A 5 s notice shows if a file can't be fetched. Verified: 17
    tracks listed, picking one via the native menu loads 890 cues, active cue
    correct after a seek, choice persisted.
  - Left/Right arrows seek ±10 s once playback started (document-level
    listener, skips inputs/textareas/contenteditable and modifier combos).
    Verified: +10 / −10 / no seek while a textarea is focused.
  - Re-verified on production after deploy (`6ab95da`): same results, plus
    the on-demand path (a track the preload queue hadn't reached yet loaded
    1683 cues on pick). One earlier production run showed 0 cues for a pick
    right after the deploy and did not reproduce — treat as a flake, but if
    it comes back, the first thing to check is `enforceSingleShowing`.
  - `enforceSingleShowing` bug found by experiment and fixed (`lastShowingKey`):
    with two tracks showing at once it kept the *old* one (index 0 / saved
    pref) and silently disabled the viewer's new pick.
  - **Root cause of "picked subtitles, nothing shows", found with a stack
    trace and fixed (`hls.js` 1.6.16 interference)**: its
    `timeline-controller._cleanTracks()` removes every cue from EVERY text
    track of the media element on MEDIA_ATTACHING and MANIFEST_LOADING, and
    its subtitle-track-controller's `change` listener calls
    `setSubtitleTrack(-1)` -> `toggleTrackModes()` which sets every native
    subtitles/captions track to disabled. Fix: `renderTextTracksNatively:
    false` in the Hls config, plus `reassertSubtitles()` after
    MEDIA_ATTACHED / MANIFEST_LOADING / MANIFEST_PARSED /
    SUBTITLE_TRACKS_UPDATED / SUBTITLE_TRACK_SWITCH, and `change` events
    within 1 s of those are treated as machine-driven (modes still
    reconciled, preference NOT saved).
  - **Second Chromium quirk, reproduced in a blank page**: cues added by
    script to a `<track>` element's TextTrack are wiped when that element's
    FIRST load completes (stub `data:` src or no src alike); cues added after
    survive every later toggle. So `fillTrack` only runs once the element is
    settled (`readyState >= 2`) and `(load)`/`(error)` on each `<track>`
    (`onTrackLoaded`) refills from `cueCache`.
  - Saved preference now resolves per title (`preferredKeyFor`): exact
    lang+label, else first track of that language — labels carry release
    tags ("English — DVD") so exact matches across titles are rare.
  - **Sibling fallback** (`fallBackToSibling`): when the chosen file 502s
    (observed live: Breaking Bad S1E2 "English" 502'd for a while, then
    served fine), the player switches to the next same-language variant that
    downloads and shows a 5 s notice; the preference is left alone. Verified
    by forcing `file=36919` to 502 via a Playwright route: switched to
    "English 2", 890 cues, correct active cue.
  - Verification tooling: Playwright Node scripts (`trace-modes.mjs`,
    `trace-series.mjs`, `trace-episode.mjs`, `trace-fallback.mjs`) lived in
    the session scratchpad, not the repo. Lesson: `playwright-cli eval` with a
    `;` in the expression fails silently — two "bugs" this session were the
    harness not writing localStorage.
  - NOT verified: iOS Safari native fullscreen rendering of script-added
    cues (should work — they sit in the same TextTrack — but not observed).

## DONE, NOT COMMITTED: legacy-TV (`/lite`) client rebuilt — routing, player, subtitles, design (2026-09-28)

User's complaints, all against the `tv/` client served to Tizen / pre-Chrome-49
UAs: (1) subtitles didn't work — the native CC button was tiny and unreachable
with a remote, and the tracks never rendered; (2) Play should go fullscreen
on its own; (3) routing was hash-based (`#/title/…`, `#/watch/…`) and unlike
the main site; (4) the player and pages looked bad.

### What changed (all under `tv/`, nothing outside it)

- **Routing now mirrors `src/app/app.routes.ts` exactly** (`tv/src/router.ts`,
  History API): `/`, `/search?query=`, `/movie/:id[?type=tv&s&e]`,
  `/movie/:id?play=1` (player), `/person/:id`, `/genre/:id`, `/top-rated`,
  `/tv`; everything else → home. Old `#/title` / `#/watch` hashes are
  rewritten on load. **`middleware.js` needed no change**: it already rewrites
  every non-`/lite`, non-`/api` path to `/lite/index.html` for legacy UAs and
  keeps the query string, so a main-site link opened on a TV lands on the
  same screen in the lite bundle.
- **Player rewritten** (`tv/src/screens/Player.tsx`): no native controls.
  Own D-pad-focusable bar (−10s / Play-Pause / +10s / Next episode / CC),
  progress + time, title and "Season · Episode · name" top bar, 4 s auto-hide,
  loading/error overlays on the backdrop. Tizen media keys handled
  (415/19/10252/413/412/417). Fullscreen requested inside the Play click
  handler on the details page (gesture-bound) and exited when leaving.
- **Subtitles**: VTT fetched as text and drawn into our own overlay
  (`tv/src/subtitles.ts`), no `<track>` at all. Side-panel picker (Off +
  every track), default = saved `fiesta:subtitle-pref` → first English →
  first; choice persisted under the same key the main site uses.
- **Stream fallback**: resolve relay-auto first, then `srv=2` on a failed
  resolve *or* a video `error`; "Try again" flips servers.
- **Design**: new stylesheet (10-foot sizing, white 4px focus ring + tile
  scale, hero with poster/chips/genres, episode cards with stills and
  per-episode progress, cast row, person page). Still Chromium-47-safe: no
  grid / custom properties / gap / clamp / sticky; bundle verified ES5-only.
- New screens: `ListPage` (tv / top-rated / genre with Load more), `TvShows`,
  `Person`; `Search` keeps the query in the URL (replaceState).
- `tv/README.md` written (package.json referenced one that didn't exist).

### Verified (real browser, Playwright against `tv/dist` + production `/api`)

Local stand-in served `dist/` with the `/lite` rewrite and proxied `/api/*`
to fiesta.show; `/api/stream` mocked with a generated 4-min MP4 because
desktop Chromium has no native HLS. Checked end to end: home → tile → details
(focus lands on Play) → Enter → `/movie/tt0111161?play=1`, fullscreen on,
playing; real English cues from OpenSubtitles render in the overlay; CC menu
opens on the current track, switching to "English 2" persists the pref; Back
closes the menu only, next Back leaves the player, exits fullscreen and shows
"Resume"; Breaking Bad (`/movie/1396?type=tv`) shows 5 seasons / episodes,
Enter on an episode → `…?type=tv&s=1&e=1&play=1` with the episode title,
"Next episode" → `e=2`; `srv=2` fallback fires when the first resolve 502s;
`/tv`, `/top-rated`, `/genre/28`, `/person/17419`, `/about`(→home) all render;
`#/watch/tv/tt0903747/2/3` → `/movie/tt0903747?type=tv&play=1&s=2&e=3`.

### NOT verified — needs the real TV

- Anything on an actual Tizen 3.0 set: native HLS playback of the relay
  master through the new (control-less) `<video>`, whether the TV shell
  honours `webkitRequestFullscreen`, media-key codes, overlay text size at
  3 m. All coded defensively (every fullscreen call is try/catch,
  best-effort) but not observed.
- Root `npm run build` (Angular + the `tv/dist` → `/lite` asset copy) was not
  re-run; only `tv`'s own `npm run build` + `tsc --noEmit` (clean).
- Not deployed. Working tree only. Next: commit, preview deploy, then the
  user checks on the TV.

### Found on the side

- **OMDB search is rate-limited on production right now** (`/api/omdb?
  action=search` → `{"Response":"False","Error":"Request limit reached!"}`),
  so search returns nothing on the main site too — not a lite bug. The lite
  client now shows "Search failed" for that case instead of "No results".

## DEPLOYED TO THE LIVE RELAY: playback stability fixes (2026-09-13)

User reported **delayed audio, intermittently missing frames, and quality drops**,
and said it did not feel like their connection. They were right that it wasn't
bandwidth — measured mid-session: a 2.53 MB segment in 0.45 s (~45 Mbit/s), every
upstream segment `cf-cache-status: HIT`.

**CORRECTION, from the user after the investigation: the audio delay was
Bluetooth.** Output latency, 150-250 ms and constant, not a software bug. So the
A/V-desync line of inquiry below describes a real hls.js mechanism that was never
actually biting anyone — do not let it justify work. Two symptoms remain:
**missing frames** (best explained by the relay cache bug, now fixed) and **quality
drops** (best explained by `abrEwmaDefaultEstimate`, still staged). On whether the
glitch recurs at the same timecode, the user thinks so but can't be sure — weak
supporting evidence for the cache bug, not proof.

### The relay bug, reproduced on production before the fix

`handleHls` copied the upstream status through and then stamped
`Content-Type: video/mp2t` + `Cache-Control: public, max-age=31536000, immutable`
**unconditionally**. Verified live against the real relay: a segment whose upstream
401s came back as `HTTP/2 401`, `content-type: video/mp2t`,
`cache-control: public, max-age=31536000, immutable` — a 9-byte error body
labelled MPEG-TS and marked immutable for a year.

Why that is the "missing frames at the same spot" symptom: an explicit `max-age`
makes an error response storable (RFC 9111 §3), and **Chrome and Safari both store
a 404 that carries one** (Firefox refuses; Edge caches only 200). So one transient
upstream blip became a *permanently* broken segment at a fixed timecode —
surviving reloads, working offline, and serving the same poisoned body to every
hls.js retry until `fragLoadPolicy` gave up. And it was invisible: `[hls] upstream
fail` only fires when `fetchUpstream` **throws**, but a 5xx-after-retries
*returns*, so relay.log held **0 `[hls]` lines in 1879**.

### Shipped to the box (one edit, one restart, verified)

1. **Non-200 → uncacheable 502.** `text/plain`, `no-store`, logged as
   `[hls] segment upstream=<code> path=…`. Collapsed rather than forwarded on
   purpose: hls.js retries a 5xx, and 404 is the status browsers keep.
2. **Upstream-token refresh on 403/401.** `getHostToken` returns a cached token
   with as little as **60 s** left, and the resolve cache then serves that master
   for up to 600 s, while our own `/hls` token lives 6 h — so the relay was
   authorising requests whose upstream credential was already dead. Now it mints a
   fresh one and retries once. **Storm-safe**: when a token expires every in-flight
   segment arrives at once, so a request whose URL token is already older than the
   cached one just re-stamps from cache and makes no upstream call. One
   `generate.php` call per expiry event, which matters on an endpoint currently
   rate-limiting this /24.
3. **`[segstats] ok=N bad=N bad_rate=%` every 60 s** — the failure rate had no
   denominator before. Counters are cumulative since process start, so read the
   deltas between lines, not the absolute percentage.
4. **Log timestamps**, via one wrap of `console.log/error/warn`. **This shifted
   every awk field position and broke a `^\[resolve\]` anchor, so
   `scripts/autofix-watchdog.sh` was patched in the same window** (grep is now
   `^[^ ]+ \[resolve\] …`, awk reads `$3`/`$5..NF`). Proved with a synthetic log
   that the old patterns match nothing and the new ones still group 3 distinct
   titles. If you revert the timestamps, revert the watchdog too.
5. **`keepAliveTimeout` 5 s → 120 s** (`headersTimeout` 125 s). cloudflared pools
   idle origin connections ~90 s and reuses them; the player idles for seconds on a
   full buffer, so Node's 5 s default meant cloudflared regularly sent a request
   down a socket this process was closing. Go's transport retries an idempotent GET
   in that race, which is why it was survivable rather than obvious.

**Verification:** backed up both files (`*.bak-20260913T083551Z`); autofix agent
`launchctl bootout`ed for the window and re-loaded after; `node --check` with the
exact launchd interpreter; `launchctl kickstart -k`. Then: the same segment URL
byte-identical before/after (**2,530,104 bytes**, same headers); the failing URL now
`502` + `no-store`; `/resolve` still works for both a movie and a TV episode; and
**60 s of real headless-browser playback on production: 33/33 segments 200, 0
dropped frames of 1409, one buffered range throughout.**

### Gotchas found the hard way

- **`bash -n` cannot check `autofix-watchdog.sh`.** It is `#!/bin/zsh` and the
  box's bash is 3.2 — `bash -n` reports a syntax error **on the pristine
  original**. Use `zsh -n`. This briefly looked like my patch had broken it.
- `node --check` refuses a `.new` extension (`ERR_UNKNOWN_FILE_EXTENSION`). Check
  after the `mv`, not before.

### NOT deployed — staged in the working tree, needs your call

The player changes are the **bigger half** of the fix and are uncommitted
(`src/app/components/movie-player/movie-player.component.ts`, typecheck + build
clean). The working tree also holds unrelated uncommitted work, so this needs a
scoped commit:

- **`progressive: true` removed — PRECAUTIONARY, and the weakest item here.** It was
  removed as the prime suspect for the accumulating audio delay; that symptom turned
  out to be Bluetooth, so there is now **no observed problem attributable to it**.
  Residual case: it is a non-default path feeding 128 KB partial chunks to the
  transmuxer, whose own comments note it then has "no guarantee the fetch loader
  gives us flush moof+mdat pairs", and whose A/V realignment only runs once it holds
  enough samples of *both* tracks — and our responses are chunked with no
  Content-Length, exactly that jagged-input case. Cost is a time-to-first-frame rise
  of about one fragment transfer (143-592 ms measured). Reasonable either way; left
  off to match the library's tested path.
  **A claim I got wrong and corrected in the code:** I had written that progressive
  inflates `parsing.end` and so depressed the bandwidth estimate. It is the
  opposite — `parsing.end` is stamped when transmuxing completes, so *removing*
  progressive pushes it later by one parse pass. Immaterial at these magnitudes
  (tens of ms against a ~450 ms load), but the direction was backwards.
  The hls.js audio-accumulator bug is real and recorded here for whoever hits it for
  real: on a contiguous AAC chunk the first sample's true PTS is discarded for a
  running accumulator (video re-derives from real DTS every fragment, audio never
  does), and that accumulator has **no reset path** — `recoverMediaError()` does not
  clear it, so it is forward-only for the session. Nobody has reported it.
- **`abrEwmaDefaultEstimate: 8_000_000 → 5_000_000`** — this was itself a bug.
  hls.js only auto-derives a start estimate when the option is *undefined*, so 8e6
  survived into `firstAutoLevel`, where the only surviving gate is
  `adjustedbw >= maxBitrate`: 8e6 ≥ 5,145,364. **Every session on every connection
  started on 1920×1072 with an empty buffer and stepped down.** Bandwidth-
  independent — which is exactly why it didn't look like a connection problem.
- ABR margin restored (1.0/0.9 → 0.95/0.8), `maxBufferLength` 60 with
  `maxMaxBufferLength` pinned to 60 (it is a *floor*, not a cap: the real target is
  `min(max(8 × maxBufferSize / bitrate, maxBufferLength), maxMaxBufferLength)`),
  `backBufferLength` 90 (default `Infinity` on a 2h film).
- Non-fatal `BUFFER_STALLED_ERROR`/`BUFFER_SEEK_OVER_HOLE`/`BUFFER_NUDGE_ON_STALL`
  now show the spinner — a stall inside a buffered range never fires `waiting`, so
  the UI froze silently.
- `recoverAttempts` resets on `FRAG_BUFFERED` — it was 3 recoveries for an entire
  film.
- `?hlsdebug` telemetry (`window.__fiestaTelemetry`): per-fragment audio/video PTS
  skew, level switches, hole/nudge/stall counts. Without `debug` hls.js installs a
  no-op logger, so the strings that name these failures were never emitted.

**Deliberately rejected** (all considered and dropped on evidence): `maxBufferHole:
0.5` and `nudgeMaxRetry: 6` — I had added both, then removed them. Raising
`maxBufferHole` makes a gap of up to ~12 frames invisible to hls.js so it is never
re-fetched: it manufactures the dropped-frame symptom while hiding the evidence.
The 312-line relay readahead cache — **measured dead**: every upstream segment is
already a CDN `HIT`, relay TTFB is flat across concurrency 1→24, and hls.js
subtracts TTFB from its bandwidth sample by construction. A skew watchdog calling
`recoverMediaError()` — disproven, it does not reset the audio accumulator.

### Still open

- **Both diagnostic questions are answered** (see the correction at the top): the
  audio delay was Bluetooth, and same-timecode recurrence is a soft yes. The
  remaining open symptom is **missing frames**, and `[segstats]` is how we find out
  whether the cache fix addressed it.
- **Read `[segstats]` over a full film.** A non-zero `bad_rate` on healthy playback
  is the smoking gun for how often the cache bug was firing. That number has never
  existed before today.
- **Unbounded segment body**: `page-999999.html` returned upstream 200 and the relay
  streamed **401 MB in 60 s, still flowing**, for a fragment the playlist calls 5 s.
  No cap in `handleHls`. A 16 MB cap + TS-framing check (log-only first) is designed
  and deliberately **not** bundled — it is the only change that could reject healthy
  media, so it needs its own restart and its own verification.
- `RELAY_TOKEN_TTL=14400` to match upstream would close the window properly, but
  only after a player-side re-resolve path exists; the refresh in (2) covers it for
  now.

## DONE: extraction docs reconciled against the live relay (docs only, NOT COMMITTED)

User asked whether the handoff mentioned "website analysis / tracing the stream".
It didn't — the tracing was documented in `tools/fiesta-proxy/README.md`, and that
doc plus `docs/stream-proxy-architecture.md` were both describing a system that
stopped existing in 2026-08. Both are now rewritten against the **live** file.

**Nothing on the Mac mini was touched.** Read-only inspection throughout: the live
`relay.mjs` was `scp`'d to a scratchpad and read there. No edits, no restarts, no
writes to the box. No code changed in this repo either — three doc files only.

### The live relay is 1089 lines, not 975

The prior entry's figure is out of date (the file grew again on 2026-09-09,
39.5KB → 46.3KB; mtime says a hand edit, and the autofix agent still has never
fired, so it wasn't that). Everything below was read first-hand from it.

### What the docs were wrong about — the load-bearing items

- **The chain in the old README does not exist.** `vidsrc → cloudnestra/rcp →
  cloudnestra/prorcp → Playerjs file:"…tmstr5.{vN}/pl/{token}/master.m3u8"` was
  killed by two upstream migrations, both recorded in the watchdog script's own
  prompt: **2026-08-19** `cloudnestra.com` → `cloudorchestranova.com`, and
  **2026-08-24** `#player_iframe` losing its static `src=` in favour of a
  `data-api="/vs_src.php?…"` gate returning `{src}`. The real walk is now 8 hops
  (front → `vs_src.php` gate → layer2 `window.CFG` → layer3 `window.CONFIG` →
  data API → **WASM decrypt** → per-host `generate.php` token → probe).
- **`stream_urls` is ChaCha20-encrypted and decrypted with a rotating WASM
  module** (`vs.wasm_url`, ~5-min windows, mirrors the site's `vsdec.js`, run via
  Node's `WebAssembly`). This is why "re-trace with a browser network capture" is
  no longer adequate advice — a capture shows an opaque base64 blob. The README
  now carries the hop-by-hop curl procedure that actually root-caused both
  migrations.
- **"The token is not IP-bound — segments fetch fine from any IP" is backwards,
  and this is now measured, not inferred.** A live segment token decoded
  2026-09-13 carries `exp`/`iat`/`ip_cidr`/`iss`/`nbf`, with `exp − iat = 14400`
  (exactly 4h) and a **`/24`** mask. The relay only reads `exp`, so enforcement is
  upstream's. This is *the* reason every byte must come from the box.
- **No Webshare, anywhere.** No `STREAM_PROXY_URL`, no `STREAM_PROXY_RETRIES`, no
  `undici`/`ProxyAgent`. The residential IP plus a Playwright Turnstile fallback
  replaced it — **but that fallback is unexercised, not merely rare.** The log's
  lifetime 536/9 split is an artifact: all 9 browser resolves predate log line
  262 and the 2026-08 migrations, and since the last restart it is 65 plain, 0
  browser, 0 Turnstile detections. `resolveMasterBrowser` now waits on
  `window.CFG =`, a post-migration selector that has never run in anger. Proving
  it works takes one deliberate `RELAY_FORCE_BROWSER=1` resolve.
- **`api/hls.js` is gone** (`1955290`), so the old two-Lambda / all-video-through-
  Vercel cost model described nothing real.

### New things found while verifying, that nobody had written down

- **The tunnel is Cloudflare Tunnel** — `cloudflared` as a root LaunchDaemon
  (`/Library/LaunchDaemons/com.cloudflare.cloudflared.plist`), dialing out, TLS
  terminating at the edge. The box's `~/.cloudflared` credentials are for a
  *different* tunnel id than the running one, which uses an opaque `--token`, so
  the tunnel can only be reconfigured from the Cloudflare dashboard.
- **Nothing watches the tunnel.** `KeepAlive` only catches `cloudflared` exiting;
  if its QUIC connections fail while the process lives, the site goes dark and
  `relay.log` stays *silent* — so the autofix watchdog can't see it either.
  External `/healthz` is the only detector.
- **Cloudflare WARP is installed on the box and its daemon reports `Connected`**,
  but `cdn-cgi/trace` says `warp=off` and egress is still the home ISP (colo DUB,
  loc IE). If WARP ever starts routing, the residential IP — the foundation of the
  whole design — silently becomes a Cloudflare datacenter IP and everything 403s,
  looking exactly like an upstream redesign. Both docs now tell you to check
  `warp=off` *before* debugging a total outage.
- **The relay binds `*:8787`, not loopback** — LAN-reachable, bypassing Cloudflare.
- **The `/hls` token authorises nothing specific.** `mintToken` HMACs *only* the
  expiry, so any unexpired token proxies **any** public https URL through
  `relay.fiesta.show` for 6h — and every viewer gets a valid one in the clear.
  Binding the HMAC over `exp + u` looks like a small fix. Also: child playlist
  URLs reuse the incoming token instead of re-minting, so sessions hard-403 at
  T+6h; `assertPublicHttps` checks once while the fetch re-resolves DNS and
  follows redirects unchecked; and `s`/`e` reach the embed path unvalidated from
  public `/api/stream`.
- **…and ~770 of those tokens sit in plaintext in a world-readable log.**
  `/Library/Logs/com.cloudflare.cloudflared.err.log` (root:wheel but o+r, 4.1MB,
  unrotated, back to 2026-05-17) logs `dest=…/hls?u=…&t=<token>&ua=N`. Any local
  user on that shared box can lift a working open-proxy credential out of it.
  Rotating `RELAY_SIGNING_KEY` kills the historical ones; binding the token fixes
  the class.
- **`maxDuration: 30` vs a 75s browser solve.** `api/stream.js`'s relay fetch has
  no timeout/`AbortSignal`, while a Playwright resolve budgets 30s `goto` + 45s
  `waitForFunction` plus unbounded global lock queueing. Vercel abandons it at 30s
  → user sees 502 → but the relay finishes and caches, so their retry inside 600s
  is instant. "First play failed, second was instant" is this, not a flake.
- **`?srv=2` in the page URL does nothing.** `movie-page` reads it and binds
  `[server]`/`(serverChange)`, but the player reads `server()` zero times and
  emits `serverChange` zero times, so `onServerChange` is unreachable. The only
  thing that ever sets `srv` is the player's automatic one-shot escalation.
- **The autofix watchdog can misfire on a pure throttle**, and the only reason it
  never has is an accident: it groups by error text, and the loudest current error
  (`generate cooling globally <N>s`) hashes differently per second value, so it
  fragments below the 3-distinct-title threshold. Its filter excludes only
  `status_code 404` and turnstile, and historical counts like `embed status 429`
  (11 titles) would clear it easily — dispatching a `claude -p` with Edit/Bash to
  hunt a markup change that never happened, on the live file, with no git.
- **`relay.log` has no timestamps** on any of its ~19 `console.*` lines, which
  quietly limits every "grep the log" instruction in both docs. Cheapest available
  improvement.
- **No `Range` support anywhere** — fine for today's version-3 full-segment TS, but
  an fMP4/byterange playlist would break outright and partial segments can't
  resume.
- **The documented local-dev flow could not have worked.**
  `tools/fiesta-proxy/.env.local` holds exactly one var — the dead
  `STREAM_PROXY_URL` Webshare credential — and not the `STREAM_RELAY_URL` /
  `STREAM_RELAY_SECRET` the harness needs, so `/api/stream` would 500. The README
  now says so. **That stale credential should be deleted and rotated upstream.**
- **There is no deploy path from this repo to the box** — no rsync, scp script or
  CI. The live file is hand-edited in place. That's the root cause of the drift.
- **`tools/fiesta-proxy/relay.mjs` is worse than stale: it's dead.** It still
  greps for `src="//cloudnestra.com/rcp/…"`, so it would fail on *every* title.
  Both docs now say never to copy it over the live file.
- Upstream is **rate-limiting this IP right now** (`generate cooling globally`,
  `[breaker] srv=2 skipped` all over `relay.log`), which is why
  `RELAY_RESOLVE_TRIES` sits at 1 instead of 2–3.

### Files changed

- `tools/fiesta-proxy/README.md` — full rewrite: the 8-hop chain, the two
  different tokens, the browser fallback, every resilience mechanism with its
  real default, the HTTP surface, the token gate's actual limits, the re-trace
  procedure, and a dead-code warning on the repo snapshot.
- `docs/stream-proxy-architecture.md` — full rewrite: retitled off "(Vercel)",
  the real two-process model, the caching layers (including that Cloudflare
  returns `cf-cache-status: DYNAMIC` so segments are **not** edge-cached), cost,
  ops runbook, and a symptom → cause failure table.
- `docs/handoff.md` — this entry; marked the old "still stale" note resolved; and
  fixed a dead cross-reference in the RU/UA bullet (it pointed at research
  findings "earlier in this doc" that were never written down).

### Not done / open

- **The `relay.mjs` code drift is untouched** — still the user's call whether to
  reconcile the repo copy (several hundred lines) or delete it. Docs now describe
  reality either way.
- **Re-measured live after all** (one resolve through the public API, 2026-09-13),
  so these are now dated facts in the README rather than open questions: 3 variants
  (640×358 / 1280×714 / 1920×1072, 24fps), **zero** `EXT-X-KEY` in either playlist,
  `VERSION:3` / `VOD` / `TARGETDURATION:6` / 1708 `EXTINF`, segments at
  `/content/<32hex>/<32hex>/page-N.html?token=…` served as `video/mp2t` (570KB,
  first byte `0x47`). The 2026-05 measurements held. Two in-code comments
  overstate: "~1-2MB" segments (570KB observed) and "~5s" (`TARGETDURATION` is 6).
- Still genuinely unverified: whether the Playwright fallback works against the
  post-migration chain (needs one `RELAY_FORCE_BROWSER=1` run on the box), whether
  the cached Chrome-for-Testing build still launches, and whether
  `checkTurnstile`'s regex still matches what Cloudflare serves — if the challenge
  markup changed, detection fails *silently* and you get
  `CFG.playerUrl not found in layer2` instead, never reaching the fallback.
- `RELAY_RESOLVE_TRIES` is still at 1, so the born-dead-master re-resolve is inert
  (it logs `re-resolving (1/1)` and falls through). Raising it back to 2–3 is an
  operator decision that's been pending since the throttling started.
- A Cloudflare Cache Rule on `/hls` could offload repeat segments to the edge, but
  it needs a cache key ignoring `t`/`ua`. Untested, noted as an opportunity only.
- The `STREAM_PROXY_URL` credential in `tools/fiesta-proxy/.env.local` still needs
  deleting/rotating — I did not touch the file (gitignored, never committed).

## DONE, NOT COMMITTED: scroll-to-collapse + the search page composition

Both of the "Requested but NOT started" items from the last entry are built and
verified in a real browser. **Nothing is committed** — the whole change is in the
working tree.

### 1. Expanded cards collapse on a significant scroll

`MovieCollectionComponent` now watches window scroll while a panel is open and
closes it once the user has genuinely left. The listener is `passive`, registered
inside `runOutsideAngular`, and attached only while a panel is open.

**The three things that make it work, none of which are obvious:**

- **Baseline is taken when scrolling stops, not at open.** The panel scrolls
  *itself* into view (`scrollPanelIntoView`), so baselining any earlier charges
  the app's own smooth scroll to the user and closes the panel on the frame it
  appeared. The watch starts disarmed and arms after `SCROLL_REST_MS` (150ms) of
  quiet, with `SCROLL_ARM_TIMEOUT_MS` (1500ms) as a ceiling so a slow continuous
  drag — which never produces a quiet period — still arms.
- **The threshold is 260px PLUS the panel's own overhang.** A flat 260px was
  wrong and would have shipped a real bug. The panel is content-sized, so on a
  360x640 Android it stands 1.2x the viewport and reaching *its own Play button*
  costs **243px** — 17px short of dismissal. Overshooting by a thumb-width would
  have collapsed the panel the user was reaching into. `armScrollWatch()` reads
  the panel rect once and adds the off-screen overhang per direction. Where the
  panel fits (desktop, iPhone 12+) both slacks are 0 and the threshold is exactly
  260px, as originally specified. Measured: SE 375x667 needs 225px, small Android
  360x640 needs 243px, iPhone 12 needs 40px, Max needs 4px.
- **Scroll is ignored while the page is scroll-locked.** The genre sheet pins
  `body { position: fixed }`, which snaps `window.scrollY` to 0 and reports the
  whole offset as one scroll event — that closed the card underneath the sheet.
  New `src/app/services/scroll-lock.ts` owns `SCROLL_LOCK_CLASS`; `bottom-nav`
  now imports it instead of repeating the literal. Arming is also deferred while
  locked, or the rect would be read off a pinned layout.

Also fixed while in there: `close()` never cleared `scrollTimer`, so closing a
card within 480ms of opening it left a stale timer that scrolled to the
collapsing panel *and* started a watch nothing would ever stop.

Horizontal shelf scrolling does not dismiss — element scroll events do not reach
`window`, which is why the watcher is on `window` and not delegated.

### 2. Search page: the field moved into the page body

The input is out of the navbar entirely on `/search` (`<app-navbar>` with no
inputs), and is now the first element of the page's own content column, with the
heading above it and a single caption line below that rewrites itself: prompt ->
"Searching..." -> "**48** results" -> "Nothing matched". That caption replaces
the old stray `{{ totalResults }} results found` label. The heading collapses
`grid-template-rows: 1fr -> 0fr` when a query arrives (not `max-height`, which
needs a ceiling that overshoots the content and therefore stalls then snaps).

The control itself was rebuilt as one continuous surface — the old markup was an
input and a button glued edge to edge with **mismatched radii** (`rounded-s-lg`
against `rounded-e-md`), `dark:bg-slate-900` (blue-grey) on a near-black page and
`dark:text-gray-400` for typed text. It is now `#121212` with a 16px radius,
concentric 10px inner buttons at a 6px inset, indigo focus ring, a clear button,
and an indigo submit chip that is `hidden sm:flex` (on a phone `enterkeyhint`
already puts Search under the thumb, and two opposite-outcome 44px targets 6px
apart at the worst corner of the screen is a mis-tap generator).

`[surface]="'glass' | 'sunken'"` is threaded from the navbar's own `transparent()`
so the three hero pages (`/`, `/movie/:id`, `/person/:id`) get a translucent chip
instead of a solid one punching a hole in the artwork. The navbar's
non-transparent ground also changed from `bg-white dark:bg-gray-800` (#1f2937,
the last Preline light-mode artefact) to `#0a0a0a` + a hairline.

**Two real pre-existing bugs were found by the design review and fixed:**

- **One dropped request bricked the search field forever.** `performSearch()`
  sets `isLoading = true` then subscribes with `{next, error, complete}` — RxJS
  does **not** fire `complete` after `error`, and the error handler only logged.
  The input carried `[disabled]="isLoading"`, so a single failed request on
  cellular left it permanently disabled with a spinning button and no recovery
  short of a reload. The handler resets the flag, and the input no longer takes
  `[disabled]` at all (disabling a focused input force-blurs it on iOS and drops
  the keyboard mid-search); `aria-busy` carries the state.
- **The Search tab showed the previous query's results.** `/search?query=dune ->
  /search` is a queryParams-only change on the same route config, so the
  component is reused and `ngOnInit` does not re-run; the reset lived inside
  `if (query)`. The old markup hid this by accident because the empty prompt was
  gated on `movies.length === 0`. There is now an `else` branch that clears
  state, resets the title/meta and scrolls to top (`provideRouter` has no
  `withInMemoryScrolling`, so a forward pushState leaves `scrollY` untouched).
  `SearchBoxComponent` has the same reset, **scoped to `/search`** — a blanket
  else is a cross-page regression, because `movie-page` navigates with
  `queryParamsHandling: 'merge'` three times and each emission would wipe
  whatever the user had typed into the header box.

Smaller fixes in the same pass: a stale-response guard in `fetchSuggestions` (a
slow page-1 "bat" could land on top of a newer "batman"); the dropdown sized from
`visualViewport` via a `--sf-dd-max` custom property (a `vh` clamp cannot work —
the iOS layout viewport does not shrink when the keyboard opens); `role="listbox"`
moved onto the `<ul>` whose children are actually options; the BMC widget hidden
while the field is focused (z-index 9999999, directly over the last suggestion
row); per-instance ids replacing the hardcoded Preline one; and the suggestion
scrollbar thumb, which was black behind `prefers-color-scheme: dark` even though
this app is `darkMode: 'class'` with `<html class="dark">` always on.

### Verification

**213 browser checks, 0 failures** (up from 181) and **69 unit tests passing**.
New `tools/e2e/scrolldismiss.mjs` (31 checks, run 3x for flakiness) covers the
threshold in both directions, the panel's own scroll-into-view, card switching,
horizontal shelf scroll, and reduced motion.

The 5 `movie.service.spec.ts` failures are the same pre-existing ones (hardcoded
OMDB key). `NG8113 PosterComponent is not used` on SearchPageComponent is also
pre-existing — it was already unused before this change, as it is on genre,
top-rated and tv.

**Two e2e scripts had to be corrected, and both corrections are findings:**

- `mergecheck.mjs` scrolled by centring the panel's Play button — a ~400px jump
  no user makes, which the new dismissal correctly reads as leaving. It now
  scrolls the *minimum* needed to clear the tab bar, which is the honest number.
- Doing that exposed a latent wrinkle: **the panel grows ~30px about 600ms after
  it settles**, when the deferred trailer iframe mounts, which slides the Play
  button back under the bottom nav after a correctly-sized scroll. The old 400px
  jump had enough slack to hide it. The test now waits for a full second of no
  height change. Worth deciding whether the *app* should reserve that space.

### Not verified

- **Real iOS.** Everything here is Chromium at an iPhone viewport. The
  `visualViewport` dropdown measurement, the keyboard interaction and the
  `position: fixed` scroll-lock path all specifically want a real device.
- The genre chips render from live TMDB data; the mock only returns two, so the
  full ten-chip rail has not been seen.

### Open items

- `.claude/worktrees/expanding-cards` is confirmed redundant (clean, 0 commits
  not in main) but was **left in place** — removing a worktree is destructive and
  was not confirmed. Note there is a **second** worktree,
  `.claude/worktrees/agent-a377ccbc76fc80dbe` on `feat/readmore-animation`, with
  **two unmerged commits**. Do not delete that one.
- `tools/e2e/node_modules` is a symlink to a scratchpad playwright install, added
  so the ESM `import { chromium } from 'playwright'` resolves (`NODE_PATH` does
  not work for ESM). `.gitignore` only anchors `/node_modules` at the root.
- The `notfound` component's clip-art SVG is still light-mode illustration on a
  black page. Its button is now indigo; the artwork was left alone.

## SHIPPED TO PRODUCTION: mobile bottom nav + expanding movie cards (`3fb9b35`)

`main` was fast-forwarded to `3fb9b35` and pushed, so this is **live on
fiesta.show**, not just a preview. Four commits, all verified before merge:

- `f50dc8d` mobile bottom nav (branch `feat/mobile-bottom-nav-redesign`)
- `e2a7fec` expanding cards
- `05a36d4` richer panel + title stops navigating
- `d99682f` merge of the nav branch into the cards branch
- `3fb9b35` Play starts the stream + animation smoothing

Both feature branches still exist on `origin`. The worktree at
`.claude/worktrees/expanding-cards` is now redundant — remove it.

### What shipped

**Mobile bottom nav** (`src/app/components/bottom-nav/`, `sm:hidden`): four
route tabs plus a Genres bottom sheet. The navbar lost its hamburger; links and
the genre dropdown are `sm:`-and-up only, and the search box is opt-in per page
via `[mobileSearch]`.

**Expanding cards**: clicking a card opens its details in a new row directly
below that card's row, tinting the others. Rolled out to search, genre,
top-rated, tv, person credits and the four home shelves via one new
`<app-movie-collection>` (grid | row mode), which replaced ~90 lines of
duplicated markup. `MoviesGridComponent` was dead code and is deleted.

**Shared `<app-expandable-text>`** replaced the two hand-rolled Read More
toggles (person bio, movie plot).

**Person pages split acting from crew work.** `combined_credits` cast and crew
were merged, so a director's page showed films they directed beside films they
merely appeared in. Fixed in both `tmdb.service.ts` *and* `api/tmdb.js` —
production reads the pre-shaped serverless response, so client-only would have
been a no-op in prod.

**Play starts the stream.** Play buttons carry `?play=1`; the movie page scrolls
`#player` into view and `MoviePlayerComponent` autostarts.

### Hard-won findings — read before touching this code

- **`modestbranding=1` is a no-op** (deprecated Aug 2023) and `rel=0` only
  narrows related videos. Neither removes YouTube chrome. What works: the
  player wrapper is *taller* than the 16:9 box (`top/bottom: -60px`) so the
  title bar and bottom strip fall into cropped black margins — the video
  letterboxes centred, so **no picture is lost**; `pointer-events: none` on the
  iframe kills the hover overlay; and the backdrop is held `CHROME_SETTLE_MS`
  (4500ms) after playback starts because the centre play/pause glyph cannot be
  cropped. Those numbers came from screenshotting the player over time — the
  assertions were passing while the branding was still plainly visible.
- **Use the IFrame Player API, not raw postMessage.** The raw protocol needs a
  `listening` handshake loop and the right `targetOrigin`; `unMute()` after
  `onReady` just works. `host: 'https://www.youtube-nocookie.com'` gets nocookie
  *and* the JS API together.
- **Everything player-related runs `runOutsideAngular`.** The player posts
  progress messages several times a second and this app is zone-based with
  Default CD — each one would otherwise tick the whole application.
- **What made the open animation stutter** (all three were real): the iframe was
  being created mid-transition (creating a cross-origin iframe is enormously
  expensive — this was the bulk of it, now deferred until the panel settles); a
  `filter: saturate()` was animating on every unselected card, promoting a
  compositing layer each; and the panel lacked `contain: layout paint`. Now 0
  long frames on desktop, 1 on mobile.
- **Signals do not reduce change detection in Default-CD components.** The
  original design had every poster subscribing to a dim signal — strictly worse
  than nothing. The tint is two class bindings and pure CSS instead.
- **`PosterComponent` is OnPush with `markForCheck`.** Its old
  `detectChanges()` calls ran inside the parent's pass and throw once views are
  inserted mid-`@for`, which is exactly what the panel does.
- **Column count comes from `matchMedia`, not `getComputedStyle`.** The counts
  are hardcoded Tailwind classes, so the breakpoints *are* the source of truth;
  reading layout would also thrash on every panel open.
- **Panel is reused, not recreated, when another card in the same row is
  clicked** — hence the full reset in `ngOnChanges`, including tearing the
  player down. Miss that and the previous trailer keeps playing.
- **`NgOptimizedImage` rejects pixel values in `sizes`** (NG02952). All entries
  must be responsive units.
- **iOS scroll lock**: `overflow: hidden` alone does not hold on iOS Safari.
  The sheet also pins `position: fixed` with a saved `scrollY`, restored on
  close.
- **The BMC greeting bubble is an anonymous `<div>`** with only inline styles —
  matched on its `bottom: 16px`, and scaled via box properties (not
  `transform`, which the widget animates itself in from).

### Verification

`tools/e2e/` (untracked — see its README) holds six Playwright suites, **181
checks, all green on merged `main`**. They mock TMDB/OMDB because dev has no
API keys, but deliberately use the **real YouTube embed**.

Unit tests: **5 pre-existing failures**, unrelated — `movie.service.spec.ts`
hardcodes `apikey=a1128251` which is not in the local env. Not caused by this
work; they fail on `main` before it too.

### NOT verified — needs a real device on production

**Autoplay after navigation.** `/api/stream` is a Vercel function that does not
run under `ng serve`, so the `?play=1` autostart could never be exercised
locally. The gesture that asked for playback happened on the *previous* page
and gestures do not survive navigation, so the browser may refuse `play()` —
iOS Safari most likely. It degrades honestly (reverts to the play button rather
than sitting started-but-silent), but **go press Play on a phone and confirm.**

### Requested but NOT started — next session picks these up

1. **Collapse the expanded card on a significant scroll.** The user was
   explicit that a *little* scroll must not close it — needs an accumulated
   delta from the scroll position at open (~200-300px), in either direction,
   not any-scroll. `MovieCollectionComponent.close()` already does the animated
   teardown. Listener must be `passive` and `runOutsideAngular` or it ticks CD
   on every scroll frame.
2. **Search page: move the input bar down and make it less ugly.** The input is
   in `navbar.component.html` behind `[mobileSearch]`; the empty-state prompt is
   in `search-page.component.html`. Treat the two as one composition rather than
   styling the input alone.

### Smaller open items

- `docs/UI/` (~4MB of verification screenshots) and `skills-lock.json` are
  deliberately uncommitted in the working tree.
- Panel has **no genres from TMDB** — `/find` does not return them, so genres,
  runtime, certificate and awards all come from the OMDB details endpoint via
  the new non-publishing `MovieService.getDetailsSnapshot()`. (`getMovieDetails`
  publishes into the subject the movie page binds to — calling it from the panel
  would overwrite that page's state.)
- The movie page's own recommendations shelf still navigates rather than
  expanding; deliberate, since expanding a card while already on a movie page
  reads oddly. `[expandable]="false"` flips it.
- Console noise from the embed: `compute-pressure is not allowed in this
  document` comes from inside the YouTube iframe. Harmless, unfixable from here.


## DONE: the heart burst now actually lands on the button (`cf79bd3`)

**Branch `feat/like-heart-bloom`, committed, NOT merged, NOT pushed, NOT
deployed to production** — only to previews (`streamfiesta-iidrcbzrc` is the
current one). This closes the "NEXT TASK" written immediately below, which
should now be read as history rather than as instructions.

The report was "the animation doesn't work". It was firing the whole time:
the canvas was created, the particles animated, reduced motion was respected.
It was simply never anywhere near the button — at 120ms after the click the
hearts were already 150-300px out, scattered across the hero photo, with
nothing at the pill at any point in the ~2.8s life. **Do not re-derive the two
causes**; both were read straight out of
`node_modules/canvas-confetti/src/confetti.js` and then confirmed on pixels:

- **Travel is a geometric series**, `v0 / (1 - decay)`, with `v0` randomised
  over `[0.5, 1.5]·startVelocity`. `startVelocity: 28` at the *default*
  `decay: 0.9` is therefore up to 420px. The shipped call never set `decay`.
- **`gravity` is not an acceleration.** The library adds `3·gravity` to `y`
  once per tick, so total fall is just `3·gravity·ticks` — `gravity: 0.7` over
  `ticks: 170` was a flat 357px of rain. `ticks` are *frames*, not ms.
- **The "thin red slivers" were not 3D tumbling.** A shape from
  `shapeFromText` is a *bitmap* shape, and bitmaps draw at
  `scaleX = scalar·|cos(wobble)|`, `scaleY = scalar·|sin(wobble)|` — 90° out of
  phase, so a heart is never full size on both axes at once and twice per
  cycle one axis passes through exactly zero. **`flat: true` is load-bearing**:
  it pins `wobble` to 0 and fixes this for *any* shape. Measured 3.1× more
  visible ink with it than without.
- **`colors` is ignored for bitmap shapes** (the pattern replaces `fillStyle`),
  so the old call's palette did nothing at all. A `path` shape honours it.

What it is now: a small fan of hearts spilling out of the pill's top edge,
drawn with **the button's own heart SVG path** as a `path` shape (not the ❤️
emoji), into a **170×120 `<canvas>` parented to the button** rather than
canvas-confetti's full-viewport one. That anchors the burst by construction —
it even scrolls with the pill — and the canvas edge is then a hard bound: a
mistuned number can *clip* hearts now, it can no longer spray them over the
hero. Measured envelope ~45px up, ~44px each side, last pixel gone by 950ms.
`confetti.create()` deliberately runs on the **main thread** (no `useWorker`),
which is what lets Path2D shapes render at all.

Three things that are easy to undo by accident:
- **Emit from the button's CENTRE, not from the heart icon.** At 360px the
  pill wraps onto its own line at `x=16`, and `<main>`'s `overflow-x: hidden`
  would slice the leftmost hearts in half if the emitter sat at the icon's
  x=19. Verified at 360: leftmost lit pixel at viewport x=13, no h-scrollbar.
  Hearts do drift over the IMDb/RT row 8px above at that width — accepted,
  they still read as coming from the pill below.
- **An unlike calls `cannon.reset()`.** Without it the burst kept pouring for
  another ~1.5s out of a pill that had already gone grey and counted down.
  `burstToken` alone doesn't cover this — it only guards a burst that hasn't
  started. Measured: 0 painted pixels within one frame of the unlike.
- **The chunk is warmed on `(pointerenter)`/`(focus)`.** Cold, the dynamic
  import left ~150ms between the click and the first heart; warm it is 45ms.
  Confirmed by diffing `.js` requests: fetched on hover, fetched on click if
  there was no hover, and **never fetched at all under reduced motion** (the
  `matchMedia` check runs before the import, deliberately — the library caches
  its own reduced-motion answer at cannon-construction time and would miss a
  later change).

Costs the 2 kB `anyComponentStyle` budget **nothing** — the canvas geometry is
Tailwind utilities in the template (`w-[170px] h-[120px] -top-[70px]`,
`left-1/2 -translate-x-1/2`), mirrored by `BURST_W`/`BURST_H`/`BURST_ORIGIN`
in the `.ts`. **Change one, change both.** Stylesheet stays at 1.09 kB.

Verified on a real preview in a real browser, at 1280 and at 360: hearts
visible and heart-shaped in screenshots (not just "the keyframes advanced" —
see the lesson below), unlike cancels, 8 rapid clicks leave one canvas and
zero painted pixels, none of the library's own canvases ever reach `<body>`,
reduced motion still fills the icon, zero console errors.

**Still to do**: merge to `main`, push, `vercel deploy --prod`, re-verify on
`fiesta.show` itself. Also worth a look while there: the per-comment like
hearts in the thread got none of this and are still a plain fill toggle.

## (STALE — both branches were merged long ago, see cf79bd3 / 8f353b2) TWO BRANCHES AWAITING REVIEW

Both were finished at the end of this session and are the first thing to pick
up. Neither is pushed; `main` is untouched by either.

### (RESOLVED by `cf79bd3` above) NEXT TASK: heart confetti — use a LIBRARY, don't hand-roll

**Read this before touching `feat/like-heart-bloom`.** After that branch was
built, the user clarified what they actually wanted (in Russian): little
**hearts spilling out of the button**, possibly with a firework/confetti
effect — and explicitly *"просто возьми найди в интернете готовое, не
пытайся сейчас сам собрать это"* (take a ready-made one off the internet,
don't assemble it yourself). So the CSS burst on that branch is the **wrong
direction** — it's abstract sparks, not hearts, and it was hand-written.

Recommended: **canvas-confetti** (ISC, zero deps, measured 10,808 B raw /
4,444 B gzipped). It is the right fit for three specific reasons:
`confetti.shapeFromText({ text: '❤️', scalar: 2 })` gives real heart shapes;
`origin: {x, y}` (0-1 of viewport) makes the burst come out of *the button's*
position rather than the screen centre — convert the button's
`getBoundingClientRect()` — and calling `confetti()` repeatedly layers extra
bursts onto the same canvas, which is how you get the "салют" on top of the
hearts. Lazy-load it (`await import('canvas-confetti')`) so it stays out of
the initial bundle, exactly as `hls.js` already is.
> **Corrected by `cf79bd3`:** the library choice was right, but two specifics
> in this paragraph are not. `shapeFromText` yields a *bitmap* shape, which
> squashes to slivers without `flat: true` and ignores `colors` entirely — use
> a `path` shape built from the button's own heart instead. And a
> viewport-fraction `origin` on the library's full-screen canvas is what let
> the burst wander onto the hero photo; a small canvas parented to the button
> bounds it. See the section above.
Simpler alternative: **js-confetti** (MIT, zero deps, 8,027 B raw / 2,715 B
gzipped) — first-class `addConfetti({ emojis: ['❤️'] })` plus a
`confettiDispatchPosition` for the click point. Less control, less code.
Already ruled out and not worth revisiting: Lottie/Rive (480-752 KB brotli of
WASM that no bundle analyzer reports), the Twitter sprite (unlicensed X
artwork), party.js and tsparticles (both much heavier).

**Keep from `feat/like-heart-bloom` regardless of which library wins**: the
structural fix. The template used to swap two `<svg>` elements with
`@if (liked())`, so Angular destroyed and recreated the node every toggle and
no transition could ever run across like/unlike. Both hearts now stay mounted
and cross-fade. That is independent of the burst and is worth keeping.

### `feat/like-heart-bloom` (commits `e39566d`, plus a contrast fix) — superseded, see above

User asked for "a beautiful heart animation" and to find existing solutions
first. Researched, then rejected, all the obvious ones — **don't re-derive
this**: the Twitter sprite (`web_heart_animation.png`, still live at
abs.twimg.com, 2900×100, 29 frames, 11.4 KB) is unlicensed X artwork with its
colours baked into the PNG palette; and the modern Lottie/Rive runtimes hide
a WASM payload no bundle analyzer reports — `@lottiefiles/dotlottie-web` is
~480 KB brotli and `@rive-app/canvas` ~752 KB, versus the 12 KB and 49 KB
their JS shims advertise.

**The real finding was structural**: the template swapped two separate `<svg>`
elements with `@if (liked())`, so Angular destroyed and recreated the node on
every toggle and *no CSS transition could ever run across like/unlike*. Both
hearts now stay mounted and cross-fade. The burst is Ana Tudor's technique in
Fiesta's gradient — a disc whose border thins to nothing as it grows (reads as
an opening ring) plus one element carrying every spark as a box-shadow — which
**deletes** the six `.burst-particle` spans. 0 KB JS, no assets.
Measured live: ring 12→34px with border 6→0px, sparks scale 0→1.3, heart
0.2→1.52→0.90→1.0. Nothing fires on unlike; under `prefers-reduced-motion`
every animation reports `none` and the icon still swaps instantly.
Preview: `streamfiesta-au7vu9cx6` (earlier: `ab98r5y7r`).

**A real lesson from this branch, worth not repeating**: the burst was
verified by sampling computed styles frame-by-frame, which proved the
keyframes advanced — and it was still *invisible on screen*. Once liked, the
pill behind it is the indigo/fuchsia/pink gradient, and the ring and sparks
were those same brand colours; the pill is only 87×28 with the heart at
(19,14), so a 34px ring sat almost entirely on top of it. The user reported
"no animation I could see" and was right. A later commit switched the burst
to white/light tints with travel far enough to clear the pill. **Measuring
that an animation runs is not the same as looking at it.**
**Budget gotcha**: the CSS-only version came in 123 bytes over the 2 kB
`anyComponentStyle` budget, so `.heart`'s layout lives in the template as
Tailwind utilities. Also worth knowing: **Angular scopes `@keyframes` names**
(`_ngcontent-ng-cNNNNNN_heart-bloom`), so they can't be referenced from a
global stylesheet.

### `feat/readmore-animation` (commits `01265d5`, `752b1f3`) — built by a subagent in a worktree

Worktree: `.claude/worktrees/agent-a377ccbc76fc80dbe`. Animates the Read
More / Show Less expand-collapse on the person bio and the movie plot.
Technique is a **JS-measured pixel `height` transition** — `interpolate-size`
has no Safari/Firefox support at all, and `grid-template-rows: 0fr→1fr` needs
Safari 16 (this repo's floor is Safari 15) *and* can't express this collapse
anyway, since the collapsed state is a `line-clamp`ed 4/3 lines rather than
zero height. Verified frame-by-frame in a real browser, both directions, plus
reduced-motion and an interrupted mid-transition click.

Two things it flagged that are worth knowing before merging:
- **The movie-plot `isPlotLong = length > 400` bug ran the opposite way to
  what this doc previously said.** The plot column holds ~80 chars/line, so 3
  lines ≈ 240 chars — the 400 threshold is never reached before the text has
  already overflowed. So the button never appeared for genuinely long plots
  *and* the text wasn't clamped either. Consequence of the fix: plots between
  ~240 and 400 characters used to render fully unclamped and now clamp to 3
  lines with a working Read More. That is a visible change on those pages.
- **`/person/2963` (Nicolas Cage) throws NG0100 on `main` right now** —
  reproduced before any change. Writing the DOM measurement into a field that
  gates an `@if` flips that `@if` inside the CD pass that just checked it.
  Latent on the person page (a second `||` term usually hides it), guaranteed
  on the plot. Both now measure inside a `queueMicrotask`.
- Local dev needs more than `node scripts/set-env.js`: that script writes only
  `production` + `OMDB_API_KEY`, but `tmdb.service.ts` reads
  `TMDB_API_KEY` on the dev path, so person pages can't load locally without
  hand-adding it. Worth fixing in the script.

## Other findings from this session, not acted on

- **The `_vercel/insights` / `_vercel/speed-insights` console errors are an ad
  blocker, not a bug.** Both scripts return 200 from production (3,106 and
  12,567 bytes). The SDK's "Be sure to enable Web Analytics for your project"
  text is a generic fallback printed whenever `isDevelopment()` is false
  (`@vercel/analytics/dist/index.mjs:146`) — it is not a diagnosis. Both
  packages `console.log` unconditionally from `script.onerror`, with no
  `debug` flag, so this cannot be silenced from our code.
- **Production ships public source maps.** `angular.json`'s production config
  has `sourceMap: true`, and `https://fiesta.show/main-*.js.map` returns 200
  with the original TypeScript paths. Angular's default here is `false`.
  Not changed — it's a real trade-off against readable prod stack traces.
- **`TmdbService`'s in-memory cache poisons itself on a transient failure.**
  `cached()` fills its `Map` once and never replaces the entry, while every
  fetch does `catchError(() => of([]))` (`tmdb.service.ts:109,121,130,141`).
  So one blip caches an empty array and the homepage row stays empty for the
  whole session with no retry — only a full reload recovers. Fix: drop the
  Map entry on the error path, then add a TTL and a size cap (nothing evicts
  `genre_X_page_N` / `tv_episodes_X_S` today).
- **Homepage opportunities** were inventoried in depth. Headlines:
  `list=upcoming` is deployed AND has a written `TmdbService.getUpcoming()`
  with zero call sites; `getPopular()` is fetched on every homepage load and
  thrown away (its row was deleted in `5804afe`); every list branch already
  accepts `&page`/returns `totalPages` but `fetchList()` hardcodes page 1;
  and the player already persists watch progress that the homepage never
  reads, which makes Continue Watching the best available win.

## SHIPPED: comment spoilers + 15-minute edit window

Merged to `main` as `2d3ecad`, pushed, and deployed to production —
verified live on `fiesta.show` itself (30/30 API assertions, 11/11 on the
delete guard, a real moderation rejection, and a browser pass).
User asked for two things: mark a comment as a spoiler, and let people edit
their own comment within 15 minutes of posting.

**Spoilers.** `spoiler` is a client-set boolean stored on the comment member.
It is deliberately NOT a moderation concern — `lib/moderation.js` gets only
the text and display name, with no title or plot, so "is this a spoiler for
THIS film" is unanswerable from its inputs, and its schema has no outcome
between allow and reject (a spoiler category could only ever mean *delete the
comment*). The prompt was left untouched on purpose; don't add one later
without re-reading that reasoning. The UI renders a masked comment as its own
real text under `filter: blur(6px)` + `user-select: none` inside an
`overflow: hidden` box (the overflow matters — the blur otherwise bleeds
readable pixels outside), with a centred "SPOILER — TAP TO REVEAL" overlay.
Revealing is per-comment, page-view-local (a `signal<ReadonlySet<string>>`),
and the "Spoiler" pill that appears once revealed doubles as the re-hide
control. Note the blurred text IS still in the DOM — this is a courtesy mask,
not a secret.

**Editing.** New `PATCH /api/comments`. Enforced server-side against the
comment's own stored `createdAt`; the client's matching countdown only decides
when to stop drawing the pencil. Design points worth not re-deriving:
- **The edit re-runs moderation whenever the text changed.** Without that,
  "post something bland, then rewrite it" walks straight around the only
  safety mechanism this feature has. Verified for real against the preview:
  editing into `"the director is a cocksucker motherfucker"` came back 422
  with the model's own reason and the stored text untouched.
- **A no-op edit writes nothing** and doesn't stamp `(edited)`. This isn't
  just an optimisation: re-moderating already-approved text on a model that's
  documented as non-deterministic could 422 a comment that is already live.
- **The member swap is a Lua script** (`SWAP_MEMBER_SCRIPT`) doing
  ZSCORE → ZREM → ZADD, so the rewritten comment keeps its exact original
  score. `@upstash/redis` has no WATCH, and a `multi().zrem().zadd()` would
  ZADD unconditionally — leaving TWO members with the same comment id when
  the old one was already gone. The script returning 0 means "someone else
  changed or deleted this" → 409, which is also what stops a PATCH racing a
  DELETE from resurrecting a deleted comment (or recreating an orphaned
  `replies:{id}` set that no GET would ever read). Smoke-tested directly
  against real Upstash first, including unicode/quote/backslash byte fidelity
  through ARGV and the stale-member 0 path.
- **The new member is built from the STORED comment**, never merged with the
  request body. `id`, `clientId`, `country`, `parentId` and especially
  `createdAt` are server-owned. `createdAt` triples as the ZSET score, the
  pagination bound and the `nextCursor`, so letting an edit move it would both
  bump the comment up the feed and corrupt "Load more".
- **`editCount`, capped at `EDIT_MAX = 5`**, stored on the comment and
  stripped from GET responses. It counts ACCEPTED edits only — a rejected edit
  never reaches the write — so what it actually bounds is bait-and-switch
  (likes and replies survive an edit, so an uncapped comment could farm
  agreement and then be rewritten repeatedly). Re-submitting text until the
  non-deterministic moderator happens to allow it is bounded by the per-IP
  edit limiter instead. The first version of this comment claimed editCount
  covered both; it doesn't.
- **Edits get their OWN rate limiters** (`ratelimit:comments:edit:*`, 5/5min
  per client, 15/10min per IP). Reusing the post limiter (1 per 20s) would
  have rejected the single most common edit there is — a typo spotted seconds
  after posting — about 60% of the time, depending only on where the original
  POST fell inside a fixed 20s bucket. Separate prefixes are fully isolated
  buckets, so edits can't starve posting.

**Also hardened while in there** (adjacent, flagged rather than silent):
`commentId`/`parentId` are now validated against the UUID shape in POST and
DELETE too, not just PATCH — they get interpolated straight into Redis key
names, so before this a client could create arbitrary `replies:<anything>`
keys. And `LikesCommentsComponent` gained its first `ngOnDestroy`, which also
clears the pre-existing `burstTimeout` leak.

**Verified** (preview `streamfiesta-owpbiwzf2-nktvit.vercel.app` + real
Upstash + real browser): 30/30 API assertions, a real moderation rejection on
an edit, and a browser pass covering the mask, reveal, re-hide, the inline
edit form, the inline moderation-error banner, and the pencil correctly
disappearing on a 17-minute-old comment. All test data was removed from Redis
afterwards — `content:movie:tt0111161` is back to zero members.

**Reviewed**: an adversarial review of the diff raised 18 findings; 7 survived
a refute-first verification pass and 3 were worth fixing (commit `2239f61`):
DELETE not checking its ZREM result once edits made members mutable, a stuck
`savingEdit` after Cancel leaking one comment's result into another's editor,
and the comment metadata row overflowing on a 320px viewport — measured, the
Edit and Delete buttons sat at x=384/406, outside the viewport entirely.
**Deliberately not fixed**, all low severity: POST still creates a
`replies:<uuid>` set without checking the parent exists (pre-existing, now at
least bounded to the UUID shape); a spoiler-only flip consumes one of the 5
edits; revealing a spoiler drops keyboard focus to `<body>` because the button
it was on is destroyed; and an in-flight POST from a previous episode can be
prepended into a newly loaded thread (pre-existing, not introduced here).

**Known/accepted**: the AI Gateway free-tier limit hit repeatedly during
testing (posting through the UI returned the fail-closed banner several
times). That's the pre-existing capacity ceiling documented below, not
something this change introduced — but it now applies to edits too, so a
moderated edit can fail with "Couldn't verify this edit right now".
`lib/moderation.js`'s default `maxRetries: 2` (one call → up to 3 attempts at
the bucket it just exhausted) was deliberately NOT changed here, since it
affects the POST path equally and deserves its own decision.

---

Written at a context-limit break — this session ran from ~407k tokens (first
guard warning) to ~507k (well past it, repeated warnings) without actually
stopping, because the user kept queuing small follow-ups in the same
session. **Start the next session fresh — do not continue this one.**
Everything below is already committed, pushed, and live on production
unless marked otherwise (this session shipped directly to `vercel deploy
--prod` after every change, verified live each time — check "Next task" for
the one thing that's genuinely unverified).

## SHIPPED (continued, same day, part 3): subcomments, trailer/bio fixes, contact removal

All committed, pushed, `vercel deploy --prod`'d, and spot-checked live on
`fiesta.show` after each change — commits `130f384`, `506bce2`, `3812753`
on top of everything in the sections below.

1. **One-level-deep comment replies** ("subcomments"), user-requested.
   Backend: `api/comments.js` — replies live in their OWN Redis sorted set
   per parent (`replies:{commentId}`), NOT interleaved into the top-level
   `comments:{key}` set, specifically so top-level pagination never has to
   reason about reply timestamps. Replies are NOT paginated (fetched in
   full whenever their parent comment is) — an intentional scope cut, fine
   while reply counts stay small, would need real pagination if a thread
   ever gets huge. `handleGet` does a two-pass pipeline: pass 1 gets each
   top-level comment's like state + its raw replies in one round trip;
   pass 2 (only once pass 1's reply count is known) gets every reply's own
   like state in a second round trip. **Verified this exact two-pass logic
   against real Redis with a synthetic multi-reply fixture before trusting
   it** — sort order, like counts, and `isMine` all confirmed correct.
   `handlePost` takes an optional `parentId` and writes to the right key.
   `handleDelete` takes an optional `parentId` to know which key to search;
   deleting a top-level comment cascades to `redis.del` its whole replies
   set (individual reply `commentlikes:{id}` keys are left as harmless
   orphans — not worth an extra round trip to enumerate, noted as an
   accepted simplification, not a silent gap).
   Frontend: `Comment` gained `parentId`/`replies`; `toggleCommentLike` and
   `deleteComment` on `LikesCommentsComponent` both take an optional
   `parentId` now and patch either a top-level comment or the right nested
   reply. New `replyingTo`/`replyText`/`postingReply` signals drive an
   inline reply composer under each top-level comment; a "Reply" button
   only appears on top-level comments (no replying to a reply, by design).
   **Full flow verified end-to-end via real API calls AND a real browser
   session**: post top-level → post reply with real `parentId` → GET
   confirms correct nesting → like the reply → delete-with-wrong-clientId
   correctly 403s → delete top-level cascades away its reply → confirmed
   gone from Redis.
2. **Trailer modal flicker, user-reported** (`movie-page.component.ts`).
   Root cause: `trailerUrl` was a plain getter calling
   `sanitizer.bypassSecurityTrustResourceUrl()` fresh on every
   change-detection pass — a NEW object every time even though the
   underlying URL string never changed, so Angular saw the iframe's
   `[src]` as "changed" on every CD cycle and reloaded the YouTube embed,
   which is what read as a blink/refresh. Fixed by memoizing the
   `SafeResourceUrl` keyed on `trailerKey`, only recomputing when the key
   itself changes. **If any other `bypassSecurityTrustX` call is ever
   added as a plain getter (not memoized), it will have this exact bug —
   this is a general Angular footgun, not something specific to trailers.**
   Also added: `document.body.style.overflow = 'hidden'` while the trailer
   modal is open (user asked for scroll-lock), reset on close AND on
   `ngOnDestroy` (covers navigating away mid-trailer). Verified live: body
   overflow toggles correctly, iframe gets a stable src.
3. **Person-page "Read More" button, user-reported** (bug: showed even for
   short bios). Root cause: visibility was gated on
   `bioParagraphs[0].length > 300` — a fixed character-count guess that
   doesn't track whether the paragraph actually overflows its
   `line-clamp-4`, since real wrapped-line count depends on font size and
   viewport width, not character count. Fixed with real DOM measurement:
   a `#bioClamp` template ref + `ngAfterViewChecked()` comparing
   `scrollHeight` vs `clientHeight`. Verified with two real people: a
   short single-paragraph bio (scrollHeight === clientHeight, confirmed no
   button) and a genuine 4-paragraph bio (button correctly shows via the
   separate "more than one paragraph" condition, independent of whether
   paragraph 1 alone is clamped). **Known, NOT fixed**: `movie-page.
   component.ts`'s Plot section (`isPlotLong = adjustedPlot.length > 400`)
   has the exact same bug pattern, just never reported. Same fix
   (DOM-measure via a template ref) would apply — flagging so it isn't
   independently "discovered" as a surprise later, but out of scope for
   what was actually asked this session.
4. **Removed contact/social sections**, user-requested: the whole "Get in
   Touch" section (Telegram/X links) from `about.component.html`, and the
   "Contact" paragraph from `terms.component.html` (which pointed at that
   now-deleted section). Removing the Terms paragraph left `RouterLink`
   unused in `terms.component.ts` — removed it too rather than leave a new
   NG8113 build warning behind (this repo has previously had an explicit
   pass to be build-warning-free; didn't want to quietly reintroduce one).
   **NOT touched, on purpose**: the "Support the Project" / Buy Me a
   Coffee section on the About page — that's a donation link, not a
   contact mention, and wasn't part of what was asked.

## SHIPPED (continued, same day): UI polish + delete-your-own-comment

All of this landed AFTER the "SHIPPED: anonymous likes & comments" section
below was written — that section is now slightly stale on layout details
(it still describes the original single-block placement); this section is
the up-to-date picture. Four separate commits, each built → previewed →
verified with Playwright → merged to `main` → pushed → `vercel deploy --prod`
→ re-verified live, same discipline as everything else this session:

1. **Repositioned the like/comments UI** (user-requested layout change):
   the Fiesta like badge now lives in the ratings row next to IMDb/RT/
   Metacritic (not its own block), and the comment thread moved to below
   "You Might Also Like" instead of directly under the player.
   Mechanism: `LikesCommentsComponent` gained a `mode: 'like' | 'comments'`
   input — one component, two placements, each instance only fetches the
   data its own mode needs (`reload()` branches on `mode()`). Two
   `<app-likes-comments>` instances now exist in
   `movie-page.component.html`: `mode="like"` in the ratings `<div>`
   (~line 108-148 area), `mode="comments"` after the recommendations
   `@if` block.
2. **Fixed a real layout bug the user caught**: the homepage
   (`main.component.html`)'s navbar had `[class.top-8]="!navbar.scrolled"`
   — a 32px reserved gap for the "ad-free player" banner (see below) that
   was left behind after the banner was removed, so removing the banner
   alone didn't close the gap. Fixed by just making the navbar always
   `top-0`. **If a similar "I removed X but the spacing is still there"
   report comes up again, check for this exact pattern first**: a fixed/
   sticky element with a scroll-conditional offset class is an easy thing
   to miss when deleting the element it was reserving space for.
3. **Icon quality, user-flagged**: the movie-card hover play icon (added
   earlier this session) was visibly off-center at large size — it used a
   hand-rolled triangle path (`M8 5v14l11-7z`, copied from an existing
   "Watch Trailer" button elsewhere, where the asymmetry is less
   noticeable next to text) plus a manual `translate-x-0.5` hack that
   didn't fully fix it. Replaced with Heroicons' actual solid Play icon
   path (properly balanced on its own, no hack needed) in
   `poster.component.html`. Also swapped the like heart to Heroicons'
   matched outline/solid pair (was reusing one path with a fill/stroke
   toggle, which is a similar smell — works but isn't as crisp as the
   real matched icons).
4. **Like button redesign** (user asked for "something great" — loaded the
   `frontend-design-v2` skill for this one): liked state now uses the
   site's own established brand gradient (`from-indigo-500 via-fuchsia-500
   to-pink-500` — the exact gradient from the removed banner, repurposed
   as "Fiesta's color" instead of a generic red heart) plus a heart-pop +
   6-particle CSS burst animation (`likes-comments.component.css`) that
   fires only on liking, not unliking, not on the initial fetch. Verified
   the animation actually fires (not just "looks right in code") via a
   direct DOM check right after a real click: particles spawn, correct
   classes apply, cleanup after ~650ms, and — importantly — confirmed
   ZERO particles spawn on unlike.
5. **Comment deletion** (user-reported gap: "I cannot delete my own
   comment" — there was genuinely no delete endpoint at all, GET/POST
   only). Added `DELETE /api/comments` — body `{type, id, s?, e?,
   commentId, clientId}`, ownership-checked against the comment's stored
   `clientId` (the same anonymous identity already used for `isMine`,
   since there are no accounts). Also deletes the comment's
   `commentlikes:{id}` key. **Non-obvious implementation detail, verified
   directly against real Redis before trusting it**: `ZREM` needs the
   exact original member string, but `@upstash/redis` sometimes
   auto-deserializes a JSON member back into an object on read (same
   surprise as the GET-path pagination code hit earlier) — so the delete
   handler re-serializes with `JSON.stringify` when the entry didn't come
   back as a raw string (`rawMember()` helper in `api/comments.js`), and a
   direct smoke test confirmed this round-trips correctly (`ZADD` two
   comments as JSON strings → `ZRANGE` back → re-stringify one → `ZREM`
   with it → confirmed exactly the right one was removed). Frontend: a
   trash icon appears only on `c.isMine` comments, `window.confirm()`
   before deleting (this app has no other confirm-dialog precedent, but a
   destructive, unrecoverable action on user content warranted the extra
   step), optimistic removal with rollback on error.
   `LikesCommentsService.deleteComment()` uses `HttpClient.delete()` with
   a body (Angular supports this via the `{ body }` option).

**Also resolved in conversation, no code needed**: user asked whether a
specific live Russian-language comment ("Плохой фильм, хуйня, залупа
конская" — "bad movie, garbage, [vulgar intensifier]") was moderated
correctly. Assessed: yes — all three phrases target the MOVIE, not a
person, so per the existing pure-unargued-abuse policy (crude opinion
about the work = allowed) this should be and was allowed. Notable as a
positive signal that the moderation prompt's nuanced policy generalizes
correctly to non-English text, not just the English eval cases.

## SHIPPED: anonymous likes & comments — merged, pushed, live on production

**Merged to `main` (commit `bf53688`, merge commit on top) and pushed to
`origin/main`.** Deployed to production via `vercel deploy --prod` and
confirmed aliased to `https://fiesta.show`. Verified live on production
(not just preview): `/api/likes` responds correctly, the movie page loads
with the component rendered (`Comments (0)`, like button, identity picker),
zero browser console errors. Did NOT re-run a live moderation call against
production specifically (already verified thoroughly against the preview
earlier this session — see below — and didn't want to spend more of the
tight/erratic free-tier AI Gateway quota on a redundant check).

`feat/likes-comments` branch still exists locally (safe to delete — it's
fully merged, `git merge-base main feat/likes-comments` equals
`feat/likes-comments`'s tip).

**Full plan** is at `/Users/nick-mbp/.claude/plans/functional-percolating-pillow.md`
— data model, API contracts, component design, wireframe. Everything below is
status/deltas on top of it, not a replacement.

### What's actually done

Everything in the plan's "Implementation order" is built AND verified working
end-to-end against the real Upstash instance and a real Vercel preview
deployment (`https://streamfiesta-5rmznc5nq-nktvit.vercel.app` as of this
session's last deploy, redeployed after the moderation model swap below —
preview URLs are ephemeral, redeploy to get a fresh one):

1. **Upstash provisioned** — `KV_REST_API_URL`/`KV_REST_API_TOKEN`/etc. are
   live in `vercel env ls` (Production, Preview, Development) and pulled into
   `.env.local`. `@upstash/redis`'s `Redis.fromEnv()` picks them up via its
   `KV_REST_API_*` fallback (confirmed by reading the installed package
   source, not assumed).
2. **`lib/redis.js`** (new) — shared `Redis.fromEnv()` client.
3. **`lib/content-key.js`** (new) — `resolveContentKey` (the
   `content:movie:{id}` / `content:tv:{id}:s{s}:e{e}` builder+validator) and
   `resolveLikeTargetKey`/`commentLikesKey` (see per-comment likes below).
4. **`lib/moderation.js`** — the shared moderation call. Model is
   **`alibaba/qwen3.7-flash`**, not the plan's original
   `anthropic/claude-haiku-4.5` assumption (see "Moderation model" below for
   why). `temperature: 0` was added this session after catching a real
   non-determinism issue live (see "Known limitation" below) — don't remove
   it.
5. **`api/likes.js`** — handles BOTH movie/episode likes (`type`/`id`/`s`/`e`)
   AND, new this session, **per-comment likes** (`commentId`) through the
   same endpoint — same idempotent Set+SADD/SREM/SCARD pattern either way,
   just a different Redis key (`resolveLikeTargetKey` picks which). One IP
   rate limiter (30/min) covers both.
6. **`api/comments.js`** — GET/POST as planned, PLUS: each comment in a GET
   response now carries `likeCount`/`liked`, batch-fetched via
   `redis.pipeline()` (one round trip for the whole page, not 2 calls ×
   20 comments) — needed once per-comment likes were added.
7. **`vercel.json`** — both functions added (`memory: 1024, maxDuration: 15`,
   matching house style; note Vercel now warns `memory` is ignored under
   Active CPU billing — harmless, matches the other pre-existing entries,
   not something to fix here).
8. **`src/app/services/likes-comments.service.ts`** (new) — `getLikes`,
   `toggleLike`, `getComments`, `postComment`, `toggleCommentLike`. Owns the
   `fiesta:client-id` localStorage identity, same pattern as
   `movie-player.component.ts`'s `SUBTITLE_PREF_KEY`.
9. **`src/app/components/likes-comments/`** (new) — `LikesCommentsComponent`,
   signals/effect-based, refetches on `imdbId`/`type`/`season`/`episode`
   change (verified: TV episode switch gets an independent thread — this was
   an explicit design requirement, confirmed correct both by code inspection
   of the content-key scheme and is safe to state with confidence even though
   it wasn't separately browser-tested this session).
10. **Wired into `movie-page.component.html`/`.ts`** — one
    `<app-likes-comments>` after both player blocks, before recommendations.
11. **Per-comment likes** (added mid-session, NOT in the original plan doc —
    the user asked for it after seeing the like/comment separation question).
    Each comment gets its own like button/count in the UI
    (`toggleCommentLike` in the component, heart icon next to each comment in
    the template).
12. `ng build` clean, no new warnings.

### Verified this session (real Upstash + real deployed preview + real browser)

- Redis command semantics smoke-tested directly against production Upstash
  before trusting them in the endpoints: SADD/SREM/SCARD/SISMEMBER toggle
  correctly; the `ZRANGE key max min BYSCORE REV LIMIT offset count` argument
  order (note: max BEFORE min when REV is combined with BYSCORE — easy to get
  backwards) paginates correctly; `@upstash/redis` **auto-deserializes** JSON
  string members back into objects on read (the `typeof entry === 'string' ?
  JSON.parse(entry) : entry` guard in `api/comments.js` is load-bearing, not
  defensive-programming excess — confirmed both cases actually occur);
  `redis.pipeline()` batches many commands into one round trip correctly.
- `/api/likes` GET/POST round-tripped correctly against a live preview via
  curl (like → count 1 → reload GET shows liked:true → unlike → count 0).
- `/api/comments` fail-closed path confirmed for real: an actual
  `GatewayRateLimitError` from the AI Gateway (see below) was caught, logged
  server-side, and returned as a `422` with **nothing saved** — the safety
  mechanism's failure mode was exercised for real, not just code-reviewed.
- Full browser flow via `playwright-cli` against the preview: like button
  toggles optimistically AND persists across a real page reload (same
  browser/localStorage); posted a real comment in "Random name" mode
  (generated "Curious Tiger"), it appeared immediately with the correct
  🇮🇪 flag (`title="Ireland"` via `Intl.DisplayNames`), "(you)" marker, and
  "just now" timestamp — the whole identity→moderation→save→render chain
  confirmed live, not just unit-level.
- All test data (comments, comment-likes, content-likes) created during this
  session's testing was cleaned out of the real Redis instance afterward —
  `content:movie:tt0111161`'s likes/comments keys are back to empty. Confirm
  this is still true before treating any pre-existing data on that key as
  real user data.
- NOT separately browser-tested this session: TV episode-switch independence
  (only verified by code/key-scheme inspection, not a live click-through),
  and the `[Load more]` pagination cursor (only smoke-tested directly against
  Redis with synthetic data, not through the actual API+UI).

### Moderation model (changed from the plan, with real findings — changed AGAIN mid-session)

The plan assumed `anthropic/claude-haiku-4.5`. Reality, confirmed by actually
calling each model against the AI Gateway this session:

- **Paid-only on this account's free tier** (immediate rejection, not a rate
  limit — don't bother retrying these without adding billing):
  `anthropic/claude-haiku-4.5`, `google/gemini-3.5-flash-lite`,
  `deepseek/deepseek-v4-flash-0731`.
- **`google/gemma-4-31b-it`**: available, but confirmed TWICE to unreliably
  omit the schema's `reason` field entirely (`generateObject` throws a schema
  validation error) — not usable for this feature, since showing the user
  *why* a comment was rejected is the point.
- **Actually usable on the free tier**: `openai/gpt-5.4-mini`,
  `openai/gpt-5.4-nano`, `alibaba/qwen3.7-flash`, and
  `inclusionai/ling-3.0-flash-fin` (this one needed several separate attempts
  across the session before finally getting a real answer instead of a rate
  limit — don't conclude a model is broken from one rate-limited attempt).
- **Currently wired up: `openai/gpt-5.4-nano`** (switched from
  `qwen3.7-flash` mid-session — see head-to-head finding below).
- **CORRECTED (had this wrong earlier in this same doc): per Vercel's own AI
  Gateway docs, the free-tier rate limit is PER-MODEL, not account-wide.**
  It felt account-wide this session for two explainable reasons, not because
  the docs are wrong: (1) the `ai` SDK auto-retries a `429` up to
  `maxRetries: 2` (3 attempts total, ~2s/4s backoff) by default — so a
  single rate-limited call immediately burns 2 more attempts against the
  exact quota it just exhausted, right when it's least likely to have
  recovered, which cascades into "everything downstream in the same run also
  fails"; (2) per the docs, "a `429` on either tier may come from the
  upstream provider rather than from AI Gateway" — so testing a fresh model
  right after exhausting a different one can coincidentally hit a real
  provider-side limit too. **Don't re-litigate the shape of this limit
  further** — it's genuinely erratic run-to-run (sometimes ~5 calls succeed
  then the rest of that run fails; sometimes even with 15s pacing between
  calls — see `scripts/moderation-evals.mjs`'s `CALL_GAP_MS` — the very
  first call fails while later ones succeed) and Vercel's own docs say this
  is expected free-tier behavior, not a bug to fix client-side. **The real,
  documented fix**: buying AI Gateway Credits moves the team to the paid
  tier, which removes AI Gateway's rate limit entirely (only the
  underlying provider's own, typically much higher, limit remains) — this
  is the exact mechanism behind the error message's own "upgrade to paid
  credits" suggestion. Production impact if this ships without adding
  billing: real visitors posting comments could occasionally see "Couldn't
  verify this comment right now" during traffic clusters — not a
  correctness bug (the fail-closed design is intentional), just a capacity
  ceiling.
- **Eval suite status: NOT a clean 10/10 on any single run yet**, across
  several attempts on two different models, purely due to the rate limit
  above (not prompt/logic failures — every case that actually got a real
  answer either passed or, in the one exception below, revealed a real
  finding). Don't trust any "N/10 passed" count from a single run as the
  full picture — cross-reference which specific case IDs got real answers.

### Head-to-head finding: qwen3.7-flash missed a real hate-speech case, gpt-5.4-nano caught it

The `hate-speech-placeholder` eval case (fictional "Zorbians are subhuman
vermin... wiped out" — see `scripts/moderation-evals.mjs`'s own comment on
why it's fictional, not a real slur) is supposed to be rejected under policy
category 4. On one run, `alibaba/qwen3.7-flash` returned `allowed: true` for
it with no reason given — a genuine miss on the most severe rejection
category, not just a borderline-case judgment call. Given the exact same
input (same prompt, same `temperature: 0`), `openai/gpt-5.4-nano` correctly
returned `allowed: false` with a clear reason ("extreme hateful
dehumanization and calls for harm against a group"). That's the reason for
the model switch. **Caveat**: this is one head-to-head data point on one
case, not a full comparative eval (the rate limit prevented a real 10/10 run
on nano too — confirmed passing on nano so far: `clean-positive`,
`harsh-profane-substantive`, `pure-unargued-abuse`,
`hate-speech-placeholder`). Also worth holding loosely: it's possible qwen's
miss was itself non-determinism (see below) rather than a systematic
weakness — one more reason not to over-index on a single sample per model
before the rate limit lets a real multi-run comparison happen.

### Known limitation: moderation is not perfectly consistent — real, observed

**This is not a code bug, don't try to "fix" the API for it.** Confirmed
live this session: the exact text `"you people are all idiots lol get a
life"` was correctly rejected by `scripts/moderation-evals.mjs` (case
`insult-no-movie-content`), then, minutes later, the SAME text was posted
through the real UI on the live preview and got `allowed: true` from the
same model (`qwen3.7-flash`, before the switch to nano) — confirmed via
`vercel logs` that no error occurred, i.e. the model itself gave a different
verdict on a near-identical borderline case. This is inherent to using an
LLM as a binary content gate on subjective "is there a real point here"
judgments — it will not be perfectly deterministic. Mitigation applied:
`temperature: 0` added to the `generateObject` call in `lib/moderation.js`
(was previously unset, so running on default sampling variance) — reduces
but does not eliminate this. If borderline-case flip-flopping becomes a real
user complaint later, the next lever is a stricter prompt or a
second-opinion re-check on borderline verdicts, not just temperature.

### Moderation policy (clarified with the user in an earlier session, not just my assumption)

Don't re-derive or second-guess this: **profanity, harsh criticism, and
political/ideological opinions are ALL allowed, however crude.** Reject ONLY:
spam, gibberish/random-character noise, "pure unargued abuse", or extreme
dehumanizing hate speech. The pure-unargued-abuse line, refined THIS session
after the first prompt draft failed its own calibration case: it's not about
whether the comment *explains* its opinion (a bare "Awful movie." is
allowed) — it's **critique of the work vs. a vulgar personal insult at a
person** (director/actor/other commenters) **with no critique of their work**.
*"the director is a cocksucker motherfucker"* → rejected (personal insult,
no critique of his directing). *"half the cast can barely act"* → allowed
(crude, but it's a critique of the acting, i.e. the work). Both calibration
cases now pass with this wording — see `lib/moderation.js`'s `SYSTEM_PROMPT`
(category 3) for the exact text, and `scripts/moderation-evals.mjs` for the
regression cases (now paced 15s apart between calls — `CALL_GAP_MS` — since
firing 10 calls back-to-back was itself partly why full runs kept failing;
see "Moderation model" below for why pacing alone still isn't a complete
fix). See that section for the real, current per-case pass/fail picture —
don't trust a bare "N/10 passed" count from a single run, and don't
re-derive case-by-case status from scratch; it's tracked there.

### Country-of-origin (added mid-plan, already folded into the approved plan doc)

Comments show the country they were posted from. Mechanism (verified against
current Vercel docs, not assumed): `req.headers['x-vercel-ip-country']` on
the classic Node `(req, res)` handler style this project's `api/*.js` files
use — NOT the `@vercel/functions` `geolocation()` helper, which expects a
Fetch `Request` object and doesn't fit this project's handler style. Store
the 2-letter code per comment; derive the flag emoji client-side (Unicode
codepoint math) and the country name via `Intl.DisplayNames` — no new
dependency for this part. Absent/`null` in local dev (header only exists on
real Vercel edge traffic).

## Small fixes batch (earlier in this session, same day as the relay work above)

All merged to `main` (`88b38be`/`9cfef24`/`4b8dbce`/`f7b8b1d`), deployed, and
verified on `fiesta.show` itself:

1. **Cast row now wraps into multiple lines** instead of horizontal-scrolling
   (`movie-page.component.html`) — matches the Directors row right above it,
   which already wrapped correctly. A subagent did the actual edit
   (mirrored Directors' `flex flex-wrap gap-4` + dropped `flex-shrink-0`);
   verified visually on both preview and prod.
2. **Two build warnings resolved**: removed `SearchBoxComponent` from
   `MainComponent`'s imports (dead — not used in its template; `NavbarComponent`
   already imports it for its own template) — fixed the NG8113 warning. Bumped
   `tsconfig.json`'s `target`/`useDefineForClassFields` to `ES2022`/`false`
   explicitly — the Angular CLI's esbuild builder was silently overriding these
   on every build anyway (real ECMA-version control for the shipped bundle is
   via Browserslist, not tsconfig `target` — confirmed by reading
   `node_modules/@angular/build/src/tools/esbuild/angular/compiler-plugin.js`),
   so this just stops the pointless warning without changing any build output.
   Verified: `ng build` warning-free, Karma test suite (`ChromeHeadless`, needs
   `CHROME_BIN` pointed at the installed Chrome.app — not on PATH by default)
   shows the same pre-existing 30-pass/5-fail split before and after (the 5
   failures are `movie.service.spec.ts` expecting a hardcoded OMDB API key
   that's blank in this local dev env — unrelated, pre-existing, confirmed via
   `git stash` + re-run).
3. **Legacy-browser routing broadened** (`middleware.js`): previously only
   UAs containing the literal substring `"Tizen"` got routed to the `/lite`
   (React 17, Chrome-47-floor) bundle. Any other engine old enough to lack
   `Proxy` (added Chrome 49 — Zone.js needs it) but not TV-branded — old
   Android TV boxes, other smart-TV browsers, or literally any UA reporting
   `Chrome/<49` — fell through to the modern bundle and would have failed to
   load. Added a second check: parse the Chrome major version from the UA,
   route to `/lite` if `< 49`. Verified with spoofed UAs via curl against both
   preview and prod: modern Chrome → real app, Chrome 48 (no Tizen token) →
   `/lite`, Chrome 49 (boundary) → real app, Tizen → still `/lite`.

**Separately, in-conversation only (no code written yet)**: user asked about
storage for an anonymous likes/comments feature and confirmed **Upstash
Redis** (atomic `INCR` for likes, a per-movie sorted set of JSON comment blobs
for comments, `@upstash/ratelimit` for anonymous-abuse throttling) — not yet
provisioned, do that via `vercel integration add upstash` per the
`vercel:marketplace`/`vercel:vercel-storage` skills, not a hand-rolled client.
Also confirmed: Vercel AI Gateway gives every team **$5/month free credits**
(zero markup, OIDC auth via `vercel env pull`) — earmarked for a simple
LLM-based moderation call on those comments; not yet implemented.

**Also noticed, not yet acted on**: `git push` warned the GitHub remote moved
— `origin` still points at `github.com/nktvit/streamfiesta-client.git` but
GitHub now redirects it to `github.com/nktvit/fiesta.show.git`. Push/pull
still work via the redirect, but worth updating the remote URL
(`git remote set-url origin ...`) at some point so it's not relying on that.

## Continuation: video preload / relay (this session)

User's ask: *"can we improve preloading? anything to do with the relay
itself?"* Investigated `tools/fiesta-proxy/relay.mjs` fresh (per the prior
session's note not to trust secondhand understanding) and found a real issue:
`handleHls`'s segment path buffered the **entire** upstream response
(`Buffer.from(await upstream.arrayBuffer())`, ~1-2MB) before sending any bytes
to the browser — the actual thing capping how fast the play buffer built
ahead.

**Shipped, merged to `main` (`5b35be2`/`453fb16`) AND deployed live to the
actual relay process — both halves confirmed working end-to-end:**

1. `movie-player.component.ts`: enabled hls.js's `progressive: true`, so
   fragments append to the buffer as they stream in rather than waiting for
   the whole response.
2. The relay's segment path now pipes the upstream body straight through
   (`pipeline(Readable.fromWeb(upstream.body), res)`) instead of buffering
   the whole ~1-2MB response first — cuts time-to-first-byte per segment,
   pairs with #1. Also aborts the upstream fetch if the client disconnects
   mid-download (seek/tab-close), and no longer forwards upstream's
   `Content-Length` for segments.
3. Ran an adversarial-review workflow on the diff before shipping. It caught
   a real, reproduced bug: forwarding upstream's `Content-Length` verbatim
   while streaming a `fetch()`-decoded body is unsafe, because Node's `fetch`
   transparently decodes `Content-Encoding` (gzip/br) but the header still
   reports the **pre-decode wire length** — a mismatch would corrupt HTTP
   framing on the keep-alive connection. Fixed by just not forwarding it.
   Also fixed a minor related issue: an unguarded `AbortError` from the
   playlist branch's `upstream.text()` would log as `[relay] unhandled` on
   ordinary client disconnects; now suppressed in the outer handler.

**Important: I initially assumed I had no way to deploy/test the relay half
and said so in this doc — that was wrong, and the user corrected it
mid-session.** There IS SSH access: `ssh mm` reaches the home Mac mini (user
`ms`). Use it. What actually happened once I checked:

- The relay does **not run from this git repo at all** — it's a standalone,
  ungitted deployment at `/Users/ms/Server/relay.fiesta.show/relay.mjs` on
  the Mac mini (`git status` there: "not a git repository"). The process
  (`show.fiesta.relay`, a launchd service, currently pid found via
  `ps aux | grep relay`) is started via
  `launchctl kickstart -k gui/$(id -u)/show.fiesta.relay`.
- That live file is **975 lines / ~39.5KB**, vastly beyond this repo's
  342-line/~13KB copy: it has a multi-hop resolver chain (`walkFromEmbed`,
  `walkFromLayer2`, `extractPlayerIframeApi`, `decryptStreamUrls`,
  `getHostToken`), a real Playwright-driven (`playwright-core`, `chromium`)
  headless-browser Turnstile fallback, per-request UA rotation carried
  through child URLs, a `/resolve` result cache, and `srv=1/2` front
  selection — i.e. the `vsembed.ru`/headless-browser features that
  `api/stream.js`'s commit messages describe DO exist, just never in this
  repo's copy. **The repo's `relay.mjs` is not a mirror of production and
  hasn't been for a long time** — it appears to be a much older/simpler
  snapshot that was never kept in sync. Nothing currently syncs them.
- Confirmed via `.autofix/` on the box: there's also a launchd-scheduled
  watchdog (`show.fiesta.relay.autofix`, every 5 min) that greps `relay.log`
  for a "same resolve error across ≥3 distinct titles" signature and, if it
  fires, invokes a **headless `claude -p` agent with a $3 budget** to
  autonomously diagnose, patch `relay.mjs` live, restart the service, and
  verify — with instructions to revert and log "NEEDS HUMAN" if it can't
  verify clean. This has **never actually triggered** (no
  `.autofix/autofix.log` exists at all) — the drift described above predates
  it and was hand-written directly on the box. Worth knowing this exists
  before anyone else touches that file: check `.autofix/checkpoint`/lock
  state for an in-progress run before editing, mirror its own verification
  procedure (`node --check`, `launchctl kickstart -k`, curl `/resolve` +
  fetch the returned master, tail `relay.log`) after editing, and back up
  the file first (no git = no free rollback) — I did all of this.
- Given the structural gap, I re-applied the *same* streaming/Content-Length/
  abort fix directly to the live 975-line file (not a copy-over of this
  repo's version, which would have silently deleted the resolver chain,
  headless fallback, cache, and UA rotation — backed up first
  (`relay.mjs.bak-20260907T181342Z`, still on the box), edited, verified
  `node --check` locally and on the box, restarted via `launchctl kickstart
  -k`, then verified live: `/resolve` for both a movie and a TV episode,
  fetched the real master playlist + a media playlist + an actual segment
  through the public `relay.fiesta.show` domain (valid MPEG-TS, 400KB, no
  bad Content-Length), tailed `relay.log` for a clean restart with no new
  errors, and confirmed real browser playback with Playwright directly on
  `fiesta.show` afterward (playing, buffered 120s ahead within 8s of
  pressing play, no errors). **Both halves of this fix are now actually live
  and verified**, not just committed to git.

**Open item, not yet acted on:** the repo's `tools/fiesta-proxy/relay.mjs`
is now confirmed stale/non-representative of production and will keep
drifting from whatever the autofix agent or manual edits do next. Worth
asking the user whether they want the git copy properly reconciled with the
real file (a much bigger diff than today's — the resolver chain alone is
several hundred lines) or just left as a rough reference.

**(RESOLVED — docs only, see "DONE: extraction docs reconciled against the live
relay" at the top of this file)** The two
extraction docs were stale in the way described here;
`docs/stream-proxy-architecture.md` and `tools/fiesta-proxy/README.md` have
both now been rewritten against the live 1089-line file. The *code* drift —
`tools/fiesta-proxy/relay.mjs` vs the box — is still open and still the
user's call.

## Live and verified in production (prior session)

All merged to `main`, deployed, and confirmed working on `fiesta.show` itself
(not just previews):

1. **Legacy-TV support** (`tv/` dir, `middleware.js`) — a separate downleveled
   React 17 client served to Tizen 3.0 (2017 Samsung TV) browsers via Vercel
   Routing Middleware, since Angular 20/Zone.js needs `Proxy` (unavailable on
   that engine). Root path handled correctly (middleware runs pre-cache,
   unlike declarative `vercel.json` rewrites which lose to static-file
   precedence for `/`).
2. **Movie/person link previews** (`middleware.js`) — crawlers (iMessage,
   Slack, Discord, ...) never ran the Angular JS that fills in real
   title/poster/description, so every shared link showed the generic site
   card. Middleware now intercepts fresh `/movie/:id` and `/person/:id`
   navigations, fetches real metadata (handles both IMDb-style and numeric
   TMDB ids — most internal links use the latter), and injects it into the
   served HTML before it's ever seen.
3. **Speed Insights per-route tracking** (`app.component.ts`) — was installed
   but only initialized once at boot; since this is a client-routed SPA every
   Web Vital was attributed to whichever route loaded first. Now hooks
   `Router.events` to call `setRoute()` on every navigation.
4. **Middleware runtime** — moved off the now-deprecated edge runtime to
   Node.js (`runtime: 'nodejs'` in `middleware.js`'s config), per Vercel's own
   build-time warning.
5. **Subtitle 403 retry** (`api/subs.js`) — OpenSubtitles' search API
   intermittently 403s (confirmed transient: same request retried immediately
   succeeds). Added to the existing retryable-status set.
6. **Subtitle background preload + two real browser bugs fixed**
   (`movie-player.component.ts`) — see "Subtitle system" below, it's the
   meatiest change and worth reading before touching that file again.

Housekeeping done: merged/dead branches deleted (both local and `origin`) —
`feat/legacy-tv-support`, `feat/link-preview`, `feat/movie-page-redesign`,
`feat/person-link-preview`, `feat/person-pages`, `feat/person-search`,
`fix/tv-routing`, `worktree-movie-page-redesign` (+ its `origin` copy, an
abandoned April redesign attempt superseded by the real one). `.gitignore` now
actually excludes `.playwright-cli/**` (it didn't before, despite an earlier
session believing it did — that's why stray test-artifact cleanup kept
recurring).

## Open decisions — nothing urgent, just unresolved

- **`origin/feat/new-player`** (remote branch, never merged) — investigated
  thoroughly. Verdict: **fully dead, safe to delete**. 9 of its 10 commits
  already reached `main` independently under different SHAs (same
  author/timestamp, byte-identical diffs — someone cherry-picked most of it
  at some point without a real merge). The 10th ("stagger subtitle reveal")
  was superseded by a better fix that's also already on `main`. User has not
  yet said "yes, delete it" — just ask, it's a rubber stamp.
- **`feat/audio-quality`** (local branch, `876f2cf`) — Web Audio loudness
  normalization for the player (measures LUFS from the HLS master playlist's
  custom tag, applies a clamped gain boost via `GainNode`). Merges cleanly
  onto current `main`. User tested it live and "didn't notice the
  difference" — parked, not rejected. Don't merge without asking again.
- **`feat/mobile-bottom-nav`** (local-only, never pushed, ~5 months old) — a
  complete bottom-nav + search-overlay component predating the movie-page
  redesign. `main` has no bottom nav today. Merges cleanly but is stale
  relative to everything built since — revisit design fit before reviving it,
  don't just merge it.
- **RU/UA streaming sources + Jellyfin — both purely conversational this
  session, ZERO code written for either.** Don't start building either
  without the user explicitly asking again; here only so the context isn't
  lost.
  - RU/UA aggregators (HDRezka/UAKino/Filmix) were researched as a possible
    vidsrc-style addition for non-English content. **The findings are NOT in
    this doc** — a background agent produced them in-conversation and they
    were never written down anywhere, so they are effectively lost; an
    earlier version of this bullet pointed at "the research findings earlier
    in this doc", which was a dead reference. Re-run the research if this
    comes back. **Since then the user mentioned HDRezka
    "recently introduced premium mode"** — i.e. it may no longer be as freely
    resolvable as the research assumed; treat that research as partially
    stale if this comes up again, re-verify before acting on it.
  - Separately, the user is considering paying for shared access to someone
    else's Jellyfin/Plex server via Reddit reseller communities (e.g.
    r/JellyfinShares — pasted a few concrete listings this session:
    BingeKings, PrimeHub, Plexify). Established with the user: this is
    fundamentally different from vidsrc/HDRezka (a self-hosted media-server
    API you'd become a *client* of, not a public embed to scrape) and only
    works as a **personal, gated feature** given the tiny concurrent-stream
    caps these resellers impose (Plexify: 2 streams for $50/yr) — not
    something to wire into the public movie pages. User is still comparing
    options, hasn't purchased anything, explicitly said not to shop-compare
    resellers for them (unverifiable anonymous sellers, a personal trust
    call). **Next step is entirely user-driven**: if they come back with an
    actual server URL + API key, Jellyfin has a real documented REST API
    (auth, then `/Items` to browse, `/Videos/{id}/stream` to play) — a much
    more straightforward integration than the vidsrc/cloudnestra resolver
    chain, no headless-browser/Turnstile work needed.

## Next task

None queued — everything explicitly asked for this session is shipped and
verified live (see the three "SHIPPED" sections above, newest first).
**This doc was written at a severe context-guard break (~507k tokens) —
start the next session fresh, don't continue this one.**

Nothing is blocking; if the user doesn't bring anything new, the honest
list of not-yet-done items from this session is: moderation eval suite
still not a clean confirmed 10/10 due to the AI Gateway free-tier limit
(see "Moderation model" above); TV episode-switch independence and comment
pagination are only code-verified, not click-tested live; the reply
feature's replies aren't paginated (fine at small scale, noted as a cut);
movie-page's Plot section has the identical "Read More shows when it
shouldn't" bug just fixed on the person page, never independently reported
though. Also still parked, unless the user brings it up again: the RU/UA
streaming-source research and the Jellyfin-reseller idea (both purely
conversational, zero code). See "Continuation: video preload / relay"
further below for one
older loose end (confirm the user restarted the relay process, and ask
about the `relay.mjs`/`api/stream.js` drift).

## Subtitle system — architecture notes (for future work in this file)

`movie-player.component.ts`'s subtitle handling changed significantly this
session. Current model, in case it needs touching again:

- `vttCache` (a `signal<Map<string,string>>`) is the **only** source of truth
  for whether a `<track>` has real content — keyed `lang::label`, values are
  `blob:` URLs of already-fetched VTT text. There is no more
  `loadedSubtitleKeys` / raw-network-src fallback path; it was removed
  entirely because it was unreliable (see next point).
- **Real, reproducible browser bug found and worked around**: a `<track>`
  element whose `src` attribute is assigned dynamically *after* the element
  already exists in the DOM can **silently never fetch** — confirmed by
  direct repro (toggling `.mode`, even re-touching the exact same `src`
  value, did nothing; only ever assigning a track a `src` it didn't already
  have reliably triggered a load). Fix, applied in two places:
  1. The default/restored track is fetched *before* its `<track>` element is
     even created (`loadSubtitles()` awaits `prefetchTrack()` first).
  2. The on-demand path (`wireSubtitlePersistence`, `assignTrackSrc()`)
     assigns a resolved blob URL directly via `el.setAttribute('src', ...)`
     rather than trusting Angular's reactive `[attr.src]` binding to have
     committed to the DOM by the time the code acts on it.
- **Second, related race**: `applySubtitlePreference()` runs off an
  `effect()` watching `subtitleTracks()`, which can fire before a freshly
  (re-)rendered track list (episode switch) has actually committed to the
  DOM — silently no-op'ing. Fixed by re-applying once more after a
  `queueMicrotask`.
- Series correctness: `vttCache` is fully cleared and all its blob URLs
  revoked on every `loadStream()` call (covers episode switch, retry, server
  escalation) — critical, since the cache key carries no episode identity and
  a stale entry would silently show the wrong episode's subtitles under the
  same language label. Verified repeatedly across real episode switches.
- **Known external constraint, not a bug in our code**: under this session's
  testing volume, OpenSubtitles' *download* host (`dl.opensubtitles.org`,
  distinct from the search host) started 502ing every request specifically
  from this Vercel project's egress IP, while the identical file succeeded
  instantly from an unrelated IP — a real IP-level rate-limit/block, not
  per-request flakiness. `PRELOAD_GAP_MS` was set to 800ms (from 400ms)
  accordingly. Vercel's CDN caches each VTT file 30 days, so real
  steady-state traffic hits the download host far less than concentrated
  testing does, but this is a genuine fragility of relying on a free legacy
  service — don't be surprised if it recurs, and don't assume more
  client-side tuning alone fixes it.

## Working style notes for whoever picks this up

- Every feature this session went: branch → build locally → deploy a Vercel
  *preview* → verify with real Playwright browser tests (not just curl) →
  merge `--no-ff` to `main` → push → wait for the production deployment to
  finish building → verify again directly on `fiesta.show` (not just the
  preview URL). Keep doing this — it caught real bugs every time it was done
  thoroughly (the `<track>` src-timing bug above was found *because* of this,
  not despite it).
- `vercel curl <url>` for hitting preview deployments (deployment protection
  is disabled for this project's previews, but `vercel curl` handles it
  either way). Plain `curl` works fine against `fiesta.show` directly.
- `playwright-cli` leaves `.playwright-cli/` artifacts in the cwd — now
  actually gitignored, but still worth `rm -rf`'ing when done to keep the
  working tree clean for `git status` checks.
- **`tools/fiesta-proxy/relay.mjs` (this repo) is NOT the production relay**
  and merging a change to it does **not** deploy anything — it's not part of
  the Vercel build (nothing in `vercel.json` references it). The real, much
  larger relay lives ungitted at
  `/Users/ms/Server/relay.fiesta.show/relay.mjs` on the home Mac mini and is
  reachable via **`ssh mm`** (user `ms`) — use it, don't assume no access.
  To ship a relay change: `scp` the edited file up (back up the original
  first — there's no git there, so no free rollback), `node --check` it
  (full path: the box's node isn't on the non-interactive PATH — it's at
  `/Users/ms/.nvm/versions/node/v22.17.0/bin/node`, found via
  `ps aux | grep relay`), restart with
  `launchctl kickstart -k gui/$(id -u)/show.fiesta.relay`, then verify with
  real `/resolve` + segment curls through `relay.fiesta.show` (see the
  "Continuation" section above for the exact commands used and why). There's
  also a launchd-scheduled autofix watchdog on that box (`.autofix/`,
  `scripts/autofix-watchdog.sh`) that can invoke its own headless Claude
  agent to patch `relay.mjs` — check `.autofix/checkpoint`/lock state isn't
  mid-run before editing.
