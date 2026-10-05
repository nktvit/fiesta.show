# Music tab: Monochrome feature port, master list

This list merges the 317 raw entries from the Monochrome inventory (slices: playback, lyrics, audiofx, ui,
library, social, catalog and the Fiesta baseline) into one deduplicated list. The work packages that build it
are in `docs/music-work-packages.json`. Each line gives the package that owns the feature.

Status values (updated by package Z, integration run of 2026-10-05):
- **DONE (Pn)**: built by work package Pn and covered by its e2e script `tools/e2e/music-<pn>.mjs`; the whole set
  (`tools/e2e/music-all.mjs`, 15 scripts) passes locally against one dev server with 30 s PREVIEW playback.
  Caveats are written after the status. "DONE" is not "verified with full-length audio": no FULL-playback run
  was possible in this run (see docs/handoff.md, Music section).
- **DEFERRED**: not built in this run; the reason follows.
- **SKIP**: out of scope; the reason follows.
- **NEEDS-KEY**: buildable, but only once the owner supplies a key. Code that exists ships inactive until then.
- (Planning status before the run was **DONE (Pn)**; every BUILD item is now DONE or DEFERRED.)

Scope rule, approved by the owner: build everything that runs client-only or through `/api/music` with the
existing TIDAL credentials. All state is per visitor, in localStorage or IndexedDB under `fiesta:music:*`,
with no accounts. Monochrome is Apache-2.0, so ported files carry a "Ported from Monochrome js/x.js" header.
The am-lyrics engine is MPL-2.0 and is ported as native Angular code. Ported lyrics files keep the MPL header.

## 1. Playback engine (PB)

1. **PB01** Play/pause state machine: the toggle shows a spinner while loading. If the element errored or has no source, it reloads the current track instead of resuming. **DONE (F0)**
2. **PB02** Autoplay-blocked recovery: catch `NotAllowedError`/`AbortError`, set `autoplayBlocked`, and resume on the next user gesture or `visibilitychange`. **DONE (F0)**
3. **PB03** Race-safe loading: a generation token cancels stale manifest and segment work. It exists today and is kept across both decks. **DONE (F0)**
4. **PB04** Next/previous: previous restarts the track if more than 3 s have played. Next respects shuffle, repeat and autoplay. `canNext`/`canPrev` signals drive the buttons. **DONE (F0)**
5. **PB05** Skip unavailable tracks: on `unavailable`, show the toast "Couldn't play X, skipping" and auto-advance. A loop guard stops after one full pass. This is a setting. **DONE (F0)**
6. **PB06** Error handling and retry: classified errors; on `unsupported` or a decode error, retry once a quality tier lower. The 401 relay retry stays server-side. **DONE (F0)**
7. **PB07** Seek clamp and ±10 s skip: `seek()` clamps to [0, duration − 0.25]. `seekBy(±s)` backs the shortcuts and Media Session. **DONE (F0)**
8. **PB08** Volume and mute: volume 0..1 and a mute toggle, both persisted. Mouse wheel works on the volume control. **DONE (F0 engine, P1 UI)**
9. **PB09** Exponential volume curve: an optional cubic perceptual curve. **DONE (F0)**
10. **PB10** ReplayGain: modes off/track/album plus a preamp (−15..+15 dB). Uses the `trackReplayGain`, `trackPeakAmplitude`, `albumReplayGain` and `albumPeakAmplitude` fields from TIDAL `playbackinfo`, clipped to peak. Port of `js/replay-gain.js`. **DONE (F0)**
11. **PB11** Playback speed and preserve pitch: 0.25–4× (presets 0.5, 0.75, 1, 1.25, 1.5, 2), plus a `preservesPitch` toggle, both persisted. **DONE (F0 engine, P1 UI)**
12. **PB12** Shuffle: Fisher-Yates with the current track pinned first. Turning shuffle off restores the original order. Add and remove keep both orders consistent. **DONE (F0)**
13. **PB13** Repeat: off / all / one, cycled by the button and honoured on `ended`. **DONE (F0)**
14. **PB14** Queue editing API: add to end, play next, remove, clear upcoming, wipe, move (reorder), playAt and setQueue. **DONE (F0)**
15. **PB15** Queue persistence: the queue (minified tracks), original order, index, position, shuffle and repeat survive a reload. The restored track loads paused at its old position. **DONE (F0)**
16. **PB16** Preload next track: 45 s before the end, a standby deck fetches the next manifest, the init segment and the first ~10 s. **DONE (F0)**
17. **PB17** Gapless playback: when on, the player swaps to the preloaded deck at `ended`, with no reload gap. This is a real setting, not Monochrome's dead toggle. **DONE (F0)**
18. **PB18** Crossfade: an equal-power fade of 1–12 s between the two decks. It is disabled with a note where element volume is read-only (iOS). **DONE (P5 via F0 hook)**
19. **PB19** Silence removal: skip leading silence and advance early at trailing silence, using waveform bounds. Opt-in. **DONE (P5 via F0 hook)**
20. **PB20** Sleep timer: presets 5/10/15/30/45/60/90/120 min, a custom time and "end of current track". An optional 10 s fade-out. A countdown signal and cancel. **DONE (F0 engine, P1 UI)**
21. **PB21** Media Session extras: seekforward and seekbackward, `setPositionState`, `playbackState`, stop, and artwork at 3 sizes. **DONE (F0)**
22. **PB22** Streaming quality choice: Auto / Low / High / Lossless / Hi-Res. Auto picks the best tier the browser decodes in MSE. A fallback ladder steps down on unsupported codecs. **DONE (F0, setting UI P11)**
23. **PB23** Hi-Res tier: `HI_RES_LOSSLESS` is added to the manifest action (24-bit FLAC; needs the user or relay session; badge "Hi-Res"). **DONE (F0)**
24. **PB24** Listening history: a track counts as played after 10 s. Kept as a ring buffer of 200. **DONE (F0)**
25. **PB25** Player event bus: `trackstart`, `trackend {playedSeconds, completed}`, `skip`, `seek`, `queuechange` and `error` callbacks, used by history, the tracker and the scrobblers. **DONE (F0)**
26. **PB26** Radio: start from a track, album, artist or playlist. The queue is seeded from TIDAL's track/artist mix (falling back to similar artists' top tracks) and refilled as it runs low. A recently played ring of 100 avoids repeats. **DONE (P9)**
27. **PB27** Autoplay when the queue ends: a toggle, off by default, that appends recommendations seeded by the last tracks. **DONE (P9 via F0 hook)**
28. **PB28** Listening tracker: completion ratio, skip detection (<5 s or <30 %) and artist affinity, kept on the device only. Port of `js/listening-tracker.js`. **DONE (P9)**
29. **PB29** Smart recommendations: seed scoring with a completion bonus and a skip penalty, filtering out blocked items. Port of `js/smart-recommendations.js`. **DONE (P9)**
30. **PB30** Haptics: `navigator.vibrate(10)` on transport taps where supported. This is a setting. **DONE (P1)**
31. **PB31** Artist popular-tracks pagination as queue continuation. **SKIP**: autoplay and radio cover this.
32. **PB32** Dolby Atmos, spatial detection and auto-binaural. **SKIP**: the MSE player has no Atmos or multichannel source.
33. **PB33** Android foreground-service keep-alive. **SKIP**: it is Capacitor-only.
34. **PB34** Alternate stream sources (tracks.monochrome.st, Turnstile "unified" API, Deezer-by-ISRC). **SKIP**: third-party or grey-area streams. Fiesta streams only from TIDAL through its own proxy.
35. **PB35** HiFi instance list and failover. **SKIP**: Fiesta calls TIDAL from its own function.

