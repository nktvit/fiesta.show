# Stream architecture — what runs where

How ad-free streaming runs in production. For the *extraction mechanism* (the
embed chain, the WASM decryption, Turnstile, how to re-trace it when upstream
changes) see `tools/fiesta-proxy/README.md`. This doc covers the **runtime
model**: which process serves which hop, who pays for the bandwidth, what is
cached where, and how it fails.

## Short answer

Two processes, in two different places:

| | Where | What it is |
|---|---|---|
| **`api/stream.js`** | Vercel, Node.js serverless (`maxDuration: 30`, `memory: 1024`) | 66 lines. Validates the IMDB id and forwards to the relay with a Bearer header. Extracts nothing. |
| **`relay.mjs`** | A home Mac mini, launchd-managed long-lived Node 22 process, behind a Cloudflare Tunnel at `https://relay.fiesta.show` | 1219 lines. Does the extraction **and** serves every playlist and segment byte. Not in this repo. |

**No video bytes pass through Vercel.** They go from the stream CDN to the Mac
mini to the browser, on home bandwidth.

This has changed fundamentally since the previous version of this doc, which
described **two** Vercel Lambdas (`stream` + `hls`) funnelling all video through
Vercel via a Webshare rotating residential proxy. That model is gone:

- `api/hls.js` was **deleted** — commit `1955290`, "chore: remove dead Webshare
  HLS proxy (relay-only)". It is not in `vercel.json` and not in the repo.
- There is no Webshare proxy, no `STREAM_PROXY_URL`, no `STREAM_PROXY_RETRIES`,
  and no `undici` `ProxyAgent` anywhere in the live stack. Turnstile is beaten by
  the home residential IP plus a headless-browser fallback, not by renting IPs.
- The old doc's cost analysis ("all video bandwidth flows through the `hls`
  function", "`hls` is invoked hundreds-to-thousands of times per playback",
  Lambda-per-segment concurrency) describes a system that no longer exists.

## Production request lifecycle

A user opens `fiesta.show/movie/tt0111161` and presses Play:

1. **App load** — Vercel's edge serves the static Angular SPA
   (`/(.*) → /index.html`). CDN only, no function.

2. **Resolve** — `movie-player` calls `/api/stream?type=movie&id=tt0111161`
   (`&s=&e=` for TV; `&srv=1|2` only ever set by the automatic escalation
   described below — **a `?srv=2` in the page URL does nothing today**:
   `movie-page` reads it and binds `[server]`/`(serverChange)`, but the player
   never reads `server()` and never emits `serverChange`, so `onServerChange` is
   unreachable). Vercel routes `/api/*`
   to the **`stream` function**, which calls
   `GET $STREAM_RELAY_URL/resolve?…` with `Authorization: Bearer
   $STREAM_RELAY_SECRET` and returns
   `{ master, upstream, server, env }`. `s-maxage=300,
   stale-while-revalidate=60`, so Vercel's CDN shares one resolve across all
   users of that title for 5 minutes.

3. **Walk** — the relay does the 8-hop embed-chain walk from its residential IP
   (see the extraction README), mints a 6h HMAC playback token and picks a UA
   index, and returns
   `{ master: "https://relay.fiesta.show/hls?u=<b64url>&t=<tok>&ua=<i>",
   upstream, server }`. On a resolve-cache hit (600s) there is no upstream
   traffic at all, but the token and UA are still fresh.

4. **Master playlist** — hls.js requests that `master` URL. Cloudflare proxies it
   to the Mac mini; the relay verifies the token, fetches the real master from the
   stream CDN with `Referer`/`Origin: https://cloudorchestranova.com`, and
   rewrites every child URL to a **relative** `/hls?u=…&t=…&ua=…`. `no-store`.

5. **Media playlist** — hls.js picks a variant → another `/hls` request → same
   rewriting, applied to every segment URL in the variant.

6. **Segments** — one `/hls` request per ~5s chunk. The relay streams each
   upstream response straight through
   (`pipeline(Readable.fromWeb(upstream.body), res)`), aborts the upstream fetch
   if the browser disconnects, forces `video/mp2t`, and — **only for a 200** —
   marks it `public, max-age=31536000, immutable`. A non-200 becomes a `502` with
   `no-store` instead; see the caching table.

