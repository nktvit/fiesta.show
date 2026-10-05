# Fiesta.show - Angular refactor/modernization plan (2026-10-04)

Legend: [V] verified in code/build/docs fetched today, [I] inferred, [U] unverified.

## 1. Verdict
- Code is modern-ish Angular 20 (all standalone, new control flow, lazy routes, 56 signal/computed/input uses) but state is still mostly mutable fields + Default change detection; only 4 of 22 components are OnPush [V].
- Latest stable is Angular 22.2.x (CLI 22.2.1 released 2026-10-01) [V gh api]. v20 LTS ENDS 2026-11-28 [V angular.dev/reference/releases]: an upgrade is on a clock.
- Angular 20 already declares Safari/iOS 15 "outside Angular's support" (build warning, [V] in my build). The repo's browserslist overrides that, esbuild still downlevels syntax, so the iOS 15 floor is a self-imposed, untested-by-Angular promise today. 21 raises Angular's own floor to Safari/iOS 16.4, 22 to 17 [V, computed via browserslist baseline dates; caniuse data 6 months old].
- Highest leverage: (1) kill zone-pollution + go zoneless (hls.js runs inside the zone, see 4.1), (2) Home/LCP + startup fixes: BMC script blocks Angular bootstrap, random hero, API waterfall, (3) upgrade 20 -> 21 -> 22 before LTS ends, with an iOS 15 runtime test gate.
- Measured: initial 404.9 kB raw / 108.3 kB transfer; zone.js alone 33.7 kB raw (~11.4 kB transfer polyfills chunk); hls lazy chunk 518 kB raw / 132.6 kB; movie-page chunk 115 kB / 27 kB.

## 2. Angular version facts
- v20.2: zoneless API stable (`provideZonelessChangeDetection`), `animate.enter/leave` added, `@angular/animations` deprecated.
- v21 (2025-11-19): zoneless default for NEW apps (zone.js only if you add `provideZoneChangeDetection`), Vitest default for new apps + `@angular/build:unit-test` stable, `refactor-jasmine-vitest` migration (fakeAsync tests need manual rewrite), Signal Forms experimental, Aria dev preview, HttpClient auto-provided, NgClass/NgStyle migrations. TS >=5.9 <6, Node ^20.19||^22.12||^24.
- v22.0 (2026-06-03): Signal Forms, resource/httpResource/rxResource STABLE; OnPush is the default CD (migration inserts `ChangeDetectionStrategy.Eager` where needed); HttpClient uses Fetch by default (`withXhr()` to revert); `@Service()`, `injectAsync()`, `debounced()`; incremental hydration default; `strictTemplates` default; `paramsInheritanceStrategy` default -> 'always'; `canMatch` gets mandatory 3rd arg; optional chaining semantic change (undefined not null); chunk optimization on by default; Zone.js works with Vitest; `migrate-karma-to-vitest`. REQUIRES TypeScript 6 and Node ^22.22.3||^24.15||^26 (Node 20 dropped).
- v22.1/22.2 (2026-07/09): `@boundary/@error` blocks (dev preview), router resources `withRouterResources()` (dev preview), type-checking parallelized, separate browser/server stats.json, `withAutoCleanupInjectors`. 22.1 details: not found [U]. Next: v23 ~June 2027.
- Karma: still supported, not deprecated; Vitest is default [V angular.dev/guide/testing].
- Browser policy: "widely available" Baseline (<30 months old at a baseline date) for v20+; baseline dates v20 2025-04-30, v21 2025-10-20, v22 2026-05-07 [V angular.dev/reference/versions]. Resulting minimums (my computation with local browserslist 4.28, stale caniuse): v20 Chrome/Edge 107, Firefox 104, Safari/iOS 16 (matches @angular/build 20.3.23 .browserslistrc [V]); v21 Chrome 111, Firefox 112, Safari/iOS 16.4; v22 Chrome/Edge/Firefox 119, Safari/iOS 17.
- IMPORTANT nuance: "outside support" = warning only. esbuild targets your browserslist and transpiles syntax; it does NOT polyfill APIs. Whether Angular 21/22 runtime itself calls APIs absent from Safari 15 (e.g. newer Web APIs) is [U]; needs a real iOS 15 test.
- Sources: https://angular.dev/reference/versions , https://angular.dev/reference/releases , https://angular.dev/guide/zoneless , https://angular.dev/guide/testing , https://angular.dev/guide/ssr , https://angular.dev/guide/animations , https://blog.ninja-squad.com/2025/11/20/what-is-new-angular-21.0 , https://blog.ninja-squad.com/2026/06/03/what-is-new-angular-22.0 , https://blog.ninja-squad.com/2026/09/23/what-is-new-angular-22.2 , gh api angular/angular-cli releases (v22.2.1). Blog.angular.dev returned 403, so announcement posts were read via secondary sources.