## 2. Player bar and Now Playing UI (UI)

1. **UI01** Player bar controls. On desktop: shuffle, prev, play, next, repeat (with a "1" badge in repeat-one), seek, volume and mute, speed, sleep, queue, lyrics, like and expand. On mobile: a compact layout of cover/title (tap to expand), like, play and next. Existing selectors and aria-labels are kept. **DONE (P1)**
2. **UI02** Seek bar polish: a hover-time tooltip and drag preview (seek happens on release). Keyboard steps of 5 s. It stays a native `input[aria-label=Seek]`. **DONE (P1)**
3. **UI03** Volume control: a slider with the wheel, mute, a keyboard-accessible popover on tablet, and hidden on phones, where the OS volume is used. **DONE (P1)**
4. **UI04** Speed popover with presets and a pitch toggle. **DONE (P1)**
5. **UI05** Sleep-timer dialog, plus a countdown chip in the bar while it is armed. **DONE (P1)**
6. **UI06** Quality badge with a tooltip: Preview / AAC / Lossless / Hi-Res, and an explanation when it fell back from Hi-Res. **DONE (P1)**
7. **UI07** Tab title while playing: a "▶ Title · Artist" prefix that is restored on pause or stop. **DONE (P1)**
8. **UI08** Queue panel: a drawer on desktop, a bottom sheet on mobile. Sections are now playing, next up and recently played. Supports CDK drag reorder, remove, play at, clear, save the queue as a playlist, like and add to playlist. **DONE (P2)**
9. **UI09** Queue virtualization. **SKIP**: Fiesta queues are small (at most a few hundred).
10. **UI10** Fullscreen Now Playing: a big cover, title/artist/album links, full transport, next-up preview, a lyrics pane (side by side on desktop, a toggle on mobile), the visualizer, and the quality badge. **DONE (P2)**
11. **UI11** Swipe-down to dismiss on mobile, with a drag handle. **DONE (P2)**
12. **UI12** Cover click action (open Now Playing or go to the album) and a hide-UI mode where tapping the cover hides the chrome. **DONE (P2)**
13. **UI13** Dynamic accent colour taken from the cover, scoped to Now Playing and the album header, read through the image proxy. **DONE (P2)**
14. **UI14** Fullscreen cover options: rounded or square, a pointer tilt (off under reduced motion), and a CD spin mode. **DONE (P2)**
15. **UI15** A shared side-panel and bottom-sheet shell: resizable width (persisted), focus trap, Escape, scroll lock and safe area. **DONE (F0)**
16. **UI16** Toast host for player and library actions, with optional Undo. **DONE (F0)**
17. **UI17** Offline/online notice: a toast when the connection drops or returns. **DONE (F0)**
18. **UI18** Truncated-text tooltips: a `title` attribute on every truncated label (a convention, not a component). **DONE (all)**

