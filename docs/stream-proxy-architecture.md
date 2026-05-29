# Stream proxy — deployment architecture (Vercel)

How the ad-free stream extraction runs once deployed. For the *extraction
mechanism* (the embed chain, Turnstile, the proxy), see
`tools/fiesta-proxy/README.md`. This doc covers the **runtime model**: what kind
of functions these are, the request lifecycle, caching, and cost.

## Short answer

Everything runs as **Vercel Serverless Functions (Node.js runtime)** — *not*
Edge Functions. This is deliberate, and for `stream.js` it's mandatory.

The tell is the handler signature. `api/stream.js` and `api/hls.js` use the
Node `(req, res)` form:

```js
module.exports = async function handler(req, res) { ... }   // Node.js runtime
```

Edge Functions use the Web/Fetch signature with an explicit opt-in:

```js
export const config = { runtime: 'edge' };
export default async (request) => new Response(...);          // Edge runtime
```

No `runtime: 'edge'` is set, so Vercel uses the default **Node.js runtime**
(AWS Lambda under the hood). `vercel.json`'s `functions` block (`memory: 1024`,
`maxDuration: 30`) applies to serverless functions.

## Why Node, not Edge

`stream.js` routes resolution through the Webshare proxy:

```js
const { ProxyAgent } = require('undici');
fetch(url, { dispatcher: new ProxyAgent(STREAM_PROXY_URL) });
```

The **Edge runtime cannot do this.** Edge runs on a V8 isolate (Cloudflare-
Workers-like), not Node — no `require`, no `undici.ProxyAgent`, no `Buffer`, and
critically **no way to route `fetch` through an arbitrary outbound HTTP proxy**.
The proxy is how we beat Turnstile, so `stream.js` *must* be a Node serverless
function. Edge was never an option for it.

## Production request lifecycle

When a user opens `fiesta.show/movie/tt0111161`:

1. **App load** — Vercel's edge network serves the static Angular SPA
   (`/(.*) → /index.html`). CDN-served, no function.

2. **Resolve** — `movie-player` calls `fetch('/api/stream?type=movie&id=tt0111161')`.
   Vercel routes `/api/*` to the function → **`stream` Lambda**. It walks
   vidsrc → rcp → prorcp **through the rotating residential proxy**, retrying
   fresh IPs until Turnstile clears, and returns `{ master: "/api/hls?u=<token>" }`
   (relative). Response sets `s-maxage=300`, so Vercel's **edge CDN caches the
   resolution for 5 min, shared across all users** of that title — repeat plays
   skip the proxy entirely.

3. **Master playlist** — hls.js requests `/api/hls?u=<token>` → **`hls` Lambda**.
   Fetches `master.m3u8` from cloudnestra with `Referer: https://cloudnestra.com/`,
   rewrites the 3 variant URLs to relative `/api/hls?u=...`, returns it.

4. **Media playlist** — hls.js picks a variant → another `hls` invocation →
   fetches media `index.m3u8`, rewrites all ~1700 segment URLs.

5. **Segments (the volume)** — for every ~5s chunk, hls.js requests
   `/api/hls?u=<segment>` → **one `hls` invocation per segment**. Each fetches
   the MPEG-TS **directly from the content host (off-proxy)** with the
   cloudnestra Referer and streams it back as `video/mp2t`.

Two functions total, but `hls` is invoked **hundreds-to-thousands of times per
movie** (once per segment); `stream` is invoked rarely and is CDN-cached.

## Execution model

- **Each `api/*.js` is its own isolated Lambda.** `stream` and `hls` scale
  independently.
- **Stateless** — no shared memory across invocations. Module-level vars (e.g. a
  cached `ProxyAgent`) survive only within a *warm* container; don't rely on it.
- **Cold starts** — first hit after idle pays init latency; under active
  streaming `hls` stays warm.
- **Region-bound** — serverless functions run in one region by default:
  browser → Vercel region → upstream → back. Edge caching hides this on repeats.
- **`maxDuration: 30s`** per invocation. A segment fetch is well under it. A
  bad-luck resolve (up to `STREAM_PROXY_RETRIES`=10 × ~3 fetches) must also fit —
  that's the ceiling to watch if residential IPs are slow.

## Caching layers

| Response | Header | Effect |
|---|---|---|
| `/api/stream` | `s-maxage=300, stale-while-revalidate=60` | Shared edge cache 5 min; dedupes resolves across users. |
| `/api/hls` playlist | `no-store` | Always fresh (carries tokens). |
| `/api/hls` segment | `public, max-age=31536000, s-maxage=31536000, immutable` | Browser **and** shared edge cache. The (token, segment) tuple is immutable, so long caching is safe; stale tokens simply stop being requested. Cuts invocations and bandwidth across users. |

## Cost considerations

**All video bandwidth flows through the `hls` function** — segments can't go
browser-direct (403 without the Referer; no CORS from the host). On Vercel you
pay for:

1. **Invocations** — ~1 per segment, thousands per full movie (mitigated by the
   segment edge cache for shared/repeat views).
2. **Egress bandwidth** — every video byte is served out of Vercel.
3. **Compute (GB-hours)** — small per segment, multiplied by volume.

`hls.js` currently **buffers each whole segment** (`Buffer.from(await
upstream.arrayBuffer())`) before responding — fine memory-wise (~1.7MB ≪ 1024MB)
but adds latency (waits for the full download) and isn't true streaming.

## Optimization path

`stream.js` is locked to Node (the proxy). But `hls.js` **doesn't use the proxy**
— it could move to an **Edge Function**, which would stream segment bodies
instead of buffering, cost less per invocation, and run closer to the user.
That's the natural next step if bandwidth/cost becomes significant. Edge caching
(`s-maxage` on segments, already set) does most of the heavy lifting in the
meantime.

## Secrets / env

- `STREAM_PROXY_URL` — `http://USER-CC-rotate:PASS@p.webshare.io:80` (the
  `rotate` keyword is required for per-request IP rotation). Set in
  **Vercel → Project → Environment Variables** (encrypted). Only `stream.js`
  reads it. Local dev reads it from the gitignored `tools/fiesta-proxy/.env.local`.
- `STREAM_PROXY_RETRIES` — max fresh-IP attempts per resolve (default 10).

**Bottom line:** two Node serverless functions — `stream` (proxy-bound, must be
Node, lightly invoked, CDN-cached) and `hls` (the bandwidth funnel, a candidate
for Edge later). No Edge Functions yet; only Vercel's edge *CDN* fronting them.
