# fiesta-proxy — ad-free stream extraction

Server-side extractor that turns a vidsrc/cloudnestra embed into a clean HLS
stream the frontend plays directly. **No hostile player runs in the browser**, so
there are no ads, no popups, and no anti-devtools redirect.

## Why this exists

The previous approach embedded vidsrc in an `<iframe>` and injected a script to
neutralise ads. It failed: the player is built to force ads, and any tampering
(or just opening devtools) triggers an anti-tamper redirect — which on
fiesta.show bounced the user to another page on their own site. Sandboxing the
iframe just made the player refuse to load ("media unavailable").

The fix: don't run the player at all. Extract the raw video manifest on the
server and stream it to our own `<video>` + hls.js.

## How the stream is reached

All steps are plain HTTP fetches with the right `Referer`:

```
1. vidsrc.me/embed/{type}/{imdb}[/{s}-{e}]      Referer: vidsrc.me
      → HTML contains <iframe src="//cloudnestra.com/rcp/{hash}">
2. cloudnestra.com/rcp/{hash}                   Referer: vidsrc.me
      → HTML contains  src: '/prorcp/{hash2}'
3. cloudnestra.com/prorcp/{hash2}               Referer: the rcp URL
      → Playerjs config: file:"https://tmstr5.{vN}/pl/{token}/master.m3u8 or …"
4. master.m3u8 → media index.m3u8 → TS segments  Referer: https://cloudnestra.com/
```

Facts established while tracing:
- Stream is **plain HLS VOD, unencrypted** (no `EXT-X-KEY`). 3 variants
  (640×358, 1280×714, 1920×1072). Segments are MPEG-TS (h264+aac) mislabeled as
  `page-N.html` on a rotating content host.
- Everything downstream of the token needs **only** `Referer: https://cloudnestra.com/`
  (403 without it). The token is **not IP-bound** — segments fetch fine from any IP.
- `{vN}` are mirror-host placeholders; substituting `cloudnestra.com` works
  (`tmstr5.cloudnestra.com`).

## The Turnstile problem (and the fix)

`cloudnestra.com/rcp` is gated by a Cloudflare **managed** Turnstile challenge. A
real browser passes it invisibly by executing the challenge JS; a bare `fetch`
cannot, so it only succeeds when Cloudflare opts not to challenge that IP —
**per-IP probabilistic**, and datacenter IPs (Vercel) get challenged often.

Fix: route **only** the resolution (steps 1–3, ~66KB) through a **Webshare
rotating residential proxy** and **retry across fresh IPs** until one isn't
challenged. The `rotate` keyword in the proxy username yields a new IP per
connection. Video segments stay **direct/off-proxy** (token isn't IP-bound), so
the heavy traffic never touches the proxy quota.

## Files

| File | Role |
|------|------|
| `/api/stream.js` | Resolver. Walks the chain through the rotating proxy with retries; returns `{ master: "/api/hls?u=…" }`. |
| `/api/hls.js` | HLS proxy. Injects the cloudnestra `Referer`, adds CORS, rewrites playlist child URLs to relative `/api/hls?u=…`, streams segments as `video/mp2t`. |
| `src/app/components/movie-player/*` | Frontend `<video>` + hls.js (Chrome) / native HLS (Safari), with loading/error states. |
| `tools/fiesta-proxy/local-test-server.mjs` | Local dev harness — mounts the two `/api` functions on `:3999` and loads `.env.local`. |
| `src/proxy.conf.json` | `ng serve` routes `/api/stream` + `/api/hls` → `:3999`. |
| `tools/fiesta-proxy/.env.local` | `STREAM_PROXY_URL` (gitignored — holds proxy creds). |
| `tools/fiesta-proxy/src/index.ts` | **Legacy** Cloudflare Worker (old neutralizer + a worker port of this approach). Unused now that resolution lives in `/api`. |

URLs handed to the browser are **relative** (`/api/hls?u=…`) so they resolve
against the page origin and work identically behind the dev proxy and in prod.

## Run locally

Two terminals from the repo root:

```bash
node tools/fiesta-proxy/local-test-server.mjs   # /api functions + proxy (reads .env.local)
npm start                                        # ng serve on :4200, proxies /api → :3999
```

Open `http://localhost:4200/movie/tt0111161`. (`vercel dev` is **not** usable —
its bundled vite can't serve Angular 20's dev output; use `ng serve`.)

### Env vars

- `STREAM_PROXY_URL` — `http://USER-CC-rotate:PASS@p.webshare.io:80` (the
  `rotate` keyword is required for per-request IP rotation). Without it, the
  resolver runs direct (works only on a clean IP).
- `STREAM_PROXY_RETRIES` — max fresh-IP attempts per resolve (default 10).

## Deploy (Vercel)

`api/stream.js` and `api/hls.js` are registered in `vercel.json` (maxDuration 30).
Set `STREAM_PROXY_URL` (and optionally `STREAM_PROXY_RETRIES`) in the Vercel
project env. `/api/stream` responses are CDN-cached (`s-maxage=300`) so repeat
plays of a title don't re-resolve.

## Known limits

- **Resolve latency**: a cold resolve may take a few seconds on a bad-luck streak
  of challenged IPs; cached afterward for 5 min.
- **TV episodes** use `?type=tv&s=&e=` (same path) — verified for movies; spot-check episodes.
- Mirror hosts and token formats rotate upstream; re-trace with a browser network
  capture if extraction breaks.