## 3. Lyrics (LY), all in P3 unless noted

1. **LY01** Lyrics panel: a drawer or sheet with the L hotkey that refreshes on track change. The button is hidden while no track is loaded. **DONE (P3)**
2. **LY02** Lyrics pane inside fullscreen Now Playing (the `app-music-lyrics-view` component that P2 places). **DONE (P3)**
3. **LY03** Provider cascade, keyless and called straight from the browser with an 8 s timeout: owner file, then lrc.red (ISRC/match), BiniLyrics, Unison, LyricsPlus (4 mirrors, random 3 then binimum), LRCLIB, and the Genius scraper worker as the plain-text last resort. Results are cached in IndexedDB for 7 days. **DONE (P3)**
4. **LY04** Metadata resolution: title/artist/album/duration plus ISRC (F0 adds `isrc` to `MusicTrack`), with title cleaning for "feat.", "Remastered" and versions. **DONE (P3)**
5. **LY05** Source footer: the provider name, a "Switch source" control that cycles the cascade results, and songwriter credits. **DONE (P3)**
6. **LY06** Line-synced lyrics: binary search for the active line, highlight, smooth auto-scroll, and a pause on user scroll with a "Back to current line" pill. **DONE (P3)**
7. **LY07** Click a line to seek and play. **DONE (P3)**
8. **LY08** A 60 fps clock interpolated from the player position with rAF, paused when hidden. **DONE (P3)**
9. **LY09** Per-track timing offset in ±0.5 s steps, persisted per track id. **DONE (P3)**
10. **LY10** Word-by-word karaoke: a syllable wipe (CSS gradient driven by start and end times). **DONE (P3)**
11. **LY11** TTML parser: agents, duets, background vocals, song parts, embedded translation and transliteration (DOMParser). **DONE (P3)**
12. **LY12** Duet left/right alignment per singer. **DONE (P3)**
13. **LY13** Instrumental-gap indicator: three breathing dots for gaps over 5 s, static under reduced motion. **DONE (P3)**
14. **LY14** Unsynced plain-text lyrics view. **DONE (P3)**
15. **LY15** Visual options: blur/depth on non-active lines (off with reduced blur), reduced motion, and "hide played lines". **DONE (P3)**
16. **LY16** Highlight colour follows the Now Playing dynamic accent, otherwise indigo; Fiesta typography. **DONE (P3)**
17. **LY17** Right-to-left rendering for Arabic and Hebrew. **DONE (P3)**
18. **LY18** Romanization toggle for any script through the Google Translate `gtx` endpoint (`dt=rm`), degrading gracefully. **DONE (P3)**
19. **LY19** Translation toggle with a target-language picker (default: the browser language). **DONE (P3)**
20. **LY20** Japanese Romaji mode (Kuroshiro + kuromoji, lazy chunk, dictionary from jsDelivr). **DONE (P3)**
21. **LY21** Genius annotations mode. **DEFERRED, NEEDS-KEY**: a Genius client access token, used through a server proxy. Monochrome's hardcoded tokens must not be copied.
22. **LY22** Lyrics download from the panel in Auto / LRC / TTML / plain. **DONE (P3)**
23. **LY23** LRC/TTML sidecar files inside track and ZIP downloads. **DONE (P12)**
24. **LY24** Lyrics embedded in downloaded file tags. **DONE (P12)**
25. **LY25** Lyrics settings section, the L shortcut and palette entries. **DONE (P3, entries via P10)**
26. **LY26** Owner-supplied lyrics override: `/assets/music/lyrics/{trackId}.ttml|.lrc` wins over every provider. **DONE (P3)**
27. **LY27** Lyrics snippets in search results. **SKIP**: needs Apple Music developer tokens from a third-party minter.
28. **LY28** Loading skeleton, empty and error states, and a lazy-loaded lyrics chunk (`@defer`). **DONE (P3)**

