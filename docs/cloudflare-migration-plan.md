# Plan: move fiesta.show from Vercel to Cloudflare

Status: PLAN ONLY (2026-10-10). Nothing here is built. Trigger: production returns `402 DEPLOYMENT_DISABLED`
("Payment required") - the Vercel account/project hit a limit; the cause is not yet known.

## 0. What we have to move (inventory)

| Piece | Today (Vercel) | Notes |
|---|---|---|
| Angular 20 SPA (`dist/movie-streamer`) + `/lite` TV bundle (`tv/`) | static + SPA rewrite to `/index.html` | build is `npm run build` (builds `tv/` first) |
| `api/*.js` (10 functions, ~1.9k lines) | Node `(req,res)` handlers, 1 GB, 15-30 s | likes, comments, movie, omdb, tmdb, subs, suggestions, stream, music |
| `lib/*` | helpers incl. `lib/music/*` | Node `crypto`, `zlib`, `Buffer`, `zod`, `ai`, `@upstash/*` |
| `middleware.js` | Vercel Routing Middleware | old-TV UA -> `/lite`; OG/meta HTML for `/movie`, `/person`, music pages for bots |
| `vercel.json` | headers (`/vendor` immutable, `Vary: User-Agent`), rewrites | |
| Analytics | `@vercel/analytics`, `@vercel/speed-insights` | |
| Env stamp | `VERCEL_ENV` in `scripts/set-env.js`, `lib/tidal.js` (gates `MUSIC_SHARED_SESSION`), `api/stream.js` | |
| Geo / IP | `x-vercel-ip-country` (comments), `x-forwarded-for` | |
| Secrets | TMDB_API_KEY, OMDB, TIDAL_CLIENT_ID/SECRET, TIDAL_COUNTRY, MUSIC_SHARED_SESSION, MUSIC_BLOCKED_IDS, STREAM_RELAY_URL/SECRET, LASTFM_*, FANART_TV_KEY, Upstash (`UPSTASH_REDIS_REST_*`/`KV_REST_API_*`) | list via `vercel env ls`; never print values |
| Off-platform | Mac mini relay (`tools/fiesta-proxy`) behind a tunnel; Upstash Redis | unchanged by the move |

Good news: everything is `fetch`-based (Upstash REST, TIDAL, TMDB), so it runs on Workers. No filesystem use, no native modules.

## 1. Likely cause and what Cloudflare does NOT fix by itself

Unverified hypotheses, in order of suspicion:

1. **Audio proxy.** `api/music.js` `seg` fetches every FLAC segment from TIDAL, buffers it (`arrayBuffer()`), and returns it with
   `Cache-Control: private` (uncacheable by the CDN). Lossless went live on 2026-10-05. A few listeners = GBs of function time and
   bandwidth.
2. **Open proxies.** `seg`, `img`, `stream` send `Access-Control-Allow-Origin: *`, so any site/script can use us as a free
   audio/image proxy. No per-IP rate limit on them (only `comments` uses `@upstash/ratelimit`).
3. **Image proxy** (`img`) re-fetches covers per unique URL; cached 7 days at the CDN but each miss is a function run.
4. Bots/crawlers hammering `/movie/*`, `/person/*` (each runs the middleware + 2 upstream fetches).

**Action for you:** open Vercel -> Usage and note WHICH metric is red (Fast Data Transfer, Function Invocations/Duration, Edge
Requests, Fast Origin Transfer) and the top paths. That tells us whether (1), (2) or (4) is the cause and must be fixed in the port
instead of copied over.

## 2. Target architecture