Every relay response carries `X-Fiesta-Source: relay`.

The browser only ever talks to two origins: `fiesta.show` (app + `/api/stream`)
and `relay.fiesta.show` (all video). It never sees the real stream host.

### There is a third resilience layer, in the browser

Worth knowing before debugging a "it played, then switched" report.
`movie-player`'s `failPlayback` handles the case where a front *resolved* but the
stream won't actually play (dead segments): on a fatal hls.js error, after
recovery attempts are exhausted (3 × `startLoad` for network errors,
3 × `recoverMediaError` for media errors), it re-resolves once against
`srv=2` and preserves play state mid-watch. `escalated` guards it to a single
attempt, and resets on the next unforced load. So one user-visible failure can be
three layers deep: hls.js recovery → front escalation → the relay's own
breaker/retries behind each resolve.

(The comment on that code still calls it "the other cloudnestra front" — stale
naming, the behaviour is correct.)

## Why the bytes have to come from the relay

Not a preference — two independent constraints:

1. **Cloudflare fronts the stream backend and 403s datacenter IPs.** Vercel
   Lambdas are datacenter IPs.
2. **The upstream playback token is bound to the caller's IP /24.** It is a JWT
   from `<stream origin>/generate.php`. Even handing the browser fully-formed
   upstream URLs would fail — the token was minted for the Mac mini's /24, not the
   viewer's.

Constraint 2 is the one the old doc had backwards; it stated the token was "not
IP-bound — segments fetch fine from any IP", which was true of the 2026-05
cloudnestra design. It is why there is no "just redirect the browser upstream and
skip the relay" optimisation available.

Both constraints are measured, not assumed. A live segment token decoded on
2026-09-13 carries the claims `exp`, `iat`, `ip_cidr`, `iss`, `nbf`, with
`exp − iat = 14400` (exactly 4h) and a `/24` mask on `ip_cidr`. The relay itself
only ever reads `exp`, so enforcement is upstream's — but the binding is real.

## Caching, layer by layer

| Layer | What | TTL | Notes |
|---|---|---|---|
| Vercel CDN | `/api/stream` response | `s-maxage=300`, `swr=60` | Shared across all users of a title. Dedupes resolves. |
| Relay, in-memory | resolve cache, `(type,id,s,e,srv)` → upstream master | 600s, 500 entries, FIFO | A hit does **zero** upstream work. Token/UA still minted fresh. |
| Relay, in-memory | in-flight de-dupe | — | Concurrent identical resolves share one walk. |
| Relay, in-memory | host tokens per stream origin | the JWT's own `exp` (~4h), minus 60s | Plus per-origin failure cooldowns. |
| Relay, in-memory | compiled WASM decryptors | 20 entries, keyed `vs.w` | The module rotates ~every 5 min upstream. |
| Browser | `/hls` segments, **200 only** | `max-age=31536000, immutable` | Safe: the `(token, segment)` tuple is immutable. Every non-200 is collapsed to a `502` with `no-store` — before 2026-09-13 failures were cached immutably too, which pinned a permanent glitch at a fixed timecode. |
| Browser | `/hls` playlists | `no-store` | They carry tokens. |
| Cloudflare edge | — | **nothing** | See below. |

**Cloudflare is not caching the segments.** `relay.fiesta.show` is proxied
(`server: cloudflare`, `cf-ray: …-DUB`), but a probe returns
`cf-cache-status: DYNAMIC` — the `/hls` path has no file extension, so
Cloudflare's default static-extension caching never applies, and the
`immutable, max-age=1y` header is honoured only by browsers.

A Cache Rule on `/hls` could plausibly offload repeat segment traffic to the
edge, but it needs a custom cache key that ignores `t` and `ua`, since both vary
per session and would otherwise make every viewer a cache miss. That weakens the
token gate's granularity and is **untested** — noted as an opportunity, not a
recommendation. It also can't be properly evaluated from the box: the tunnel is
dashboard-managed, so the zone's WAF rules, cache rules, Access policies and rate
limits are only visible in the Cloudflare UI.

## Cost and bandwidth

- **Vercel** sees only the resolve: one small JSON request per title per 5
  minutes, CDN-cached. Effectively free, and flat in the number of viewers.