## 3. Audit findings
### Verified
1. Player runs inside the zone: `movie-player.component.ts` has no NgZone/runOutsideAngular; `new Hls(...)` at line ~483. Every hls.js XHR/timer/MSE/event callback and video listener schedules app-wide CD. The handoff's "everything player-related runs runOutsideAngular" applies to the YouTube trailer/detail-panel code (expandable-text, movie-collection, detail-panel use NgZone), not the HLS player. MoviePage is Default CD with 604 lines, so each tick checks its tree incl. 434-line LikesComments template.
2. `index.html` has a classic synchronous `<script src=cdnjs.buymeacoffee.com/...widget.prod.min.js>` before the builder-injected `type=module` scripts (built dist confirms order). Angular bootstrap waits on a third-party download.
3. `provideAnimationsAsync()` is provided but no `trigger(`/animations API exists in src. `@angular/animations` is deprecated since 20.2. Likely source of lazy `browser` chunk 67.9 kB [I on mapping, V on no usage].
4. `tmdbImageLoader` (+spec) is dead code: never provided via IMAGE_LOADER. So NgOptimizedImage emits no srcset; posters are fixed w342 and `disableImageSizeWarning`/lazy warnings are suppressed. Hero `<img>` is a plain img (w1280 backdrop), no fetchpriority; hero is random of top-5 (`main.component.ts`), so it cannot be preloaded from HTML; the JS-injected `<link rel=preload>` happens only after the /api/tmdb response. Home fires 6 API calls on init.
5. Legacy: `ngClass` x ~20 sites (NgClass import in movie-page), no *ngIf/*ngFor/NgModule left. 7 @Input/@ViewChild-style decorators remain (HostListener etc.), 74 `inject()` vs 7 constructors (good).
6. Subscriptions: ~45 `.subscribe(` with teardown in only 4 places (takeUntilDestroyed x2, takeUntil in search-box, manual unsubscribe in detail panel). Most are finite HTTP (safe); the risky ones are `route.queryParams/paramMap/params.subscribe` in movie-page, search-box, genre, and `router.events` in app.component (root-lifetime so fine).
7. movie-page: `movieDetails: any`, ~17 mutable fields, a 100-line switchMap that resets ~20 fields by hand, nested subscribes with TMDB-id fallback duplicated 4x (trailer/credits/recs/backdrop each: `findTmdbId(...).subscribe`), `ngAfterViewChecked`, `window.scrollTo`, JSON-LD built imperatively.
8. Duplication: `tmdb.service.ts` has 15 `environment.production ? /api/tmdb : direct TMDB` branches that re-implement api/tmdb.js mapping (seasons filter mirrors `lib/seasons.js` by comment only; image bases/tiers appear in api/tmdb.js, api/movie.js, api/_tmdb-search.js, tmdb.service.ts, search-box.ts, tmdb-image.loader.ts). Dev branch needs a TMDB key in the browser bundle env.
9. Caching: two layers: `cacheInterceptor` (module-level Map, Infinity for /api/movie, 10 min TMDB, 5 min suggestions) AND per-service `shareReplay` Map in TmdbService; episodes API (OMDB) uncached by TMDB branch. `vercel.json` sets `Vary: User-Agent` on all HTML (needed for middleware routing; fragments CDN cache).
10. CSS budget: movie-detail-panel.component.css 3.16 kB vs 2 kB warn (budget is 2/4 kB). 4 NG8113 warnings (unused PosterComponent in genre, search-page, top-rated, tv).
11. Build: `@angular-devkit/build-angular:application` + `:dev-server` + `:karma` (legacy alias builders; migrate to `@angular/build`). Fonts: Angular already inlines the Google Fonts CSS and adds preconnect (built index.html has @font-face + gstatic woff2 URLs), so font loading is better than it looks; remaining cost = 3rd-party dependency at build/runtime for woff2.
12. Tests: 74/79 pass, 5 MovieService failures expect a hardcoded OMDB key (per handoff; I did not run Karma - needs Chrome). `types: ["node","jest"]` in tsconfig while tests are Jasmine: type pollution.
13. Initial bundle composition (stats.json): @angular/core 120 kB, router 67.6, common 41.4, zone.js 33.7, rxjs 21.3, platform-browser 16.8, app code ~22 kB, speed-insights 2.1 (statically imported in app.component; analytics is dynamic-imported in main.ts).
### Inferred / not measured
- INP/LCP effects of zone ticking from hls.js; no profiling done. CLS: poster `fill` inside fixed-aspect container OK; hero/backdrops lack dimensions [I].
- SSR/prerender value: home content is behind API calls and random; social crawlers already handled in middleware (movie/person OG injection). Real SEO value would come from prerendering movie pages with data = needs Node/SSR runtime on Vercel and hydration; large effort. Verdict: not worth it now; consider only static prerender of `/`, `/about`, `/terms` (trivial gain).

## 4. Prioritized recommendations
### Do now (safe)
| # | Change | Win | Effort | Risk | Browser floor / iOS15 | Files |
|---|---|---|---|---|---|---|
| 1 | Load BMC widget after bootstrap (inject script on `requestIdleCallback`/setTimeout after first render, `async`) | Removes third-party blocking of Angular start (LCP/FCP); size win 0 | S | Low (widget position CSS in styles.css keeps working) | None; iOS15-safe (use setTimeout fallback; rIC missing on Safari) | src/index.html, app.component.ts |
| 2 | Remove `provideAnimationsAsync` + @angular/animations dep | Drops async animations chunk (~68 kB raw lazy [I]); fewer deps; removes a deprecated pkg | S | Low (verify nothing uses `@angular/animations` or flowbite JS) | None | app.config.ts, package.json |
| 3 | Run hls.js + video listeners in `NgZone.runOutsideAngular` (and re-enter only for signal sets, or keep signals which don't need zone) | Largest runtime CD saving while still on zone.js; low effort | S | Low-Med (signals updates still render in Default CD only if marked; test player e2e `tools/e2e/player.mjs`) | None; iOS15-safe | movie-player.component.ts |
| 4 | Wire `tmdbImageLoader` via `provideImageLoader`/IMAGE_LOADER (fix tiers: posters w92-w780, "original"; w1280 is backdrop only; verify TMDB serves `.webp` before keeping the extension swap), enable real srcset/sizes; hero via NgOptimizedImage `priority` (adds fetchpriority=high) | Fewer image bytes on mobile; real LCP priority | S-M | Med (TMDB webp unverified [U]) | WebP: Safari 14+/iOS 14+ OK; `fetchpriority` ignored on <17.2 (harmless) | app.config.ts, tmdb-image.loader.ts, poster, main.component.html |
| 5 | Make hero deterministic per day, preload via `<link rel=preload as=image>` + early `fetch` hint for `/api/tmdb?list=trending` (preload as=fetch) or server-embed; add `preconnect image.tmdb.org` | Home LCP: removes API->JS->image waterfall | M | Low | All iOS15-safe | index.html, main.component.ts, api/tmdb.js |
| 6 | Cleanup: delete unused PosterComponent imports (4 warnings), fix CSS budget (raise to 4 kB warn or split panel css), drop `jest` types, pin `@angular/build` builders (`@angular-devkit/build-angular` -> `@angular/build`) | Cleanliness; build parity | S | Low | None | angular.json, tsconfig*, 4 page components |
| 7 | Fix 5 failing MovieService tests (mock `environment.OMDB_API_KEY` via spy/inject token) | Green CI | S | Low | None | movie.service.spec.ts |
### Do next
| # | Change | Win | Effort | Risk | Browser floor | Files |
|---|---|---|---|---|---|---|
| 8 | Upgrade 20.3 -> 21.2 (then 22.x); run `ng update`; keep explicit browserslist | Stay supported before 2026-11-28 | M | Med: runtime APIs on Safari 15 [U]; test on real iOS 15 + Android WebView before shipping | Angular floor -> Safari/iOS 16.4 (21), 17 (22): OFFICIAL support lost, build still targets your list; syntax downleveled; APIs not polyfilled | package.json, angular.json, tsconfig, all |
| 9 | Zoneless (`provideZonelessChangeDetection()`, remove zone.js polyfill & `Proxy` need from zone), after converting main/genre/tv/search/top-rated/navbar/movie-page/likes-comments fields to signals (OnPush-compatible) | -33.7 kB raw (~11 kB transfer) polyfill, no zone ticking, native async/await would no longer be downleveled (this is what broke Video.js) | L (movie-page + likes-comments are the bulk) | Med-High: missed updates are silent; run e2e per page | No new API requirements; does NOT let you lower the `tv/` Chrome 49 cutoff - leave middleware as is | many; see sketches |
| 10 | movie-page refactor: route inputs (`withComponentInputBinding`), `rxResource/httpResource` for details/credits/trailer/recs/episodes, `linkedSignal` for season/episode, split into EpisodePicker, CastRow, TrailerModal, JsonLd service | -300 lines, kills 4x duplicated fallback, kills ngAfterViewChecked & manual resets | M-L | Med | Needs only v22 stable (httpResource stable v22; experimental in 20/21 - on 20.3 use rxResource carefully) | movie-page.* |
| 11 | Single TMDB source of truth: keep dev on `vercel dev` or add `/api/tmdb` to proxy.conf.json, delete 15 dev branches; share image-size constants; shared `lib/` for season logic already exists | -~150 lines, no key in browser | M | Low | None | tmdb.service.ts, proxy.conf.json |
| 12 | Collapse the double cache: `cacheInterceptor` (HttpContext opt-in) OR resource-level cache; add stale-while-revalidate/`Cache-Control` on API responses | Fewer layers, CDN reuse | S-M | Low | None | cache.interceptor.ts, tmdb.service.ts, api/*.js |
| 13 | Replace NgClass with `[class]` bindings; replace RxJS subscribe-with-teardown with `toSignal`/`takeUntilDestroyed` in search-box, genre, movie-page | cleanup | S-M | Low | None | ~8 templates |
| 14 | Vitest migration (`ng g @schematics/angular:refactor-jasmine-vitest`), `@angular/build:unit-test` | faster tests; Karma dropped as default | M (79 tests, few fakeAsync) | Low | Tests only | angular.json, specs |
| 15 | `@defer (on viewport)` for LikesComments and below-fold rails on movie-page; `defer` for NavbarGenre sheet | Smaller movie-page critical chunk (115 kB) | S-M | Low | None; IntersectionObserver is Safari 12.1+ | movie-page.html |
### Defer / don't do
- Do NOT bundle Video.js through Angular or remove `/vendor` hosting: handoff decision. Zoneless would remove the root cause later, but it is an optional follow-up after #9, not part of this plan.
- Do NOT adopt Angular 22 `HttpClient` Fetch default blindly: `fetch` + streaming requires Safari 10.3+/Chrome 42 (ok) but the cache interceptor assumptions and progress events change; test or set `withXhr()`.
- Do NOT raise browserslist to Angular's baseline (would silently drop iOS 15/16).
- SSR/hybrid rendering: skip (needs Node function for Vercel, hydration of a client-only app that touches `window` in 48 places, middleware already serves OG for crawlers). Revisit only if SEO of /movie/:id pages matters.
- Signal Forms: only comment box and search input are forms; low value, defer.
- Do not touch `tv/` or middleware cutoff; do not design anything that assumes it can serve Chrome<49.
- `/music` branch: nothing here conflicts with an app-wide player service; a root-provided PlayerService should be written zone-aware (outside zone, signals out).

## 5. Sketches
### 5.1 BMC widget (index.html)
Before: `<script data-name="BMC-Widget" ... src=".../widget.prod.min.js">` in body.
After: remove tag; in `AppComponent` `afterNextRender(() => setTimeout(() => { const s=document.createElement('script'); s.async=true; s.src='https://cdnjs.buymeacoffee.com/1.0.0/widget.prod.min.js'; s.dataset.name='BMC-Widget'; s.dataset.id='nktvit'; ...; s.onload=()=>window.dispatchEvent(new Event('DOMContentLoaded')); document.body.appendChild(s); }, 3000))`. NOTE [U]: the BMC widget initializes on DOMContentLoaded/load; dispatching that event is the commonly used trick; verify widget appears on iOS 15.
### 5.2 Player outside zone
```ts
private zone = inject(NgZone);
private async startHls() {
  const Hls = (await import('hls.js')).default;
  this.hls = this.zone.runOutsideAngular(() => new Hls({...}));   // hls.js timers/XHR no longer tick CD
}
// signals (this.paused.set(...)) already notify the view; with OnPush/zoneless no extra zone.run needed.
```
Also make `MoviePlayerComponent` `changeDetection: OnPush` (it is already signal-driven).
### 5.3 App config (target after upgrade + zoneless)
```ts
export const appConfig: ApplicationConfig = { providers: [
  provideZonelessChangeDetection(),
  provideRouter(routes, withComponentInputBinding(), withRouterConfig({onSameUrlNavigation:'reload'})),
  provideHttpClient(withInterceptors([cacheInterceptor])),   // withFetch is default in 22
  { provide: IMAGE_LOADER, useValue: tmdbImageLoader },
]};   // angular.json polyfills: [] (zone.js removed)
```
### 5.4 movie-page (resource-style)
```ts
readonly id = input.required<string>();                 // route param via withComponentInputBinding
readonly s = input<string>(); readonly e = input<string>(); readonly type = input<'movie'|'tv'>('movie');
readonly details = rxResource({ params: () => this.id(), stream: ({params}) => this.movies.getById(params) });
readonly tmdbId = computed(() => this.details.value()?.tmdbId ?? null);
readonly credits = rxResource({ params: this.tmdbId, stream: ({params}) => this.tmdb.getCredits(params, this.type()) });
readonly season = linkedSignal(() => this.s() ? +this.s()! : null);
```
(on 20.3/21 use the experimental names; v22 renamed request->params in stable resources: verify before coding [U]). Eliminates the duplicated `findTmdbId().subscribe(...)` fallback by resolving tmdbId once.
### 5.5 TMDB dev proxy
`proxy.conf.json`: `"/api/tmdb": {"target":"http://localhost:3000"}` (run `vercel dev`), then delete `environment.production ? ... : ...` branches in tmdb.service.ts.

## 6. Browser-support matrix
| Change | iOS/Safari 15 | Android WebView (Chrome>=~100 typical) | `tv/` cutoff (Chrome<49 -> /lite) |
|---|---|---|---|
| #1-#3, #5-#7, #13-#15 | OK | OK | no effect |
| #4 WebP + srcset | OK (WebP 14+) | OK | no effect; fetchpriority ignored <17.2 |
| #8 Angular 21/22 upgrade | Syntax downleveled; Angular officially unsupported; runtime API gaps [U] -> must test | Chrome 111/119 floors; older WebView may be unsupported officially but built for browserslist | unchanged |
| #9 zoneless | OK; removes Proxy dependency of zone | OK | Keep cutoff at 49 anyway (Angular itself needs ES modules/modern APIs) |
| #10 resources | Only available stable in 22 | OK | no effect |
| HttpClient Fetch default (22) | OK | OK | n/a |
| SSR (not recommended) | n/a | n/a | n/a |

## 7. Open questions
1. Is iOS 15 an actual traffic requirement (Vercel analytics share) or a precaution? If < ~1%, moving to Angular's baseline (iOS 16.4/17) would simplify everything.
2. Can you test on a real iOS 15 device / BrowserStack for the 21/22 runtime gate?
3. Is the OMDB-dependent path (movie.js, episodes) staying, or should TMDB become the only source (would remove most duplication)?
4. Is SEO for /movie/:id pages (beyond OG tags) a goal? That decides on SSR.
5. Appetite for a multi-day zoneless conversion vs. just doing #3 and staying on zone.js?