## 4. Audio effects (FX), all in P4

1. **FX01** A shared AudioContext graph built lazily on the first gesture. It holds one MediaElementSource per deck element and resumes on `statechange`/`visibilitychange`. Port of `js/audio-context.js`. **DONE (P4)**
2. **FX02** Parametric EQ with 3–32 bands (peaking, low shelf, high shelf). **DONE (P4)**
3. **FX03** EQ preamp (−20..+20 dB). **DONE (P4)**
4. **FX04** 16 built-in EQ presets, interpolated to any band count. **DONE (P4)**
5. **FX05** Interactive parametric EQ graph on a canvas, with drag, wheel-for-Q and touch. **DONE (P4)**
6. **FX06** Per-band numeric controls and a node context menu (long-press on touch). **DONE (P4)**
7. **FX07** Mid/Side per-band EQ. **DONE (P4)**
8. **FX08** Parametric and M/S preset selector. **DONE (P4)**
9. **FX09** EQ text import/export in EqualizerAPO/Peace format. **DONE (P4)**
10. **FX10** Graphic EQ with vertical sliders (the default, simplest mode). **DONE (P4)**
11. **FX11** Save and delete custom graphic-EQ presets. **DONE (P4)**
12. **FX12** AutoEQ headphone-correction algorithm. Port of `js/autoeq-engine.js`. **DONE (P4)**
13. **FX13** Target curve library, lazy-loaded data. Port of `js/autoeq-data.js`. **DONE (P4)**
14. **FX14** AutoEQ headphone database browser (GitHub/jsDelivr index, cached in IndexedDB). **DONE (P4)**
15. **FX15** Import a custom measurement or target CSV. **DONE (P4)**
16. **FX16** AutoEQ saved profiles: one list with name and preview. **DONE (P4)**
17. **FX17** EQ mode switcher (Graphic / Parametric / AutoEQ), master enable and how-to notes. **DONE (P4)**
18. **FX18** Mono downmix (an accessibility toggle). **DONE (P4)**
19. **FX19** Crossfeed for headphones (bs2b-style). **DONE (P4)**
20. **FX20** Stereo widener (M/S width 0–2). **DONE (P4)**
21. **FX21** Binaural/DSP panel, trimmed to the stereo features. **DONE (P4)**
22. **FX22** Speaker/room EQ with microphone measurement. **SKIP**: needs mic permission and a room-measurement UX; low value for phone and headphone listeners. Ask the owner.
23. **FX23** 5.1/7.1 to binaural HRTF rendering. **SKIP**: no multichannel source.
24. **FX24** Auto-enable binaural for spatial audio. **SKIP**: no spatial source.

## 5. Visualizer, waveform, transitions (VZ), all in P5