- **Home bandwidth** carries 100% of the video, twice (CDN → box, box → viewer).
  This is the real cost, and it is unmetered — which is the entire point of the
  design.
- "No metered bytes" is specifically about **video**. `/api/subs` is still a
  Vercel function and subtitle VTTs do flow through it — tens of KB per title,
  irrelevant next to a 2GB film, but it isn't zero.
- **No metered proxy.** The Webshare quota the old doc budgeted around no longer
  exists as a line item.
- The relay is a **single long-lived process**, not per-request compute, so there
  are no cold starts, no per-invocation billing, and no concurrency ceiling other
  than the box itself.

Scaling limits are now the home upload link and the Mac mini, not a function
quota. Note one consequence of the resolve cache plus in-flight de-dupe: *N*
simultaneous viewers of the same title cost one upstream walk, but *N* full
segment streams.

## Why Node, not Edge

Still Node, for stronger reasons than before.

`api/stream.js` is a plain Node `(req, res)` handler:

```js
module.exports = async function handler(req, res) { ... }   // Node.js runtime
```

No `runtime: 'edge'` is set anywhere, so Vercel uses the default Node runtime.
It's now a thin `fetch` forwarder and would technically port to Edge — but there
is no reason to, and Fluid Compute is the platform default regardless.

### The one place the two runtimes collide

`api/stream.js` is capped at `maxDuration: 30`, and its `fetch` to the relay
carries **no timeout and no `AbortSignal`**. A resolve that falls back to the
headless browser budgets up to **75s** on its own (30s `page.goto` + 45s
`waitForFunction`), plus unbounded queueing behind `withBrowserLock`, which is
global across every title.

So a resolve that genuinely needs Playwright is abandoned by Vercel at 30s and the
user sees a `502` — **even though the relay finishes successfully and caches the
result.** Their retry within the next 600s then succeeds instantly off that cache.
"First play failed, second play was instant" is therefore an expected symptom of
this gap, not a flake. It has likely never been hit in practice, since the browser
path hasn't fired under the current build at all.

The relay genuinely cannot be Edge, or any serverless runtime: it launches and
keeps a **headless Chromium** (`playwright-core`), compiles and instantiates
**WASM modules** per resolve, keeps **long-lived in-memory state** (resolve cache,
host tokens, circuit breakers, a warm `cf_clearance` cookie), serialises browser
solves behind a process-wide lock, and must originate from one specific
residential IP. None of that survives an isolate, and none of it survives being
spread across ephemeral instances.

## Ops

Everything on the box lives in `/Users/ms/Server/relay.fiesta.show/`, reachable
via `ssh mm` (user `ms`). **It is not a git repository.**

| | |
|---|---|
| Service | `show.fiesta.relay` — launchd user agent, `RunAtLoad` + `KeepAlive` |
| Binary | `/Users/ms/.nvm/versions/node/v22.17.0/bin/node relay.mjs` |
| Restart | `launchctl kickstart -k gui/$(id -u)/show.fiesta.relay` |
| Listens | `*:8787` — **all interfaces**, plain HTTP (`server.listen(PORT)` with no host). TLS terminates at Cloudflare |
| Log | `relay.log` — stdout **and** stderr, **no rotation**. ISO-8601 timestamps on every line from the 2026-09-13 restart onward; nothing before it. `[segstats] ok=N bad=N bad_rate=%` every 60s of traffic is the segment-failure rate |
| Secrets | `.env.local`, parsed by `relay.mjs` itself; existing `process.env` wins. 15 `RELAY_*` vars are read by the code; **4 are set** |
| Rollback | `relay.mjs.bak-*` files only — no git, so **back up before editing**, and order them by **filename**, not `ls -lt` (the copies preserved the original mtimes) |
| Tunnel | `/opt/homebrew/bin/cloudflared tunnel run --token …`, as root via the `/Library/LaunchDaemons/com.cloudflare.cloudflared.plist` system daemon |
| Watchdog | `show.fiesta.relay.autofix` — `StartInterval` 300s |
| Dependencies | exactly one: `playwright-core@1.58.0` (no bundled browser; it uses a cached *Google Chrome for Testing* build) |

