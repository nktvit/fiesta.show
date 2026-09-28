# fiesta-tv-lite

A separate, downleveled React 17 client for pre-2018 smart-TV browsers
(Samsung Tizen 3.0 / Chromium ~47 and anything else too old for the Angular
app's `Proxy` requirement). `middleware.js` at the repo root rewrites those
User-Agents to `/lite/index.html`; the root `npm run build` builds this
package first and copies `tv/dist` into the Angular output as `/lite`.

## Routes

Path-based and identical to the main site (`src/app/app.routes.ts`), so any
link works on both and the middleware just swaps the bundle:

| URL | Screen |
| --- | --- |
| `/` | home shelves |
| `/search?query=…` | search (query kept in the URL via replaceState) |
| `/movie/:id[?type=tv&s=1&e=2]` | details (`:id` is `tt…` or a TMDB number) |
| `/movie/:id?play=1[&type=tv&s=&e=]` | fullscreen player |
| `/person/:id` | person credits |
| `/genre/:id`, `/top-rated`, `/tv` | paginated grids |
| anything else | home (same as the main app's `**` redirect) |

Legacy `#/title/…` and `#/watch/…` hashes from the first version are
rewritten to these paths on load.

## Player

- No native `<video controls>`: the built-in bar on TV browsers is tiny and
  its CC button is unreachable with a remote. Controls are our own, large,
  and D-pad focusable (`src/screens/Player.tsx`).
- Subtitles are fetched as text and drawn into an overlay (`src/subtitles.ts`)
  instead of `<track>`, which old engines fetch but never paint. Track choice
  is stored under the same `fiesta:subtitle-pref` key the main site uses.
- Fullscreen is requested inside the Play click handler (needs a gesture)
  and dropped when leaving the player.
- Stream resolve goes relay-auto first, then `srv=2`; a video `error` on the
  first attempt also retries with `srv=2`. "Try again" flips servers.
- Resume position shares `fiesta:playback-progress:*` with the main site.

Remote keys: arrows move focus (spatial, `src/remote.ts`); on the video
itself Enter = play/pause, Left/Right = ±10 s, Down = controls. Tizen media
keys (play 415, pause 19, play/pause 10252, stop 413, rewind 412, forward
417) and Back (10009 / Backspace / Escape) are handled.

## Constraints

Chromium 47: no CSS Grid, custom properties, flex `gap`, `aspect-ratio`,
`sticky`, `clamp()`, `:focus-visible`; no ES2015 syntax in the output (Babel
targets `chrome: 47`, webpack runtime forced to ES5, Terser `ecma: 5`);
`video.play()` may not return a Promise (`src/util.ts`); `scrollIntoView()`
only in its no-argument form.

## Local testing

The bundle only talks to relative `/api/*`, so serve `dist/` under `/lite/`
with an SPA fallback and proxy `/api` to production. Desktop Chromium can't
play the HLS master natively, so mock `/api/stream` with an MP4 to exercise
the player (a `verify` script for this lives in the session scratchpad, not
the repo).