1. **VZ01** Visualizer core: reads the analyser from P4's graph, beat detection, blended mode over the cover, paused when hidden, off under reduced motion unless the user opts in. **DONE (P5)**
2. **VZ02** Preset: Particles. **DONE (P5)**
3. **VZ03** Preset: LCD Pixels. **DONE (P5)**
4. **VZ04** Preset: Unknown Pleasures (WebGL, with a canvas-2D fallback). **DONE (P5)**
5. **VZ05** Preset: Butterchurn/Milkdrop. The `butterchurn` and `butterchurn-presets` packages are lazy-loaded only when picked. **DONE (P5)**
6. **VZ06** Preset: Kawarp cover-art warp (`@kawarp/core`, cover read through the image proxy). **DONE (P5)**
7. **VZ07** Preset picker, auto-cycle, and the `[` `]` `\` shortcuts. The canvas is recreated with no page reload. **DONE (P5, keys via P10)**
8. **VZ08** Visualizer layer inside fullscreen Now Playing, with a toggle and hide-UI. **DONE (P5 component, placed by P2)**
9. **VZ09** Waveform seek bar. Opt-in, because it computes peaks by decoding the LOW-quality rendition once per track and caching it in IndexedDB. Drawn behind the native seek input. **DONE (P5)**
10. **VZ10** Crossfade engine (PB18) and silence boundaries (PB19). **DONE (P5)**

## 6. Library (LB)

1. **LB01** Like/favourite tracks with a heart in the bar, rows, Now Playing and the queue. Stored per visitor. **DONE (F0 store, P6 UI)**
2. **LB02** Favourite albums, artists, TIDAL playlists and mixes. **DONE (F0 store, P6 UI)**
3. **LB03** Library page `/music/library` with tabs Tracks / Albums / Artists / Playlists / Mixes, filter-as-you-type, sort, grid/list view, and Play/Shuffle all liked. **DONE (P6)**
4. **LB04** Recently played page `/music/recent`: history grouped by day, play from here, clear history. **DONE (P6)**
5. **LB05** Recent-activity store (albums, artists, playlists and mixes visited) that feeds "Jump back in". **DONE (F0 store; written by pages)**
6. **LB06** Search-history store (last 10). **DONE (F0 store, P8 UI)**
7. **LB07** User playlists: create, rename, describe, delete, and set a cover (URL, or an auto 2×2 collage, or a downscaled data-URL up to 100 KB). **DONE (F0 store, P6 UI)**
8. **LB08** Add-to-playlist dialog for one track, many tracks, an album or the queue, with "New playlist" inline. **DONE (P6)**
9. **LB09** User playlist page `/music/library/playlist/:id`: play, shuffle, sort (custom/title/artist/album/added/duration), drag reorder (CDK, touch), remove and edit. **DONE (P6)**
10. **LB10** "Recommended songs" under a user playlist (P9 recommender, shown by P6). **DONE (P6 + P9)**
11. **LB11** Folders for playlists, with "Move to folder" and remove-from-folder (missing upstream), and no drag requirement. **DONE (F0 store, P6 UI)**
12. **LB12** Pins: up to 3 pinned items, shown as a row on Library and on the music home. **DONE (F0 store, P6 UI)**
13. **LB13** Content blocking: hide a track, album or artist (player skips, lists filter). Managed in Settings → Data. **DONE (F0 store, P7 manager, filters in P8/P9)**
14. **LB14** YouTube Music playlist import by URL. **SKIP**: depends on a third-party worker run by Monochrome's owner.
15. **LB15** Local-files library (folder scan). **SKIP**: Chromium-only File System Access, and it plays the visitor's files, not the catalogue. Ask the owner.
16. **LB16** Hosted playlist cover upload. **SKIP**: needs an upload backend. URL and data-URL covers replace it (LB07).
17. **LB17** Cloud sync, public playlists, profiles. **SKIP**: needs accounts (PocketBase); see section 14.
18. **LB18** Community playlists search. **SKIP**: third-party YouTube-Music-backed instances.

## 7. Import, export, data portability (DT), all in P7

1. **DT01** Playlist export to CSV and JSON (full metadata). **DONE (P7)**
2. **DT02** Export to XSPF, XML, M3U, M3U8, CUE and NFO. Port of `js/playlist-generator.js`, fixing the empty-list `-Infinity` bug. **DONE (P7)**
3. **DT03** Full library backup to a JSON file (every `fiesta:music:*` key except secrets) and restore with **merge** (the default) or **replace**. **DONE (P7)**
4. **DT04** Settings-only export and import, in the same file format. **DONE (P7)**
5. **DT05** Reset local music data, scoped to Fiesta music keys and databases, with confirmation. **DONE (P7)**
6. **DT06** Import wizard: CSV (auto-detects Spotify, Exportify, Apple and generic headers, using a quote-aware parser), JSPF, XSPF, XML, M3U/M3U8. Shows progress and cancel, then a missing-tracks report. **DONE (P7)**
7. **DT07** Track matcher: ISRC first, then fuzzy title/artist/album (token similarity, score at least 0.6) against `/api/music` search, throttled to 4 at a time. **DONE (P7)**
8. **DT08** Library CSV import, which bulk-adds favourites (add-only). **DONE (P7)**
9. **DT09** Share a playlist by link: `/music/shared?d=` holds a compressed name and track ids. The opener sees the list and can "Save a copy". **DONE (P7)**
10. **DT10** Blocked-content manager (list and unblock). **DONE (P7)**

## 8. Catalog pages and search (CT), all in P8

1. **CT01** Search tabs Songs / Albums / Artists / Playlists, "Load more" paging, skeletons, `?q=&type=` in the URL. **DONE (P8)**
2. **CT02** Search-as-you-type suggestions (debounced 250 ms, aborts stale requests, keyboard navigable listbox). **DONE (P8)**
3. **CT03** Search history UI (recent searches with delete and clear-all) on the empty search state. **DONE (P8)**
4. **CT04** Paste-a-link: pasting a tidal.com or monochrome.tf album, artist, track, playlist or mix URL routes to the Fiesta page. **DONE (P8)**
5. **CT05** Album page additions: shuffle, like, add to playlist, share, download, a cover-tinted header background, More from the artist, EPs & Singles, Similar albums and Similar artists rails, copyright and release date. **DONE (P8)**
6. **CT06** Album critic and user scores plus a "Must Hear" badge from the AOTY public API, server-cached. **DONE (P8)** Caveat: the "Must Hear" badge never shows, because the AOTY endpoint returns no `mustHear` field (scores work).
7. **CT07** Artist page additions: bio with a Read-more dialog, similar artists, discography filter (Albums / EPs & Singles / Compilations / Appears on), more top tracks, shuffle the whole artist, artist radio, like, "In your library" row. **DONE (P8)** Caveat: the "Appears on" filter is hidden on every artist, because TIDAL returns nothing for `filter=APPEARS_ON` with the app token.
8. **CT08** Artist external links from MusicBrainz (server-side, real User-Agent, cached 7 days). **DONE (P8)**
9. **CT09** Track page `/music/track/:id`: the track, its album's tracks and similar tracks (track mix), with a copy-link target. **DONE (P8)**
10. **CT10** Open Graph previews for bots on `/music/album|artist|track|playlist|mix/:id` in `middleware.js`. **DONE (P8)**
11. **CT11** Page titles and meta descriptions for every music page. **DONE (all page owners)**
12. **CT12** Owner-controlled DMCA blocklist (`MUSIC_BLOCKED_IDS` env var) filtered server-side. **DONE (F0)**
13. **CT13** Animated (video) covers and artist banner video. **SKIP**: needs an Apple Music token minter or a third-party worker.
14. **CT14** Apple Music search and metadata provider. **SKIP**: third-party token minter.

## 9. Discovery (DS), all in P9

1. **DS01** Music home (the empty `/music` state): Jump back in, Recently played, mixes made for you (track mixes of top tracks), recommended songs, albums and artists from local seeds, your playlists and pins, Editors' picks. Each section can be toggled. **DONE (P9)**
2. **DS02** Editors' picks from an owner-curated `src/assets/music/editors-picks.json` (albums and playlists by TIDAL id). **DONE (P9)**
3. **DS03** Mix page `/music/mix/:id` (TIDAL `pages/mix`): header, tracks, play, shuffle, like. **DONE (P9)**
4. **DS04** TIDAL playlist page `/music/playlist/:uuid`: header, tracks (paged), play, shuffle, like, save a copy to library, recommended songs. **DONE (P9)**
5. **DS05** Explore `/music/explore`: genres and moods shelves from TIDAL `pages/explore` and genre pages, CDN-cached. The tab hides itself if the app token can't read pages. **DONE (P9)**
6. **DS06** Track/artist radio endpoints (`tracks/:id/mix`, `artists/:id/mix`, `mixes/:id/items`) with a similar-artists fallback. **DONE (P9)**
7. **DS07** Albums-of-the-Year discovery hub (10 sub-tabs). **SKIP**: a third-party hobby API that would need every album matched to TIDAL. The album-page score (CT06) is kept. Ask the owner.
8. **DS08** Unreleased-music tracker (ArtistGrid). **SKIP**: leaked or unreleased audio from unofficial hosts. A legal and brand call for the owner.
9. **DS09** Music videos (search, artist videos, HLS playback). **SKIP**: the player is audio-only MSE. Ask the owner.

## 10. Shell, menus, shortcuts (SH), all in P10 unless noted

1. **SH01** Music sub-nav inside `/music` pages: Home, Explore, Library, Recent, Settings. Navbar and bottom-nav tabs are unchanged. **DONE (F0)**
2. **SH02** Keyboard shortcuts with Monochrome's exact defaults: Space, ←/→ ±10 s, Shift+←/→ prev/next, ↑/↓ volume, M, S, R, Q, L, /, Esc, `[` `]` `\`. They are active on `/music*`, or anywhere while a track is loaded, except on movie and TV player routes, in inputs, and with modifier conflicts. **DONE (P10)**
3. **SH03** Shortcut help modal (`?`) and a rebinding UI with conflict detection and reset. **DONE (P10)**
4. **SH04** Command palette (Ctrl/Cmd+K) with commands for navigation, playback, queue, view, sleep timer, visualizer, lyrics and settings. **DONE (P10)**
5. **SH05** Live music search inside the palette. **DONE (P10)**
6. **SH06** Settings search mode in the palette (">" prefix), using P11's static settings registry. **DONE (P10)**
7. **SH07** Track context menu (right-click, kebab, long-press): Play next, Add to queue, Like, Add to playlist, Start radio, Go to artist, Go to album, Track info, Share/Copy link, Download, Hide track, Open in new tab. **DONE (P10)**
8. **SH08** Card context menu for albums, artists and playlists: Play, Shuffle, Add to queue, Like, Add to playlist, Radio, Share, Download, Hide. **DONE (P10)**
9. **SH09** Track info dialog (all `MusicTrack` fields, quality, ISRC, ids). **DONE (P10)**
10. **SH10** Multi-select of tracks (checkbox, Ctrl/Shift-click, long-press) with a selection bar: Play, Add to queue, Play next, Like, Add to playlist, Download, Clear. **DONE (P10)**
11. **SH11** Share: Web Share API, falling back to clipboard copy with a toast, using Fiesta URLs. **DONE (P10)**
12. **SH12** Track row upgrades: like heart, a "now playing" equalizer indicator, a kebab menu, a drag handle slot and the selection checkbox. Existing selectors are kept. **DONE (P10)**
13. **SH13** Theme presets (Monochrome, Ocean, Mocha…) and the system theme. **SKIP**: Fiesta has one dark design. Dynamic cover colour (UI13) is the only colour feature.
14. **SH14** Custom theme editor and community theme store. **SKIP**: needs a hosted store and accounts.
15. **SH15** Font family and size settings. **SKIP**: Fiesta has a fixed type system; browser zoom covers size.
16. **SH16** Collapsible sidebar navigation. **SKIP**: replaced by the music sub-nav (SH01).
17. **SH17** Provider route prefixes (`t/`, `apple/`, `tracks/`, `mono/`). **SKIP**: Fiesta has one provider.

## 11. Settings (ST)

1. **ST01** `/music/settings`, with tabs Playback, Audio, Lyrics, Interface, Shortcuts, Downloads, Scrobbling, Data and System. The last tab is remembered, `?tab=` deep links work, and there is an in-page settings search. **DONE (P11)**
2. **ST02** Playback section: quality, gapless, crossfade, autoplay, skip unavailable, ReplayGain mode and preamp, exponential volume, default speed and pitch, sleep fade-out, silence removal. **DONE (P11)**
3. **ST03** Interface section: cover click action, close overlays on navigation, Back closes overlays, reduce blur, dynamic colour, album background, compact grids, haptics, home section toggles, waveform seek bar, cover tilt and round, Now Playing lyrics by default. **DONE (P11)**
4. **ST04** Audio section (EQ, AutoEQ, DSP). **DONE (P4)**
5. **ST05** Lyrics section (providers on/off, romanize/translate defaults, target language, blur, hide played lines, karaoke on/off). **DONE (P3)**
6. **ST06** Shortcuts section (rebinding). **DONE (P10)**
7. **ST07** Downloads section. **DONE (P12)**
8. **ST08** Scrobbling section. **DONE (P13)**
9. **ST09** Data section (backup/restore, settings export, import, blocked items, reset). **DONE (P7)**
10. **ST10** System section: storage used per area, clear caches (HTTP cache, lyrics, waveform and AutoEQ IndexedDB), read-only API status ping, version. **DONE (P11)**
11. **ST11** Settings registry, a static list of every setting with its tab and keywords, used by the palette and the in-page search. **DONE (P11)**
12. **ST12** Instances tab / custom API endpoints. **SKIP**: fixed backend.
13. **ST13** PWA auto-update and analytics/Sentry toggles. **SKIP**: site-level concerns, not music.
14. **ST14** Server-disruption banner and donation reminders. **SKIP**: Monochrome-specific.

## 12. Downloads (DL), all in P12

1. **DL01** Download a single track with a progress card in the downloads tray (cancel, retry). **DONE (P12)** Ships switched OFF (`MUSIC_DOWNLOADS_ENABLED = false`, owner decision); every entry point, the tray and the Settings tab are hidden until it is flipped.
2. **DL02** Lossless as a real `.flac`: a pure-TS remux of TIDAL's FLAC-in-fMP4 (STREAMINFO from `dfLa` plus the frames). AAC is saved as `.m4a`. **DONE (P12)** Ships switched OFF (`MUSIC_DOWNLOADS_ENABLED = false`, owner decision); every entry point, the tray and the Settings tab are hidden until it is flipped.
3. **DL03** Tagging: FLAC Vorbis comments and a PICTURE block, MP4 `ilst` atoms. Title, artist, album, track number, date, ISRC, cover and lyrics. Port of `js/metadata.flac.js` and `js/metadata.mp4.js`. **DONE (P12)** Ships switched OFF (`MUSIC_DOWNLOADS_ENABLED = false`, owner decision); every entry point, the tray and the Settings tab are hidden until it is flipped.
4. **DL04** Bulk ZIP for an album, playlist, liked tracks, the queue, a selection or a discography, via `client-zip` streaming. Sidecars: M3U/M3U8/CUE/NFO/JSON, cover.jpg, and LRC/TTML lyrics. **DONE (P12)** Ships switched OFF (`MUSIC_DOWNLOADS_ENABLED = false`, owner decision); every entry point, the tray and the Settings tab are hidden until it is flipped.
5. **DL05** Download settings: quality, filename template, sidecar toggles, ZIP or separate files, and a folder writer through File System Access (Chromium) that falls back to ZIP. **DONE (P12)** Ships switched OFF (`MUSIC_DOWNLOADS_ENABLED = false`, owner decision); every entry point, the tray and the Settings tab are hidden until it is flipped.
6. **DL06** ffmpeg.wasm transcoding to MP3/OGG. **SKIP**: a ~30 MB wasm payload. The remux in DL02 covers lossless.

## 13. Scrobbling (SC), all in P13 (late, optional)

1. **SC01** Scrobble engine: a threshold timer on played time (not wall-clock), now-playing updates and an offline retry queue, all driven by the player event bus. **DONE (P13)**
2. **SC02** Scrobble threshold setting (percentage of track, default 50 %, capped at 4 min). **DONE (P13)**
3. **SC03** Last.fm web-auth flow (token, then session). **DONE (P13), NEEDS-KEY to activate**: the flow is built and tested against a stub; it shows "Not configured on this site" until the owner sets `LASTFM_API_KEY` and `LASTFM_API_SECRET` (signed server-side by a `lastfm-sign` action).
4. **SC04** Last.fm username/password login (`auth.getMobileSession`, password never stored). **DONE (P13), NEEDS-KEY to activate** (same key).
5. **SC05** Love-on-like fan-out to the enabled services. **DONE (P13)** (the Last.fm part is NEEDS-KEY)
6. **SC06** Libre.fm scrobbling (any key string works; uses Fiesta's own strings). **DONE (P13)**
7. **SC07** ListenBrainz scrobbling and love; the visitor pastes their own token. **DONE (P13)**
8. **SC08** Maloja scrobbling to the visitor's own server URL and key. **DONE (P13)**
9. **SC09** Read-only owner Last.fm widget (recent and top artists). **DEFERRED**: not built (optional, low priority); also NEEDS-KEY (same Last.fm key).

## 14. Out of scope: needs owner input or infrastructure (OS)

1. **OS01** User accounts, sign-in (Google, GitHub, Discord, email) and cloud sync of library, history and settings. **SKIP**: needs PocketBase plus an auth server. JSON backup (DT03) is the cross-device path.
2. **OS02** Public profiles, edit profile, profile status and favourite albums, avatar upload. **SKIP**: needs accounts.
3. **OS03** Listening parties (create, join, sync, chat, requests, members). **SKIP**: needs a WebSocket server (a Cloudflare Durable Object per party).
4. **OS04** Podcasts (browse, search, show pages). **NEEDS-KEY**: `PODCASTINDEX_KEY` and `PODCASTINDEX_SECRET`, plus a plain `<audio>` path. Out of scope until the owner asks.
5. **OS05** Tauri, Capacitor and desktop/mobile app features (download pages, native media session, haptics plugin). **SKIP**: web only.
6. **OS06** Apple Music API features (lyrics snippets, animated covers). **SKIP**: third-party token minter.
7. **OS07** Donate page and Monochrome branding, editors' picks content. **SKIP**: project-specific; the editors'-picks mechanism is kept (DS02).

## Counts

| Status | Count |
|---|---|
| DONE | 181 |
| DEFERRED | 2 |
| SKIP | 35 |
| NEEDS-KEY (nothing built) | 1 |
| **Total** | **219** |

DONE includes SC03/SC04 (built, inactive until the Last.fm key is set) and the five downloads items (built,
switched off). DEFERRED: SC09 (owner Last.fm widget, optional) and LY21 (Genius annotations, needs a key).
Partial caveats inside DONE items: CT06 (no Must Hear badge), CT07 (no Appears on filter).

## Needs from the owner

1. **Last.fm API key and secret** (https://www.last.fm/api/account/create) as Vercel env `LASTFM_API_KEY` and `LASTFM_API_SECRET`. They are needed only for SC03, SC04, SC09 and the Last.fm half of SC05. ListenBrainz, Libre.fm and Maloja need nothing from the owner. Package P13 is late and optional.
2. **Confirm downloads (P12) may be public.** Downloads can only fetch what the player can already play: 30-second previews without a session; full tracks only where the relay session is allowed, which means previews and dev, or production with `MUSIC_SHARED_SESSION=1`. P12 puts everything behind one constant, `MUSIC_DOWNLOADS_ENABLED` in `src/app/services/music-download.service.ts`. **Owner decision: ship it, default OFF.** It is `false`; set it to `true` to turn downloads on (one switch; entry points, tray and Settings tab appear).
3. **TIDAL_CLIENT_ID and TIDAL_CLIENT_SECRET on Vercel Production.** This was already a gap before merge. Hi-Res (PB23) also needs the relay or user session that FULL playback needs.
4. **Optional:** a Genius API client token (https://genius.com/api-clients) if lyric annotations are wanted (LY21).
5. **Optional:** a PodcastIndex key and secret if podcasts are ever wanted (OS04).
6. **Decisions on skipped items, if you disagree:** speaker/room EQ with microphone (FX22), local-files library (LB15), music videos (DS09), Albums-of-the-Year hub (DS07), unreleased-music tracker (DS08), listening parties (OS03, which needs a WebSocket host).
7. **Optional content:** `src/assets/music/editors-picks.json` (DS02) and per-track lyric files in `src/assets/music/lyrics/` (LY26).
