# fiesta-proxy — ad-free stream extraction

Server-side extractor that turns a vidsrc/vsembed embed into a clean HLS stream
the frontend plays directly. **No hostile player runs in the browser**, so there
are no ads, no popups, and no anti-devtools redirect.

> **Read this first — where the code actually lives.** The extractor is **not** a
> Vercel function and **not** in this repo. It is a standalone Node process,
> `relay.mjs`, deployed at `/Users/ms/Server/relay.fiesta.show/` on a home Mac
> mini (`ssh mm`, user `ms`) and reachable at `https://relay.fiesta.show`. That
> directory is **not a git repo**. `tools/fiesta-proxy/relay.mjs` in *this* repo
> is a dead 369-line snapshot of a 2026-05 design — see
> [The repo snapshot is dead code](#the-repo-snapshot-is-dead-code). Everything
> below describes the live file (1219 lines as of 2026-09-13).
>
> The directory name `fiesta-proxy` is historical. The Webshare rotating
> residential proxy it refers to is **gone** — see
> [Anti-bot](#anti-bot-a-residential-ip-and-a-real-browser).

## Why this exists

Two separate problems, one answer.

**Ads.** The original approach embedded vidsrc in an `<iframe>` and injected a
script to neutralise ads. It failed: the player is built to force ads, and any
tampering (or just opening devtools) triggers an anti-tamper redirect — which on
fiesta.show bounced the user to another page on their own site. Sandboxing the
iframe just made the player refuse to load ("media unavailable"). The fix: don't
run the player at all. Extract the raw manifest server-side and feed our own
`<video>` + hls.js.

**Datacenter IPs.** Cloudflare fronts the stream backend and 403s datacenter IPs
(Vercel, cheap proxies) while letting residential IPs through. On top of that the
per-host playback token is **bound to the caller's IP /24** (see
[Two different tokens](#two-different-tokens)), so the browser cannot fetch
segments directly even if we handed it the real URLs. Both the resolve *and* every
playback byte have to come from one residential IP — which is why a box at home
does the fetching and streams the result out.

## How the stream is reached

Eight hops, each a plain HTTP fetch with a deliberately-chosen `Referer`. The
chain rediscovers the live backend domain on every resolve, so a backend
migration does not hardcode anything except `STREAM_BACKEND_ORIGIN`.

```
1. FRONT      <front>/embed/{type}/{imdb}[/{s}-{e}]          Referer: <front>/
                 srv=1 → vidsrc.me        srv=2 → vsembed.ru
                 NB: vidsrc.me 301s to vidsrcme.ru. Each page sets
                 referrer-policy="origin", so the NEXT hop's Referer must be
                 this response's POST-redirect origin (`r.url`), not the URL
                 we asked for. Getting this wrong produces false 403s.
                 → HTML with <iframe id="player_iframe" data-api="/vs_src.php?…">

2. GATE       <front origin>/vs_src.php?…                    Referer: the embed URL
                 The iframe has NO static src= any more (changed 2026-08-24);
                 the src is fetched at runtime so the embed HTML stays cacheable.
                 → { "src": "<layer2 url>" }

3. LAYER 2    gateJson.src                                   Referer: the embed URL
                 → HTML containing  window.CFG = { playerUrl: "/…", … };
                 This is the hop Turnstile guards. Its origin is the live
                 backend domain (currently cloudorchestranova.com) — read from
                 the URL, never assumed.

4. LAYER 3    <layer2 origin> + CFG.playerUrl                Referer: the layer2 URL
                 → HTML containing  window.CONFIG = { … };
                 movies: CONFIG.api is ready to use.
                 tv:     no .api — build it, mirroring the player's own apiFor():
                         CONFIG.streamBase + "&season=" + s + "&episode=" + e
                                           + "&stream_urls"

5. DATA API   CONFIG.api (or the built TV URL)               Referer: the layer3 URL
                 → { status_code: 200,
                     data: { stream_urls: [...] | "<base64 blob>" },
                     vs:   { w, wasm_url } }            ← only when encrypted

6. DECRYPT    stream_urls is EITHER a plain array OR, when protection is on, a
              single base64 ChaCha20 blob (nonce ‖ ciphertext). Decrypt it with
              the WASM module named by vs.wasm_url — the same decryptor the site's
              own vsdec.js uses, rotated roughly every 5 minutes. Node's built-in
              WebAssembly runs it; no browser needed for this step.
              → newline-separated list of candidate master URLs

7. HOST TOKEN For each candidate's origin:  GET <origin>/generate.php
                                                           Referer: <backend origin>/
                 → a JWT, measured 2026-09-13: claims exp/iat/ip_cidr/iss/nbf,
                 exp-iat = 14400s (exactly 4h), ip_cidr masked /24.
                 Stamped into the URL: replaces a literal __TOKEN__ if present,
                 else appended as ?token=/&token=.
                 This endpoint is aggressively rate-limited. See
                 "Staying up under upstream pressure".

8. PROBE      Fetch each stamped candidate once (quickServes); the first HTTP 200
              is returned as the master. Note there is a SECOND, independent
              check after the walk: performResolve calls masterServes(), a
              2-try fetchUpstream, and THAT is what decides `server`, the
              born-dead path and the fallback. The two are not header-identical
              — quickServes sends UA/Accept/Referer, fetchUpstream also sends
              Origin: <backend origin>. That Origin is the only one in the file,
              so don't copy the probe's headers for a playback test.
              Playlists and segments need BOTH Referer and Origin — 403 without.
```

Implemented as: `resolveMaster` → `resolveMasterOnce` (hop 1) → `walkFromEmbed`
(hops 2–3) → `walkFromLayer2` (hops 4–8), with `extractPlayerIframeApi`,
`extractInlineJSON`, `decryptStreamUrls`/`getWasmModule`, `getHostToken`,
`applyStreamToken`, `quickServes` doing the per-hop work. `walkFromLayer2` takes
its fetcher as a `get(url, referer)` argument, so the plain-fetch path and the
headless-browser path share one implementation of everything past layer 2.

### What changed since the old version of this doc

The doc previously described a three-hop chain
`vidsrc.me/embed → cloudnestra.com/rcp/{hash} → cloudnestra.com/prorcp/{hash2}`
ending at a Playerjs `file:"…"` string on a `tmstr5.{vN}` host. **None of that
path exists any more.** Two upstream migrations killed it:

| Date | What the operator changed | What broke |
|------|---------------------------|------------|
| 2026-08-19 | Backend domain `cloudnestra.com` → `cloudorchestranova.com` | Every hardcoded `cloudnestra` host and the `{vN}` mirror-placeholder substitution |
| 2026-08-24 | `#player_iframe` lost its static `src=`, replaced by a `data-api="/vs_src.php?…"` gate returning `{src}` | The `rcp` hop — there is no `/rcp/` URL in the HTML to scrape |

The `rcp`/`prorcp` hop names and the Playerjs `file:"…"` regex are gone, and the
WASM `stream_urls` decryption (hop 6) and per-host `generate.php` token (hop 7)
did not exist at all in the old design.

**The `/pl/…/master.m3u8` path shape, however, survived** — don't let the rest of
this section convince you otherwise while you're tracing by hand. A live upstream
master today looks like:

```
https://<per-title dictionary-word domain>/pl/<long base64url blob>/master.m3u8?token=<JWT>
```

What changed around it: the **host** (`tmstr5.{vN}` mirror placeholders → a
per-title domain, so there is no `{vN}` substitution any more), the **token's
position** (a path segment → a `?token=` query param, or a `__TOKEN__` placeholder
the relay substitutes), and **how you obtain the URL** (a WASM-decrypted candidate
list instead of one regex match).

**What the old doc measured and got right — re-measured 2026-09-13, still true.**
The media itself has barely changed across both migrations. A live master +
media playlist + first segment, pulled through the relay:

- master: exactly **3** `#EXT-X-STREAM-INF` — `640x358` (BW 917230), `1280x714`
  (3281926), `1920x1072` (5145364), `FRAME-RATE=24`, `mp4a.40.2` +
  `avc1.42c01e/64001f/640028`
- media: `#EXT-X-VERSION:3`, `PLAYLIST-TYPE:VOD`, `TARGETDURATION:6`,
  `MEDIA-SEQUENCE:1`, `#EXT-X-ENDLIST`, **1708** `#EXTINF`, and **zero**
  `#EXT-X-KEY` in either playlist — so "plain, unencrypted HLS VOD, 3 variants"
  holds in 2026-09 exactly as it did in 2026-05
- first segment: upstream path `/content/<32hex>/<32hex>/page-0.html?token=…`,
  re-served as `video/mp2t`, 570 KB, first byte `0x47` (MPEG-TS sync)

Two in-code comments overstate: segments are described as "~1-2MB" (570 KB
observed on the low variant) and "~5s" (`TARGETDURATION` is 6).

**The one old claim to delete, not soften: "the token is not IP-bound — segments
fetch fine from any IP."** Verified false on 2026-09-13 by decoding a live
segment token. Its claims are `exp`, `iat`, `ip_cidr`, `iss`, `nbf`;
`exp − iat = 14400` — exactly 4h, not "~4h" — and `ip_cidr` carries a **`/24`**
mask. (The CIDR itself is the home network; don't paste it into a doc.) The relay
only ever reads `exp` from it (`jwtExp`), so the binding is upstream's
enforcement, not something this code checks — but it is measured fact now, and it
is the reason every byte must originate from the box.

## Two different tokens

Easy to conflate, and they fail in different ways. Keep them apart.

| | **Upstream host token** | **Relay playback token** |
|---|---|---|
| Minted by | the stream host, `<origin>/generate.php` | us, `mintToken()` |
| Shape | JWT, ~4h, bound to caller IP /24 | `<exp>.<base64url(HMAC-SHA256(exp))>`, 6h (`RELAY_TOKEN_TTL`) |
| Signed with | theirs | `RELAY_SIGNING_KEY` |
| Lives in | the upstream URL (`__TOKEN__` / `?token=`) | `/hls?…&t=` |
| Cached | per origin, in `hostTokenCache`, with in-flight de-dupe | not cached — fresh per `/resolve`, including cache hits |
| Purpose | upstream lets us fetch | stops `relay.fiesta.show` being an open proxy |
| When it fails | `generate status 429` → per-origin cooldown, maybe global backoff | `/hls` → `403 bad or expired token` |

A stream host is effectively per-title — five consecutive films resolved to five
different origins — so one origin refusing says nothing about the others. That
distinction drives the cooldown design below.

## Anti-bot: a residential IP and a real browser

**There is no paid proxy any more.** No Webshare, no `STREAM_PROXY_URL`, no
`STREAM_PROXY_RETRIES`, no `undici` `ProxyAgent`, no `rotate` username keyword —
the live relay contains none of it. The home residential IP *is* the answer to
the datacenter-IP 403, and the headless browser is the answer to Turnstile.

**Detection, and its two blind spots.** `checkTurnstile` fires on
`cf-turnstile|challenges.cloudflare.com` appearing in place of the expected body.
Six call sites cover five step labels — `layer2`, `layer3`, `api`, `vs_src` (both
paths) and `embed` (**plain path only**). So:

- A challenge on the *embed* hop during a browser resolve is never detected; it
  surfaces as `player_iframe data-api not found in embed`.
- **Nothing on the playback path checks at all.** `fetchUpstream`, `quickServes`,
  `masterServes` and `getHostToken` look only at status codes, so a challenge
  served on a master or a segment is reported as a born-dead master or a bare 502.

**Fallback.** A Turnstile error short-circuits straight to
`resolveMasterBrowser`. Note that `resolveMaster`'s `for (i = 0; i < 3; i++)` is
**not** a 3-attempt budget — it only loops again when the message matches
`/fetch failed|timeout|ECONNRESET|terminated/i`; every other non-Turnstile error
throws on the first pass. Mind the gap in that regex: Playwright's "Request timed
out after 20000ms" and the relay's own "browser solve timed out" both say *timed
out*, which it does not match.

- `playwright-core@1.58.0` — the *core* package, so it ships no browser.
  `resolveChromePath()` finds the newest cached `chromium-*` build under
  `~/Library/Caches/ms-playwright` (`Google Chrome for Testing.app`, arm64 or
  x64), or honours `RELAY_CHROME_PATH`.
- One long-lived browser + context (`getContext`), recreated if it dies, so a
  `cf_clearance` cookie stays warm within the process. Two qualifications the
  code's own comment omits: it is **lazy** — `ctxPromise` stays `null` until the
  first Turnstile fallback, so on a box that hasn't been challenged since its last
  restart there is no Chromium running at all (and no idle teardown either, only
  `shutdown()`); and "warm" means **in-process only** — it's `browser.newContext`,
  not `launchPersistentContext`, with no `storageState` anywhere, so the cookie
  dies with the process. launchd has restarted it 27 times over the current log.
- Fingerprint: UA `Chrome/147.0.0.0` (its own, not from the rotation pool),
  `locale: en-US`, `timezoneId: Europe/Dublin`, 1280×800,
  `--disable-blink-features=AutomationControlled`, and an init script masking
  `navigator.webdriver`.
- It drives a real page load only for layer 2, waits up to 45s (polling 500ms)
  for `window.CFG =` to appear, then re-reads the **raw server HTML** via
  `ctx.request.get` rather than the live DOM — the player's own JS mutates and
  strips the inline config before you could read it off the DOM.
- `withBrowserLock` serialises browser resolves. Parallel Turnstile solves from
  one IP race each other and lose.
- Set `RELAY_FORCE_BROWSER=1` to skip the plain attempt entirely when the
  operator knows the IP is permanently gated.

**How often it's needed — and a warning.** Do not read the log's lifetime totals
(536 `via=plain` / 9 `via=browser`) as "a rare but working fallback". All 9
browser resolves sit in log lines 40–262, in an era whose error strings still say
`rcp`/`prorcp` and which predates the current line format; **since the last
restart it is 65 plain, 0 browser, 0 Turnstile detections.** The fallback has not
fired once under the current file or the current embed chain, and
`resolveMasterBrowser` now waits on `window.CFG =`, a selector that only exists
post-2026-08.

So treat the Playwright path as **unexercised, not merely rare.** Proving it still
works needs one deliberate `RELAY_FORCE_BROWSER=1` resolve on the box. Two related
unknowns ride on the same test: whether the cached Chrome-for-Testing build still
launches (an OS upgrade or Gatekeeper would surface only at the worst moment), and
whether `checkTurnstile`'s two-token regex still matches what Cloudflare serves —
if the challenge markup changed, detection fails *silently* and you get
`CFG.playerUrl not found in layer2` instead, never reaching the fallback at all.

Each resolve emits a greppable `[stats] via=plain|browser` line, so the rate
survives restarts — but count from the last restart banner, not the whole file:
`grep -c 'via=browser' relay.log`.

**UA rotation.** A pool of 8 realistic device UAs (macOS/Windows Chrome, Safari,
Edge, Firefox, iPhone, iPad, Pixel). Upstream sees what looks like a mix of
household devices rather than one client hammering it.

The real invariant is narrower than the code's own comment claims, so read this
before "fixing" either: **one UA is consistent across a whole playback session**
(master → variants → segments), threaded by `rewritePlaylist`'s `&ua=<index>` on
every child URL and re-validated on each `/hls` request. But it is **not** the UA
that did the walk. `nextUaIndex()` is called twice per cache-miss resolve and the
cursor advances in between — once for the walk (and therefore for `generate.php`,
`quickServes` and `masterServes`), then again inside `respondWithMaster` for the
master URL handed to the browser. So playback runs on the *next* pool entry after
the one that fetched the host token. On a cache hit no walk UA is drawn at all.
The comment above `UAS` asserts the single-UA-for-everything version; it is wrong.

## Staying up under upstream pressure

Most of the complexity in the live file is not extraction — it's *not making a
bad upstream day worse*. All of it was written against real observed outages.

| Mechanism | Default | What it does |
|---|---|---|
| Resolve cache | `RELAY_RESOLVE_CACHE_TTL=600`s, `RELAY_RESOLVE_CACHE_MAX=500` | Same `(type,id,s,e,srv)` reuses the upstream master with no new walk. Token + UA are still minted fresh per call, so sessions stay internally consistent. |
| In-flight de-dupe | — | Concurrent identical `/resolve` calls await one walk. Caps a thundering herd at one walk per key. |
| Per-front breaker | `RELAY_BREAKER_COOLDOWN=90`s | Trips only on `(embed\|vs_src\|layer2\|layer3\|api\|wasm) status <code>` with code ≠ `404`. `tripFront` only ever *extends* a cooldown, never shortens it. |
| Half-open probe | `RELAY_BREAKER_PROBE=15`s | When *all* fronts are cooling, one request every 15s is let through to discover recovery instead of blind-refusing for the full 90s. `probing` is global and bypasses the skip for **every** front in `order`, so that one request may try both. A front that serves closes its breaker early. |
| Per-origin token cooldown | `RELAY_TOKEN_COOLDOWN=120`s, cap 900s | A `generate.php` refusal is remembered (honouring `Retry-After` when given). Previously only *successes* were cached, so a single 429 meant the next request hammered the same endpoint immediately — that turned a short throttle into a sustained outage. |
| Global token backoff | ≥3 distinct origins refusing within 60s | Several *different* hosts refusing means the limit is on **our IP**, not on any host — so back off everything. The per-front breaker structurally cannot see this: fronts and stream origins are unrelated axes. |
| Resolve retries | `RELAY_RESOLVE_TRIES=1` | **Deliberately lowered from 2–3** while upstream is rate-limiting this IP; extra retries on a 429 amplify pressure and prolong the window. Raise it back once upstreams are healthy. |
| `/hls` retries | `RELAY_HLS_TRIES=3` | The CDN 502s individual fetches at random; the same URL succeeds on retry. Backoff `150ms × attempt`. |
| Born-dead masters | `masterServes` | Some freshly minted stream tokens 502 consistently, and a master that won't serve is meant to trigger a *fresh resolve* rather than a fetch retry. **Currently inert**: the re-resolve lives inside the `RESOLVE_TRIES` loop, which runs once at the shipped default of 1 — it logs `re-resolving (1/1)` and falls straight through. The log confirms it: every historical born-dead line is `(n/2)`/`(n/3)` from older builds, `(1/1)` has never appeared, and there are none at all since the current build's restart. If no front yields a serving master, the first resolved master is returned anyway as a fallback. |

Retry policy is deliberately asymmetric: genuine network errors
(`fetch failed|timeout|ECONNRESET|terminated`) retry; HTTP status errors do not.
A 5xx/429 from upstream means overload — retrying is how you get rate-limited.

A note on the breaker's history, so nobody "simplifies" it back: `generate.php`
failures are deliberately **not** in the trip list. They were once, and because
the token comes from the per-title *stream origin* while the breaker is per
*front*, one sick host took every other title down for 90s — **27 of the 30
trips in the log were exactly that**.

## The relay's HTTP surface

```
GET /healthz                            → "ok"                       (no auth)
GET /resolve?type=&id=&s=&e=&srv=       → { master, upstream, server } (Bearer RELAY_SECRET)
GET /hls?u=<b64url(absUrl)>&t=<tok>&ua= → rewritten playlist, or segment bytes
```

- **`/resolve`** is for Vercel only, `Authorization: Bearer <RELAY_SECRET>`
  compared with `timingSafeEqual`. `id` must match `/^tt\d+$/`. `srv=1|2` pins a
  front; anything else tries `[1, 2]` in order. `master` is an absolute
  `RELAY_PUBLIC_URL + /hls?u=…&t=…&ua=…`; `server` echoes which front won.
  Errors: `401` unauthorized, `400` bad id, `500` `RELAY_PUBLIC_URL` unset,
  `503` + `Retry-After` when every front is cooling, `502` otherwise.
- **`/hls`** is for the browser and is token-gated, not secret-gated. `u` is the
  base64url absolute upstream URL; it must pass `assertPublicHttps` — https only,
  and the resolved address must not be private (`isPrivateAddr` blocks
  `0/10/127/169.254/172.16-31/192.168/≥224`, `::1`, `::`, `fc`/`fd`/`fe80`).
  That guard protects the home LAN if `RELAY_SECRET` ever leaks.
- **Playlists** (`content-type` contains `mpegurl`, or the `.m3u8` test matches —
  which runs against the **whole** target URL, unlike the `looksTs` segment test,
  which only sees the pathname) are
  rewritten by `rewritePlaylist`: every media line *and* every `URI="…"` inside
  `#EXT-X-KEY|MAP|MEDIA|I-FRAME-STREAM-INF` becomes a **relative**
  `/hls?u=…&t=…&ua=…`. Relative means children stay on the relay whatever the
  public hostname is. Served `application/vnd.apple.mpegurl`, `no-store`.
- **Any non-200 is collapsed to an uncacheable `502`** (`text/plain`, `no-store`)
  and logged as `[hls] segment upstream=<code> path=…`. Until 2026-09-13 the
  upstream status was copied through and then stamped `video/mp2t` +
  `immutable, max-age=1y` *unconditionally*, so an upstream 403/404/5xx error body
  was handed to the browser as a year-immutable MPEG-TS fragment. Reproduced on
  production before the fix: a 401 came back as `HTTP/2 401`,
  `content-type: video/mp2t`, `cache-control: public, max-age=31536000, immutable`.
  Because an explicit `max-age` makes an error response storable (RFC 9111 §3) and
  both Chrome and Safari store a `404` that carries one, one transient upstream
  blip became a **permanently** broken segment at a fixed timecode — surviving
  reloads, served from cache to every hls.js retry, and looking nothing like a
  network fault. Rewriting to 502 rather than forwarding the real status is
  deliberate: hls.js retries a 5xx, and 404 is the status browsers keep.
- **Segments** stream straight through —
  `pipeline(Readable.fromWeb(upstream.body), res)`, no buffering — and abort the
  upstream fetch when the client disconnects (seek, tab close, quality switch).
  Content type is forced to `video/mp2t` when the path looks like `.ts`/`.html`
  (upstream mislabels segments as `page-N.html`). `Cache-Control: public,
  max-age=31536000, immutable`. Every response carries `X-Fiesta-Source: relay`.
- **Upstream `Content-Length` is deliberately not forwarded** for segments.
  Node's `fetch` transparently decodes `Content-Encoding`, but the header still
  reports the *pre-decode* wire length; forwarding it understates the bytes we
  actually stream and corrupts HTTP framing on the keep-alive connection.
  Omitting it falls back to chunked encoding, which is correct either way.
- **CORS**: `RELAY_ALLOW_ORIGIN` is an optional comma list. Unset (the current
  state) means *reflect any origin*. `X-Fiesta-Source` is exposed.
- **No `Range` support at all** — the relay neither forwards a client `Range` nor
  passes `Accept-Ranges` through, and `rewritePlaylist` has no
  `#EXT-X-BYTERANGE` handling. Harmless for today's streams (version 3,
  full-segment TS, no byteranges), but an fMP4/byterange playlist would break
  outright, and a partial segment can never be resumed at the HTTP level.
- **Playlist error bodies get run through the rewriter.** `handleHls` passes
  upstream's status through but rewrites regardless of it, so a 403/502 HTML error
  page for an `.m3u8` target comes back as `application/vnd.apple.mpegurl` with
  its non-`#` lines turned into `/hls?u=…` links. Cosmetic, but it makes a
  captured "playlist" look corrupted when the real problem was a 403.

### What the token gate does and does not buy you

Worth being precise about, because it is weaker than "token-gated" suggests.

- **The token authorises nothing specific.** `mintToken` HMACs *only* the
  expiry: `` `${exp}.${hmac(String(exp))}` ``. It is not bound to the `u=`
  target, the title, the viewer's IP, or an Origin. So **any unexpired token
  lets its holder proxy any public https URL through `relay.fiesta.show` for up
  to 6 hours** — and every viewer is handed a valid token in the clear, inside
  the `master` URL. The gate stops casual open-proxy discovery; it is not an
  authorisation check. Binding the HMAC over `exp + u` would close this and
  appears to be a small change.
- **And those tokens are persisted in plaintext, off-relay, world-readable.**
  `/Library/Logs/com.cloudflare.cloudflared.err.log` on the box (root:wheel but
  world-readable, 4.1 MB, **unrotated**, going back to 2026-05-17) contains ~770
  lines of the form `dest=https://relay.fiesta.show/hls?u=…&t=<token>&ua=N`.
  Since a token authorises *any* public https URL, any local user on that
  multi-tenant box can lift a working open-proxy credential straight out of a log
  file. Fixing the token binding fixes this too; rotating `RELAY_SIGNING_KEY`
  invalidates the historical ones.
- **Playback sessions hard-expire at 6h.** `rewritePlaylist` reuses the
  *incoming* token verbatim for every child URL rather than re-minting, so a
  session that starts at T gets 403s on segments after T+`RELAY_TOKEN_TTL`.
  Fine for a film; not fine for a tab left open overnight and resumed.
- **`assertPublicHttps` is checked once, then bypassed by the fetch.** It
  resolves the hostname and rejects private addresses, but the subsequent
  `fetch` re-resolves the name itself and **follows redirects unchecked**. A
  DNS-rebind, or an upstream 302 to `http://192.168.x.x`, is not re-validated.
  Not known to have been exploited and not probed — the guard still stops the
  obvious `u=https://192.168.1.1/` case.
- **`s`/`e` are interpolated into the embed path unvalidated.**
  `pathSuffix += '/' + s + '-' + e` in `handleResolve`, and `api/stream.js`
  forwards `req.query.s`/`req.query.e` through without checking them. Reachable
  from the public internet via `/api/stream?type=tv&…`. The damage is bounded —
  the origin is still the front's — so the worst case is making the relay fetch
  some other path on `vidsrc.me`. Still, both ends should require digits.

## Files

| Where | What |
|---|---|
| **box** `/Users/ms/Server/relay.fiesta.show/relay.mjs` | **The real extractor.** 1219 lines. Ungitted. |
| **box** `…/.env.local` | `RELAY_*` secrets. Parsed by `relay.mjs` itself (not `--env-file`), and existing `process.env` wins. |
| **box** `…/relay.mjs.bak-*` | The only rollback mechanism. No git here — back up before editing. |
| **box** `…/relay.log` | stdout+stderr via launchd. **No rotation.** |
| **box** `…/scripts/autofix-watchdog.sh` | The self-repair watchdog — see below. |
| **repo** `api/stream.js` | Thin Vercel delegate → `$STREAM_RELAY_URL/resolve` with a Bearer header. Walks nothing itself. |
| **repo** `src/app/components/movie-player/*` | `<video>` + hls.js (native HLS only when MSE is absent, i.e. iOS Safari). Consumes `{ master, upstream, server }`. |
| **repo** `tools/fiesta-proxy/local-test-server.mjs` | Local harness — mounts `api/stream.js` and `api/subs.js` on `:3999`, loads `tools/fiesta-proxy/.env.local`. |
| **repo** `src/proxy.conf.json` | `ng serve` routes `/api/stream` + `/api/subs` → `:3999`. |
| **repo** `tools/fiesta-proxy/relay.mjs` | **Dead snapshot.** See below. |

`api/hls.js` was deleted in `1955290` ("chore: remove dead Webshare HLS proxy
(relay-only)"). The old version of this doc's file table listed it, plus a
`tools/fiesta-proxy/src/index.ts` Cloudflare Worker — that directory no longer
exists either.

## Tunables

All read by `relay.mjs` from the environment or `.env.local`.

**Required** (the process exits if either is missing): `RELAY_SECRET`,
`RELAY_SIGNING_KEY`. Also effectively required: `RELAY_PUBLIC_URL` — without it
`/resolve` returns 500.

**Currently set on the box**: `RELAY_PORT`, `RELAY_PUBLIC_URL`, `RELAY_SECRET`,
`RELAY_SIGNING_KEY`. Everything else runs on its default.

| Var | Default | |
|---|---|---|
| `RELAY_PORT` | `8787` | listen port |
| `RELAY_PUBLIC_URL` | — | public base, e.g. `https://relay.fiesta.show` |
| `RELAY_TOKEN_TTL` | `21600` (6h) | playback-token lifetime |
| `RELAY_ALLOW_ORIGIN` | unset → reflect any | CORS allowlist, comma list |
| `RELAY_RESOLVE_TRIES` | `1` | re-resolves per front (lowered on purpose, see above) |
| `RELAY_HLS_TRIES` | `3` | `/hls` upstream retries on 5xx |
| `RELAY_RESOLVE_CACHE_TTL` / `_MAX` | `600` / `500` | resolve cache |
| `RELAY_BREAKER_COOLDOWN` / `_PROBE` | `90` / `15` | per-front breaker |
| `RELAY_TOKEN_COOLDOWN` | `120` | per-origin `generate.php` cooldown (cap 900) |
| `RELAY_FORCE_BROWSER` | unset | `1` skips the plain-fetch attempt |
| `RELAY_CHROME_PATH` | autodetect | override the Chromium binary |

On the Vercel side it's just two: `STREAM_RELAY_URL`, `STREAM_RELAY_SECRET`
(which must equal the box's `RELAY_SECRET`).

## Run locally

Two terminals from the repo root:

```bash
node tools/fiesta-proxy/local-test-server.mjs   # /api/stream + /api/subs on :3999
npm start                                        # ng serve on :4200, proxies /api → :3999
```

Open `http://localhost:4200/movie/tt0111161`. (`vercel dev` is **not** usable —
its bundled vite can't serve Angular 20's dev output; use `ng serve`.)

**This will currently fail, and you have to fix the env file first.**
`tools/fiesta-proxy/.env.local` (gitignored, never committed) today contains
exactly one variable — `STREAM_PROXY_URL`, the **dead Webshare credential**.
Nothing reads it any more. What the harness actually needs is:

```
STREAM_RELAY_URL=https://relay.fiesta.show
STREAM_RELAY_SECRET=<the box's RELAY_SECRET>
```

Without those, `local-test-server.mjs` prints `STREAM_RELAY_URL unset` and
`/api/stream` returns `500 stream relay not configured`. The stale
`STREAM_PROXY_URL` line should be deleted and the credential rotated or
cancelled upstream — it is a live-ish secret for a service the stack no longer
uses.

Local dev resolves against the **live** relay; there is no local extractor.
Running `relay.mjs` from this repo instead will not work — it is dead code.

To hit the relay directly while debugging:

```bash
ssh mm
SECRET=$(grep '^RELAY_SECRET=' /Users/ms/Server/relay.fiesta.show/.env.local | cut -d= -f2- | tr -d '"')
curl -s -H "Authorization: Bearer $SECRET" \
  'http://127.0.0.1:8787/resolve?type=movie&id=tt1375666'
curl -s -H "Authorization: Bearer $SECRET" \
  'http://127.0.0.1:8787/resolve?type=tv&id=tt0944947&s=1&e=1'
```

Both should return `{"master":"https://relay.fiesta.show/hls?…"}` with no `error`
key; curl that `master` and confirm the body starts `#EXTM3U`.

## When extraction breaks: how to re-trace

The old advice here was "re-trace with a browser network capture". That is no
longer sufficient on its own — hop 6 is WASM-decrypted, so a capture shows you an
opaque base64 blob where the URLs used to be. The procedure that actually
root-caused both 2026-08 migrations was manual, hop by hop:

1. **Confirm it's structural, not a single title.** The signature is the *same*
   error across *several different* titles: `grep '\[resolve\]' relay.log | tail -50`.
   One title failing is that title's own problem; `status_code 404` just means
   the title isn't on that front.
1. **Rule out the box's own egress first** — it costs one command and it is the
   failure mode most likely to fool you. `curl
   https://www.cloudflare.com/cdn-cgi/trace` on the box must report `warp=off`.
   Cloudflare WARP is installed there and its daemon reports `Connected`; if it
   ever starts routing traffic, the residential IP this whole design depends on
   becomes a Cloudflare datacenter IP and *every* hop starts 403ing — which looks
   identical to an upstream redesign and isn't one.
2. **Read the resolver first** so you know what shape each hop is expected to
   return: `fetchText`, `walkFromEmbed`, `walkFromLayer2`, `resolveMasterOnce`,
   `resolveMasterBrowser`, `extractPlayerIframeApi`, `extractInlineJSON`,
   `decryptStreamUrls`, `getHostToken`.
3. **Curl the chain by hand** for a known-good title (`tt1375666` movie,
   `tt0944947` s1e1 tv) with a realistic desktop UA, and chain each `Referer` as
   the **post-redirect** URL of the previous hop. That Referer mismatch has
   produced false 403s before and will waste an hour if you forget it.
4. **Diff the real response against what the code parses**, using the signature
   table below to jump straight to the hop. Make the minimal change; don't
   rewrite working code.
   - At hop 5, look at `data.stream_urls` first. **If it's an array you are done —
     no decryption is involved.** Only a *string* needs WASM.
   - If it is a string, there is nothing to reverse-engineer: the decryptor's URL
     arrives in the same JSON response as `vs.wasm_url`. Fetch it with exactly two
     headers (`User-Agent`, `Referer: <backend origin>/`), then in plain `node`:
     `WebAssembly.compile` → a **fresh** `instantiate(mod, {})` per decrypt (the
     bump allocator never resets) → `ptr = alloc(len)`, copy the base64-decoded
     blob in, `outLen = decrypt(ptr, len)`, read UTF-8 from **`ptr + 12`** (12-byte
     nonce) for `outLen` bytes. The whole ABI is three exports: `memory`, `alloc`,
     `decrypt`.
   - The output is a **newline-separated list**, not one URL, and every entry
     403s until you stamp a `generate.php` token into it. *"I decrypted it and it
     still 403s"* is the expected intermediate state, not a failure.
   - For a playback test send **both** `Referer` and `Origin`. Don't copy
     `quickServes`'s headers — it omits `Origin`.
   - Expect to burn the same per-/24 `generate.php` budget production is using.
     Your tracing will produce real `generate cooling globally` lines in the log.
5. **Patch both paths if the hop is shared.** Anything at or past layer 2 is
   shared between `walkFromEmbed` and `resolveMasterBrowser` through the `get`
   argument — but hops 1–2 are duplicated in `resolveMasterBrowser`. Grep for the
   function to find every call site.
6. **Verify on the box**: `node --check relay.mjs` →
   `launchctl kickstart -k gui/$(id -u)/show.fiesta.relay` → the two curls above
   → fetch the returned master → `tail -20 relay.log` for a clean restart.
   **Back the file up first** (`cp relay.mjs relay.mjs.bak-$(date -u +%Y%m%dT%H%M%SZ)`);
   there is no git there, so there is no free rollback.

If the *backend domain* rotated again, the only constant to update is
`STREAM_BACKEND_ORIGIN` (used for the `Referer`/`Origin` on CDN fetches). The
walk discovers the live domain itself from layer 2's URL.

### Failure signature → which hop broke

Every resolve error string the relay can emit, in walk order. `grep '\[resolve\]'
relay.log`, match the message here, go straight to that hop.

| Hop | Error string |
|---|---|
| embed HTML | `embed status <code>` |
| `#player_iframe` loses/renames `data-api` | `player_iframe data-api not found in embed` |
| `vs_src.php` gate | `vs_src status <code>` · `vs_src response not valid json` · `vs_src.src not found` |
| layer 2 | `layer2 status <code>` · `CFG.playerUrl not found in layer2` |
| layer 3 | `layer3 status <code>` · `CONFIG not found in layer3` · `CONFIG.api not found in layer3` |
| data API | `api status <code>` · `api response not valid json` · `api status_code <n>` |
| encryption on, no decryptor named | `stream_urls encrypted but no vs.wasm_url in api response` |
| WASM fetch | `wasm status <code>` |
| **WASM ABI change** (`alloc`/`decrypt`/`memory` renamed, or nonce ≠ 12 bytes) | **no named error** — a raw `TypeError` surfaces as `[resolve] … <stack-ish message>` |
| host token | `generate status <code>` → per-origin cooldown, then maybe `generate cooling globally <N>s` |
| all candidates dead | `candidate did not serve: <origin>` · `no candidate stream host served` |
| backend domain rotates | **nothing in the walk** — it reads the origin from layer 2's URL. But `Referer`/`Origin` go stale → 403s at `quickServes`/`fetchUpstream`. One constant: `STREAM_BACKEND_ORIGIN` |
| `EXT-X-KEY` appears | does **not** break — the URI is rewritten through `/hls`, never decrypted |
| byteranges / fMP4 appear | **breaks silently** — no `Range` handling anywhere |

Two failures are un-named and will point you at the wrong hop:

- **The WASM ABI** throws a bare `TypeError` from the decrypt block.
- **`extractInlineJSON`** matches `window.CFG = {…};` non-greedily up to the
  **first `};`**. The day that literal contains a nested object, or a `};` inside
  a string, `JSON.parse` fails and you get `CFG.playerUrl not found in layer2` —
  which reads like a markup change at layer 2 and isn't.

### There is a self-repair agent that may get there first

`scripts/autofix-watchdog.sh` runs every 300s under launchd
(`show.fiesta.relay.autofix`). It tails new `relay.log` lines from
`.autofix/checkpoint`, filters out benign `404`s and Turnstile timeouts, and if
the *same* error hits ≥3 **distinct titles** it invokes a headless
`claude -p` agent with `--max-budget-usd 3` and `Read,Edit,Bash` scoped to that
directory, told to diagnose, patch `relay.mjs`, restart, verify, append to
`.autofix/autofix.log`, and **revert + log `NEEDS HUMAN`** if it can't verify
clean. 1200s cooldown, `mkdir`-based lock with 1200s stale recovery, and a macOS
notification on completion.

**It has never fired.** `.autofix/autofix.log` does not exist, `watchdog.log` is
0 bytes. Both 2026-08 migrations were fixed by hand, before this existed.

**Disable it before you edit `relay.mjs` by hand** — it can patch the file under
you mid-edit:

```sh
launchctl bootout gui/$(id -u)/show.fiesta.relay.autofix      # before
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/show.fiesta.relay.autofix.plist   # after
```

Also note its syntax cannot be checked with `bash`: the script is `#!/bin/zsh` and
the box's `bash` is 3.2, which fails to parse it — **`bash -n` reports a syntax
error on the pristine original**. Use `zsh -n`.

**Why it has never fired is an accident, not a design margin.** It groups
candidates by the error message text, so the loudest current error —
`generate cooling globally <N>s` — hashes to a *different* key for every seconds
value, fragmenting ~20 distinct strings of 2–4 hits each and never reaching the
threshold. The one genuinely groupable structural message right now,
`CONFIG.api not found in layer3`, has hit only 2 distinct titles per window.

**And it can fire on a pure upstream throttle.** Its filter excludes only
`status_code 404` and `/turnstile/i`; everything else shaped like
`[resolve] ttN srv=N …` is a candidate. Historical distinct-title counts clear
`MIN_DISTINCT_TITLES=3` easily — `player_iframe not found in embed` 13,
`embed status 429` **11**, `prorcp status 429` 6, `generate status 429` 6,
`master born dead, re-resolving (1/3)` 6, `CONFIG.api not found in layer3` 6. So a
rate-limit day or a run of born-dead masters can dispatch a `claude -p` agent with
`Read`/`Edit`/`Bash` to hunt a markup change that never happened, editing the live
production file with no git underneath it. `embed status 404` (a title-missing case
on a different code path) also slips past the `status_code 404` filter.

Before you edit `relay.mjs` yourself: check `.autofix/lock.d` for a run in
progress, and mirror its verification procedure (step 6 above) when you're done.

## Known limits and current state

- **The relay is the whole system's single point of failure**: one home machine,
  one home internet connection, one ungitted file, one Cloudflare tunnel. If the
  box is off, nothing plays — there is no second path to a stream.
- **Upstream is rate-limiting this IP right now.** `relay.log` is full of
  `generate cooling globally` and `[breaker] srv=2 skipped`. That is the reason
  `RELAY_RESOLVE_TRIES` sits at 1. Resolve failures during a cooling window are
  expected and are *not* a code bug — the watchdog deliberately ignores them.
- **Resolve latency**: a cold resolve is a full 8-hop walk (~1–4s), plus ~2s more
  if it falls back to the browser. Cached 600s at the relay and 300s at Vercel's
  CDN.
- **`relay.log` lines are timestamped from 2026-09-13 onward**, via a one-time
  wrap of `console.log/error/warn` near the top of the file. Lines *before* that
  restart have no timestamp, so any before/after comparison has to start from the
  `fiesta relay listening` banner of that restart. **This shifted every awk field
  position by one and broke a `^\[resolve\]` anchor, so
  `scripts/autofix-watchdog.sh` was updated in the same window** — its grep is now
  `^[^ ]+ \[resolve\] …` and its awk reads `$3`/`$5..NF`. If you ever revert the
  timestamps, revert the watchdog too, or it will silently match nothing.
- **`relay.log` never rotates** either. It grows unbounded (~1900 lines now). The
  watchdog handles truncation gracefully, but nothing truncates it.
- **Order the `.bak` files by filename, never by `ls -lt`.** `cp` preserved the
  original mtimes, so the two backups' mtimes are one minute apart (both 7 Sep)
  while their names say 2026-09-07 and 2026-09-09. The name is the truth.
- **All in-memory state resets on restart**: resolve cache, host tokens,
  breakers, cooldowns, `via=` counters. A restart during an upstream throttle
  discards the cooldowns protecting you from it.
- **TV** uses `?type=tv&s=&e=` and a different layer-3 shape
  (`CONFIG.streamBase`, no `CONFIG.api`) — so a movies-only test can pass while
  TV is broken. Always test both.

## The repo snapshot is dead code

`tools/fiesta-proxy/relay.mjs` (369 lines) is not a mirror of production and has
not been for months. It still implements the pre-migration chain — it greps the
embed HTML for `src="//cloudnestra.com/rcp/…"`, a host that stopped serving this
in 2026-08 — so **running it would fail on every title**, not merely lag behind.

Entirely absent from it: the `vs_src.php` gate, `CFG`/`CONFIG` parsing, WASM
`stream_urls` decryption, `generate.php` host tokens, the two fronts and
`srv=1|2`, the circuit breaker and cooldowns, the resolve cache and in-flight
de-dupe, UA rotation, the Playwright Turnstile fallback, and `/healthz`-adjacent
stats. It does carry the segment streaming fix (`pipeline`/`Readable.fromWeb`),
which is why it looks deceptively current.

Nothing syncs the two. **Never copy the repo file over the live one** — it would
silently delete every capability listed above. Whether to properly reconcile it
(a several-hundred-line diff) or delete it and treat the box as the only source
of truth is an open question for the maintainer; until then, treat it as a
historical artifact and read the box.

See `docs/stream-proxy-architecture.md` for the runtime/deployment model —
what runs where, who pays for the bandwidth, and the failure modes.