One **Worker with Static Assets** (Cloudflare's current recommendation over Pages for new projects):

```
request -> Worker (src/worker/index.ts)
  |- /api/*            -> ported handlers (adapter, see 3b)
  |- old-TV UA         -> assets /lite/index.html
  |- /movie|/person|/music/* + bot UA -> HTMLRewriter meta injection (port of middleware.js)
  `- else              -> env.ASSETS.fetch (SPA fallback via not_found_handling = "single-page-application")
```

- `wrangler.jsonc`: `main`, `assets.directory = dist/movie-streamer/browser` (+ `/lite` copied in the build), `run_worker_first`
  limited to `["/api/*", "/movie/*", "/person/*", "/music/*", "/"]` so ordinary asset hits never invoke the Worker (static asset
  requests are free and unlimited), `compatibility_flags = ["nodejs_compat", "nodejs_compat_populate_process_env"]`,
  `compatibility_date` >= 2025-04-01.
- `_headers` file replaces `vercel.json` headers. Drop `Vary: User-Agent` on assets (UA routing happens in the Worker, so
  caching static files per-UA is unnecessary and hurts hit rate).
- Redis: keep **Upstash** (REST, already works, no data migration). Move to Workers KV/D1 later only if wanted.
- Relay: unchanged. Worker calls `STREAM_RELAY_URL` with the bearer secret; add a Cloudflare Access service token in front of
  the tunnel hostname as a second gate.

## 3. Work breakdown

### 3a. Foundations (no behaviour change)
- `wrangler.jsonc`, `npm run build` -> assets dir, `tv/` bundle placed at `/lite`.
- `DEPLOY_ENV` var replaces `VERCEL_ENV` everywhere (`production` | `preview` | `development`); `set-env.js` reads it
  (Workers Builds exposes `WORKERS_CI_BRANCH`; set per-environment vars). `lib/tidal.js relaySessionAllowed()` keeps its production
  gate keyed to `DEPLOY_ENV`.
- Remove `@vercel/analytics`, `@vercel/speed-insights`, `@vercel/functions`, `@vercel/node`; add **Cloudflare Web Analytics**
  (beacon, free) if wanted.

### 3b. API port (adapter first, rewrite later)
- Write `src/worker/node-compat.ts`: wraps a Worker `Request` into the `req` the handlers expect (`req.query`, `req.headers`,
  `req.method`, `req.body`) and collects `res.setHeader/status/json/end` into a `Response`. Handlers stay as they are, so the
  diff is small and reviewable; convert to native fetch-style per handler afterwards.
- Map `x-vercel-ip-country` -> `request.cf.country` / `CF-IPCountry`; `x-forwarded-for` -> `CF-Connecting-IP`.
- `process.env.*` works through `nodejs_compat_populate_process_env`; secrets via `wrangler secret put` (scripted from a
  `vercel env pull` file that is deleted afterwards).
- Module-level caches (`tidal` app token, relay session) stay per-isolate; that is fine, they just refresh more often.
- Check limits: subrequests per request (50 free / 1000 paid - `catalog.tracks`, `artist-images`, `discovery` fan out), bundle
  size (3 MB free / 10 MB paid compressed; `ai` + `zod` are the heavy ones - test with `wrangler deploy --dry-run`), CPU time.
  **This needs the Workers Paid plan (US$5/month)**; free (100k requests/day, 10 ms CPU) will not hold a public music app.

### 3c. Fix the expensive paths while porting (the part that actually protects the bill)
- `seg`: stream, don't buffer (`return new Response(r.body, ...)`), forward `Range`, and add an edge cache (Cache API keyed on
  track+segment) with a public cache header instead of `private`. **Spike first:** test whether TIDAL's audio CDN answers a
  browser MSE fetch with usable CORS headers. If yes, the client fetches segments directly and the proxy disappears for audio
  (biggest saving). If no, keep the streaming proxy.
- `img`: `caches.default` + `Cache-Control: public, max-age=31536000, immutable`; consider Cloudflare Image Resizing/`cf.image`
  for smaller thumbnails.
- CORS: replace `*` with an allowlist (`https://fiesta.show`, the preview/workers.dev hostnames) on `seg`, `img`, `stream`;
  reject cross-origin `Referer` on the two proxies (hot-link protection).
- `middleware` port: cache the generated bot meta HTML at the edge for 1 hour per URL so crawlers do not cost upstream calls.

### 3d. Protection (what we are moving for)
- Zone on Cloudflare (proxied/orange cloud), SSL Full (strict), Always Use HTTPS.
- **Rate-limiting rules** (WAF): e.g. `/api/music?action=seg|img`, `/api/stream`, `/api/comments` POST per IP. Free plan allows a
  small number of rules; Pro raises that.
- **Bot Fight Mode** on; **Turnstile** on comment/like POSTs (the `turnstile-spin` skill can do it end to end).
- Cache rules so `/api/music?...` GETs with `s-maxage` are actually cached at the edge.
- Spend/abuse alerts: Workers usage notification, WAF event alerts; weekly look at Analytics top paths.

### 3e. CI and previews
- Connect the GitHub repo with **Workers Builds** (build command `npm run build`, deploy command `npx wrangler deploy`;
  non-production branches get preview URLs via `wrangler versions upload`). Preview env must NOT get `MUSIC_SHARED_SESSION`
  semantics wrongly: keep the existing rule (relay session on previews, gated by `DEPLOY_ENV` in production).
- `tools/e2e/*.mjs` already take a base URL: point them at the workers.dev URL for acceptance.

## 4. Cutover

1. Build and deploy to `*.workers.dev`; run e2e (Chromium + WebKit) and the 12 artist-layout checks against it.
2. Verify lossless playback on workers.dev end to end (manifest `presentation: FULL`, FLAC past 49 s) and the relay token path.
3. Add `fiesta.show` to Cloudflare (nameservers at the registrar; lower TTLs a day ahead if DNS is elsewhere), attach the Worker
   custom domain. Because Vercel is currently returning 402, cutover is also the recovery.
4. Keep the Vercel project (paused is fine) for two weeks as a fallback; then remove the Vercel git integration and env vars.
5. Update `docs/handoff.md` (remove Vercel steps; `MUSIC_SHARED_SESSION` revert becomes `wrangler secret delete`).

## 5. Order and size (rough)

| # | Step | Needs from you |
|---|---|---|
| 1 | Vercel Usage screenshot (root cause) | 2 min |
| 2 | Spike: TIDAL CDN CORS for direct segment fetch; bundle size dry-run | none |
| 3 | 3a + 3b on a branch, `wrangler dev` locally | none |
| 4 | 3c fixes + 3d rules | Cloudflare login |
| 5 | workers.dev deploy + acceptance | Cloudflare login |
| 6 | Cutover + Workers Paid plan | DNS/registrar access, billing |

Steps 2-3 can start immediately and need no Cloudflare account. Realistically 1-2 working sessions to workers.dev, plus DNS time.

## 6. Open decisions

- Which Vercel metric tripped (step 1)?
- Where does `fiesta.show` DNS live today, and which registrar?
- OK to start Workers Paid (US$5/month)?
- Keep Upstash Redis (recommended) or move to Workers KV?
- Keep serving full lossless to all visitors from the personal TIDAL session? It is the likeliest cost driver and a licensing
  grey area; the plan keeps it behind `MUSIC_SHARED_SESSION` and rate limits, but it is your call.
- Still need iOS 15? Unrelated to hosting, but it gates the Angular upgrade.