The Cloudflare Tunnel dials **out**, so there is no inbound port forwarding and
no certificate on the box. Consequences worth knowing: the public hostname
depends on Cloudflare's control plane as well as the home connection, and the
relay sees Cloudflare's IPs — not viewers' — in its logs.

Note that the relay binds **every** interface, not loopback, so anything on the
home LAN can reach `:8787` directly, bypassing Cloudflare. The `/resolve` Bearer
check, the `/hls` HMAC token and the `assertPublicHttps` SSRF guard are the only
things standing in front of it — which is exactly why that guard exists.

**Latent risk: Cloudflare WARP is installed on this box** and its daemon reports
`Connected`. Today it is *not* on the egress path — `curl
https://www.cloudflare.com/cdn-cgi/trace` reports `warp=off`, `colo=DUB`,
`loc=IE`, and the egress address is the home ISP's — so the residential IP the
whole design depends on is intact. But if WARP's mode ever changed to route
traffic, every resolve would start getting 403s from a Cloudflare egress IP. That
would look exactly like an upstream migration and would probably send the autofix
agent chasing markup changes that never happened. **Check `cdn-cgi/trace` for
`warp=off` before debugging a total resolve outage.**

### Self-repair agent

`scripts/autofix-watchdog.sh` greps new `relay.log` lines for the
upstream-migration signature (the *same* resolve error across ≥3 **distinct**
titles, excluding `404`s and Turnstile timeouts) and, on a match, invokes a
headless `claude -p` with `--max-budget-usd 3` and `Read,Edit,Bash` scoped to
that directory, instructed to patch `relay.mjs`, restart, verify, and revert with
`NEEDS HUMAN` if verification fails. 1200s cooldown, `mkdir` lock with stale
recovery.

**It has never fired** — no `.autofix/autofix.log` exists and `watchdog.log` is
0 bytes. Check `.autofix/lock.d` before editing `relay.mjs` by hand.

## Failure modes

**Which half is broken?** Three checks, in order:

1. `curl https://relay.fiesta.show/healthz` → `ok` proves box + tunnel + port and
   **nothing else**. It's unauthenticated, sends no CORS headers, answers any
   method, and returns a 2-byte body.
2. **Look at the response headers.** `x-fiesta-source: relay` means the relay
   answered; `x-vercel-cache`/`x-vercel-id` means Vercel did. That pair is the
   fastest discriminator there is.
3. **Read the 502's message.** `/api/stream` forwards the relay's error string
   verbatim, so the message *is* the diagnosis:

| Forwarded message | Means |
|---|---|
| `all fronts in cooldown (Ns)` | breaker — wait it out |
| `generate cooling globally Ns` | upstream throttling our /24 |
| `CONFIG.api not found in layer3` (or any shape error) | upstream changed — go re-trace |
| `fetch failed` / `ECONNREFUSED` | the relay process or the tunnel is down |

`503` + `Retry-After` is the only status that means "wait, by design". `401` means
`STREAM_RELAY_SECRET` ≠ the box's `RELAY_SECRET`. `500 stream relay not
configured` is a missing Vercel env var and never a relay problem.

| Symptom | Where to look |
|---|---|
| `/api/stream` → 500 "stream relay not configured" | `STREAM_RELAY_URL` / `STREAM_RELAY_SECRET` missing in the Vercel project env |
| `/api/stream` → 502 | the relay answered with an error, or is unreachable. Its `error` string is forwarded verbatim — read it |
| `/resolve` → 401 | `STREAM_RELAY_SECRET` ≠ the box's `RELAY_SECRET` |
| `/resolve` → 503 + `Retry-After` | every front is in breaker cooldown. Transient by design; wait it out |
| `relay.log`: `generate cooling globally` | upstream is rate-limiting **our /24**. Not a code bug — the watchdog ignores this deliberately |
| `relay.log`: same error, many distinct titles | upstream changed shape. Follow the re-trace procedure in the extraction README — but rule out WARP first (below) |
| Every title 403s at once, no markup change | check `curl https://www.cloudflare.com/cdn-cgi/trace` on the box for `warp=off`. WARP on the egress path turns the residential IP into a datacenter one |
| `/hls` → 403 | playback token expired (6h) or `RELAY_SIGNING_KEY` changed. Re-resolve |
| Playback stalls mid-film, resolve worked | segment 502s, or the home uplink. `grep '\[hls\]' relay.log` |
| `/healthz` unreachable | box down, home internet down, or `cloudflared` down — in that order of likelihood |

**Current known degradation:** upstream is rate-limiting this IP. `relay.log` is
full of `generate cooling globally` and `[breaker] srv=2 skipped`, and
`RELAY_RESOLVE_TRIES` has been deliberately lowered to `1` because retrying into
a 429 prolongs the window. Raise it back to 2–3 once upstreams are healthy.

### Recovery, when the relay is down

There is no recovery procedure beyond restarting it. That is the honest answer: no
failover, no second relay, no degraded mode — `/api/stream` 502s and nothing
plays. The mechanics worth knowing:

- launchd restarts the process on any exit (`KeepAlive: true`), throttled by its
  10s minimum runtime. Manual: `launchctl kickstart -k gui/$(id -u)/show.fiesta.relay`.
- A missing `RELAY_SECRET` or `RELAY_SIGNING_KEY` is **fatal at boot**, which
  under `KeepAlive` becomes a crash-loop. A missing `RELAY_PUBLIC_URL` does *not*
  stop startup — it degrades `/resolve` to a request-time 500, and the startup
  banner says so.
- `shutdown()` closes the browser but **never calls `server.close()`**, so a
  restart cuts in-flight segment streams dead mid-download.
- Every cache is in-memory, so a restart throws away the very cooldowns that were
  protecting you from the throttle you restarted because of.
- Rollback: `cp relay.mjs.bak-<pick by FILENAME> relay.mjs`, `node --check`,
  kickstart, then two `/resolve` curls (`tt1375666` movie, `tt0944947` s1e1) and
  confirm the returned `master` body starts `#EXTM3U`.

**The relay is the system's single point of failure.** One home machine, one
residential connection, one ungitted 46KB file, one dashboard-managed tunnel. There
is no second path to a stream and no failover; if the box is off, nothing plays.

And it is a **shared, multi-tenant box**: the same `cloudflared` tunnel also
fronts two unrelated home services, and the machine additionally runs Docker, a
gitlab-runner, WARP and a dev Vite. A reboot or a tunnel restart is therefore never
a relay-only action — and conversely, someone else's maintenance can take the
stream down.

Two loose ends on the tunnel itself: the installed `cloudflared` is **2026.9.1**
while the running daemon self-reports **2026.7.2** (up since 17 Jul), so a restart
would silently change versions; and its
`/Library/Logs/com.cloudflare.cloudflared.err.log` is unrotated at 4.1 MB,
world-readable, and contains ~770 live `/hls` URLs **including their playback
tokens** (see the token section in the extraction README — those tokens proxy any
https URL).

Three gaps in that chain are worth naming, because nothing currently watches
them:

- **Nothing watches the tunnel.** launchd's `KeepAlive` only notices
  `cloudflared` *exiting*. If the daemon stays up but its QUIC connections to
  Cloudflare all fail, the site goes dark and `relay.log` stays completely
  silent — the relay never sees the requests, so there is nothing for the autofix
  watchdog to grep. `/healthz` from outside the house is the only detector.
- **The tunnel's identity can't be confirmed on the box.** The daemon is started
  with an opaque `--token`, and the credentials sitting in `~/.cloudflared`
  belong to a *different* tunnel id than the one in use. Reconfiguring or
  recreating the tunnel therefore needs the Cloudflare dashboard, not the box.
- **There is no deploy path from this repo to the box.** No rsync, no scp script,
  no CI — the live file is hand-edited in place, and its mtime is the only record
  of when. That is why `tools/fiesta-proxy/relay.mjs` drifted in the first place.

## Env inventory

**Vercel project**: `STREAM_RELAY_URL`, `STREAM_RELAY_SECRET`.
(`api/stream.js` reads only these two.)

**The box**: `RELAY_SECRET` and `RELAY_SIGNING_KEY` are mandatory — the process
exits without them. `RELAY_PUBLIC_URL` is needed for `/resolve` to work at all.
`RELAY_PORT` is set. Everything else runs on defaults; the full table of
tunables is in `tools/fiesta-proxy/README.md`.

`STREAM_RELAY_SECRET` (Vercel) and `RELAY_SECRET` (box) must be the same value.
