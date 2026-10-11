import {
  CUSTOM_ELEMENTS_SCHEMA,
  Component,
  ElementRef,
  computed,
  effect,
  input,
  output,
  signal,
  viewChild,
  OnChanges,
  OnDestroy,
  SimpleChanges,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import type Hls from 'hls.js';
import { fetchSubtitleDirect, parseVtt, VttCue } from '../../utils/vtt';
import { installRenditions } from '../../utils/hls-renditions';
import { SubtitleSync } from '../../utils/subsync';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

@Component({
  selector: 'app-movie-player',
  imports: [NgTemplateOutlet],
  // <video-player> / <video-skin> are Video.js v10 custom elements.
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  templateUrl: `./movie-player.component.html`,
  styleUrl: './movie-player.component.css',
})
export class MoviePlayerComponent implements OnChanges, OnDestroy {
  readonly imdbId = input<string>('');
  readonly type = input<string>('movie');
  readonly season = input<number | null>(null);
  readonly episode = input<number | null>(null);
  // backdrop (movie) or current-episode still (series), shown until playback starts
  readonly poster = input<string | null>(null);
  // kept for parent compatibility (query-param persistence); single clean source now
  readonly server = input<number>(0);
  /**
   * Begin playback as soon as the stream is attached, without waiting for a
   * click. Set when the viewer arrived here by pressing Play somewhere else,
   * so the press carries through the navigation.
   */
  readonly autostart = input<boolean>(false);
  readonly serverChange = output<number>();

  readonly videoEl = viewChild<ElementRef<HTMLVideoElement>>('videoEl');

  // 'custom' = Video.js v10 skin around our <video>; 'native' = the browser's
  // own controls. Same engine (hls.js) either way; the viewer's pick persists.
  readonly playerUi = signal<'custom' | 'native'>(MoviePlayerComponent.readPlayerUi());
  private static readonly PLAYER_UI_KEY = 'fiesta:player-ui';
  // Paused when the viewer switched UI: the re-attached stream must not start playing.
  private holdPaused = false;

  readonly loading = signal(false);
  readonly errorMsg = signal<string | null>(null);
  readonly masterUrl = signal<string | null>(null);
  readonly started = signal(false);
  readonly resumeTime = signal<number | null>(null);
  readonly paused = signal(false);
  // Mid-playback stall (waiting on buffer, transient HLS recovery, seek). The
  // <video> keeps the last decoded frame on screen; we overlay a spinner.
  readonly buffering = signal(false);

  // preview-only debug: show whether segments load direct vs via the proxy
  readonly env = signal<string | null>(null);
  readonly isPreview = computed(() => this.env() === 'preview');
  readonly segmentSource = signal<string | null>(null);

  // External subtitle tracks (best per language) from /api/subs, listed in
  // the native captions menu. The <track> elements never point at the VTT
  // file: a <track> whose src is (re)assigned once it is already in the DOM
  // can silently never fetch (Chromium and WebKit both; reproduced with plain
  // and blob: URLs alike — the blob: variant merely failed less often), which
  // was the "picked a language, nothing appeared" bug. Instead every track is
  // born with an empty stub and its cues are fetched by us, parsed, and pushed
  // through TextTrack.addCue() — a path that does not depend on the element
  // ever loading anything. The preferred track is filled first; the rest are
  // fetched one at a time in the background (OpenSubtitles' legacy download
  // host rate-limits bursts hard), so switching later is instant.
  readonly subtitleTracks = signal<{ lang: string; label: string; src: string; isDefault: boolean }[]>([]);
  // Every <track> gets this as its src so the browser considers it loaded
  // (readiness "loaded", zero cues) and never tries a network fetch itself.
  readonly stubVtt = 'data:text/vtt,WEBVTT';
  // Brief in-player notice ("Subtitles failed to load"); null when nothing to say.
  readonly subtitleNotice = signal<string | null>(null);
  private subtitleNoticeTimer: ReturnType<typeof setTimeout> | null = null;
  // subtitleKey -> parsed cues, so re-showing or re-filling a track never re-downloads.
  private readonly cueCache = new Map<string, VttCue[]>();
  // TextTrack objects that already hold their cues (a re-render that keeps
  // the same <track> elements must not add every cue a second time).
  private filledTracks = new WeakSet<TextTrack>();
  // Fetches in flight, keyed like cueCache, so a viewer pick and the
  // background preload never download the same file twice at once.
  private readonly cueFetches = new Map<string, Promise<VttCue[] | null>>();
  // Key of the track that was showing after the last reconciliation, so a
  // switch can tell the new pick from the old one (see enforceSingleShowing).
  private lastShowingKey: string | null = null;
  // Tracks whose file could not be downloaded this load (OpenSubtitles'
  // download host 502s individual files, sometimes for hours). Never
  // auto-selected again until the next load; a same-language sibling is
  // used instead (see ensureCues).
  private failedCueKeys = new Set<string>();
  // Timestamp of the last moment hls.js was known to be rewriting the text
  // track list (see reassertSubtitles). A `change` event inside that window
  // is hls.js's doing, not the viewer's, and must not be persisted.
  // -Infinity, not 0: performance.now() starts near 0, so 0 would mark every
  // pick in the first second after a page load as machine-driven (never saved).
  private hlsTouchedTracksAt = -Infinity;

  // which cloudnestra front actually served the current stream (1=vidsrc, 2=vsembed)
  readonly activeServer = signal<number>(1);

  private hls: Hls | null = null;
  private attachedUrl: string | null = null;
  private loadToken = 0;
  private recoverAttempts = 0;
  // Gated on a query param so the verbose logger and the telemetry hooks cost
  // nothing in normal playback.
  private readonly hlsDebug =
    typeof location !== 'undefined' && new URLSearchParams(location.search).has('hlsdebug');
  // Live subtitle sync (utils/subsync.ts): a Settings menu checkbox, on by
  // default, saved in localStorage. hls.js only; native HLS exposes no audio.
  private static readonly SUBSYNC_KEY = 'fiesta:subsync';
  private subsyncOn = MoviePlayerComponent.readSubsync();
  private subsyncHls: { hls: Hls; appendEvent: string; video: HTMLVideoElement } | null = null;
  private subsyncItem: HTMLElement | null = null;
  private subsync: SubtitleSync | null = null;
  // ?hls=js / ?hls=native force an engine, for comparing the two.
  private readonly hlsEngine =
    typeof location !== 'undefined' ? new URLSearchParams(location.search).get('hls') : null;
  // Set once native playback has failed for the current title, so the retry
  // goes through hls.js instead of repeating the same native attempt.
  private nativeFailed = false;
  // Set once hls.js has exhausted its recovery for the current title, so the
  // one native attempt that follows isn't repeated.
  private hlsFailed = false;
  // Removes the `videoRenditions` list the quality menu reads (see hls-renditions).
  private removeRenditions: (() => void) | null = null;
  private nativeErrorHandler: (() => void) | null = null;
  // Defer the buffering spinner so quick seeks/microstalls don't flash it.
  private bufferingTimer: ReturnType<typeof setTimeout> | null = null;
  // true once we've already escalated server 1 -> server 2, so we don't loop
  private escalated = false;
  private pendingResumeTime: number | null = null;
  private lastProgressSaveAt = 0;

  private static readonly UNAVAILABLE = 'This title isn’t available to stream right now';
  private static readonly PROGRESS_PREFIX = 'fiesta:playback-progress:';
  private static readonly SUBTITLE_PREF_KEY = 'fiesta:subtitle-pref';
  private static readonly SEEK_STEP = 10;
  // Repeated/held arrow presses inside this window add up into ONE seek: a
  // held key auto-repeats ~30×/s and each seek makes hls.js abort and refetch,
  // which is exactly the stutter-after-seeking complaint.
  private static readonly SEEK_COALESCE_MS = 160;
  private pendingSeek = 0;
  private seekTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    document.addEventListener('keydown', this.onDocumentKeydown, true);
    if (this.playerUi() === 'custom') MoviePlayerComponent.loadVideoJs();

    // Attach the stream once both the resolved master URL and the <video> exist.
    effect(() => {
      const url = this.masterUrl();
      const ref = this.videoEl();
      if (url && ref) void this.attach(ref.nativeElement, url);
    });

    // Arrived with Play already pressed: start as soon as there is something
    // to play. Only ever fires once — a later episode switch should not yank
    // the viewer back into playback.
    effect(() => {
      const url = this.masterUrl();
      const ref = this.videoEl();
      if (!this.autostart() || this.autostartDone || !url || !ref || this.started()) return;
      this.autostartDone = true;
      queueMicrotask(() => this.autoStartPlayback());
    });

    // Re-apply the saved subtitle preference whenever the track list changes
    // (episode switch, retry, server escalation). The <track default>
    // attribute alone isn't reliable here — some browsers stop honoring it
    // on dynamically-swapped tracks once the viewer has touched captions
    // once — so we also force textTrack.mode imperatively.
    effect(() => {
      const tracks = this.subtitleTracks();
      const ref = this.videoEl();
      if (!ref || tracks.length === 0) return;
      // The track list usually renders before the stream resolves; listen for
      // the viewer's pick from now, not from attach(), or a pick made in that
      // gap is never saved.
      this.wireSubtitlePersistence(ref.nativeElement);
      this.applySubtitlePreference(ref.nativeElement);
    });
  }

  ngOnChanges(_changes: SimpleChanges) {
    void this.loadStream();
  }

  ngOnDestroy() {
    document.removeEventListener('keydown', this.onDocumentKeydown, true);
    this.destroyHls();
    if (this.bufferingTimer) clearTimeout(this.bufferingTimer);
    if (this.subtitleNoticeTimer) clearTimeout(this.subtitleNoticeTimer);
    this.cueCache.clear();
    this.cueFetches.clear();
  }

  // Keyboard transport: Left/Right step 10 s, anywhere on the page once playback
  // has started, never while typing in a field. Held or repeated presses
  // coalesce into ONE seek (each seek makes the engine abort and refetch).
  // Bound on `document` in the CAPTURE phase (see constructor) and
  // preventDefault()ed: that runs before the browser's own handling and before
  // the Video.js skin's arrow hotkeys, which skip defaultPrevented events — so
  // a press seeks once, not twice.
  onDocumentKeydown = (event: KeyboardEvent) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    if (event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented) return;
    if (!this.started() || !this.masterUrl()) return;
    const target = event.target as HTMLElement | null;
    if (target && this.isEditable(target)) return;
    // The Fiesta/Native switch is a radio group: arrows move its selection.
    if (target?.closest?.('[role="radiogroup"]')) return;
    const video = this.videoEl()?.nativeElement;
    if (!video) return;
    event.preventDefault();
    this.pendingSeek += event.key === 'ArrowLeft' ? -MoviePlayerComponent.SEEK_STEP : MoviePlayerComponent.SEEK_STEP;
    if (this.seekTimer) return;
    this.seekTimer = setTimeout(() => {
      this.seekTimer = null;
      const delta = this.pendingSeek;
      this.pendingSeek = 0;
      if (delta) this.seekBy(video, delta);
    }, MoviePlayerComponent.SEEK_COALESCE_MS);
  };

  // Video.js v10 is loaded from its own prebuilt browser bundle (@videojs/cdn,
  // copied to /vendor by angular.json), NOT bundled by Angular. Angular's build
  // downlevels every async/await to generators for zone.js, and that reorders
  // Video.js's element update cycle: tooltips and popovers ran their first
  // update before they were wired, so every tooltip rendered as an empty pill
  // and the controls bar could stay hidden. Same package version both places;
  // bump VIDEOJS_URL together with @videojs/cdn in package.json and angular.json.
  private static readonly VIDEOJS_URL = '/vendor/videojs-10.0.1/video.js';
  private static videoJsLoad: Promise<unknown> | null = null;
  private static loadVideoJs() {
    const url = MoviePlayerComponent.VIDEOJS_URL; // a variable, so the bundler leaves the import alone
    // The checkbox menu item ships as its own UI entry, outside the skin bundle.
    const checkbox = MoviePlayerComponent.VIDEOJS_URL.replace(/video\.js$/, 'ui/menu-checkbox-item.js');
    MoviePlayerComponent.videoJsLoad ??= Promise.all([
      import(/* @vite-ignore */ url),
      import(/* @vite-ignore */ checkbox),
    ]).catch((err) => {
      MoviePlayerComponent.videoJsLoad = null; // allow a retry on the next player
      console.error('Video.js failed to load', err);
    });
  }

  private static readSubsync(): boolean {
    if (typeof location === 'undefined') return false;
    const q = new URLSearchParams(location.search).get('subsync'); // ?subsync=0|1 for tests
    if (q === '0' || q === '1') return q === '1';
    try {
      return window.localStorage.getItem(MoviePlayerComponent.SUBSYNC_KEY) !== '0';
    } catch {
      return true;
    }
  }

  private startSubsync() {
    const h = this.subsyncHls;
    if (!this.subsyncOn || !h || this.subsync) return;
    this.subsync = new SubtitleSync(h.video, h.hls as never, h.appendEvent);
    if (this.hlsDebug) (window as unknown as Record<string, unknown>)['__fiestaSubsync'] = this.subsync.state;
  }

  private stopSubsync() {
    this.subsync?.destroy(); // puts the cues back at their file times
    this.subsync = null;
  }

  private setSubsync(on: boolean) {
    this.subsyncOn = on;
    try {
      window.localStorage.setItem(MoviePlayerComponent.SUBSYNC_KEY, on ? '1' : '0');
    } catch {
      // private mode: the choice lasts for this page only
    }
    if (on) this.startSubsync();
    else this.stopSubsync();
    this.subsyncItem?.toggleAttribute('checked', on);
    this.subsyncItem?.querySelector('media-menu-item-indicator')?.toggleAttribute('checked', on);
  }

  // The skin's Settings menu has no slot for extra items, so the "Subtitle
  // sync" checkbox (Video.js's own <media-menu-checkbox-item>) is appended to
  // the menu's top level inside the skin's shadow root, styled with the skin's
  // own menu-item classes. The skin renders after Video.js loads, so wait for
  // the menu to exist (a few frames, or seconds on a cold load).
  private installSubsyncItem(video: HTMLVideoElement) {
    const deadline = performance.now() + 15_000;
    const tryInstall = () => {
      if (this.subsyncHls?.video !== video) return; // detached meanwhile
      const root = video.closest('video-skin')?.shadowRoot;
      const content = root?.querySelector('media-menu > media-menu-content');
      if (!content || !customElements.get('media-menu-checkbox-item')) {
        if (performance.now() < deadline) requestAnimationFrame(tryInstall);
        return;
      }
      if (content.querySelector('.fiesta-subsync-item')) return;
      const item = document.createElement('media-menu-checkbox-item');
      item.className = 'media-menu-item media-menu-radio-item fiesta-subsync-item';
      item.innerHTML =
        // two-arrow sync glyph (the skin's icon set has none), sized by the skin's icon class
        '<svg class="media-menu-trigger-item-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
        'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<path d="M20 11a8 8 0 0 0-14.6-4.5L4 8"/><path d="M4 3v5h5"/>' +
        '<path d="M4 13a8 8 0 0 0 14.6 4.5L20 16"/><path d="M20 21v-5h-5"/></svg>' +
        '<span>Subtitle sync</span>' +
        '<media-menu-item-indicator class="media-menu-item-indicator">' +
        '<media-icon name="check" class="media-menu-radio-item-icon"></media-icon>' +
        '</media-menu-item-indicator>';
      item.toggleAttribute('checked', this.subsyncOn);
      item.querySelector('media-menu-item-indicator')?.toggleAttribute('checked', this.subsyncOn);
      item.addEventListener('checked-change', (e) => this.setSubsync((e as CustomEvent<{ checked: boolean }>).detail.checked));
      content.appendChild(item);
      this.subsyncItem = item;
    };
    tryInstall();
  }

  private static readPlayerUi(): 'custom' | 'native' {
    try {
      return window.localStorage.getItem(MoviePlayerComponent.PLAYER_UI_KEY) === 'native' ? 'native' : 'custom';
    } catch {
      return 'custom';
    }
  }

  /** The Fiesta/Native switch under the video (a two-option radio group). */
  setPlayerUi(mode: 'custom' | 'native') {
    if (mode !== this.playerUi()) this.togglePlayerUi();
  }

  onPlayerUiKeydown(event: KeyboardEvent) {
    const order: ('custom' | 'native')[] = ['custom', 'native'];
    let next: number;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = 0;
    else if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = 1;
    else return;
    event.preventDefault();
    this.setPlayerUi(order[next]);
    (event.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('[role="radio"]')[next]?.focus();
  }

  // Swap between the Video.js skin and the browser's own controls. The <video>
  // element is re-created, so carry the position and play state across and let
  // the normal attach path (restoreProgress, subtitle effects) rebuild the rest.
  togglePlayerUi() {
    const next = this.playerUi() === 'custom' ? 'native' : 'custom';
    const video = this.videoEl()?.nativeElement;
    if (video) {
      if (Number.isFinite(video.currentTime) && video.currentTime > 0) {
        this.pendingResumeTime = video.currentTime;
        this.saveProgress(video);
      }
      this.holdPaused = video.paused;
    }
    this.destroyHls();
    this.attachedUrl = null;
    if (next === 'custom') MoviePlayerComponent.loadVideoJs();
    this.playerUi.set(next);
    try {
      window.localStorage.setItem(MoviePlayerComponent.PLAYER_UI_KEY, next);
    } catch {}
  }

  private isEditable(el: HTMLElement): boolean {
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    return !!el.closest('[contenteditable=""], [contenteditable="true"]');
  }

  private seekBy(video: HTMLVideoElement, delta: number) {
    const duration = Number.isFinite(video.duration) ? video.duration : Infinity;
    let t = video.currentTime + delta;
    if (t < 0) t = 0;
    if (t > duration - 0.5) t = Math.max(0, duration - 0.5);
    try {
      video.currentTime = t;
    } catch {}
  }

  private async loadStream(srv?: 1 | 2, keepStarted = false) {
    const id = this.imdbId();
    if (!id) {
      this.masterUrl.set(null);
      return;
    }

    const token = ++this.loadToken;
    this.errorMsg.set(null);
    this.segmentSource.set(null);
    this.subtitleTracks.set([]);
    // Critical for series: a stale cache entry surviving an episode switch
    // would collide on the same lang::label key and silently show the wrong
    // episode's subtitles, since the key carries no episode identity.
    this.cueCache.clear();
    this.cueFetches.clear();
    this.filledTracks = new WeakSet<TextTrack>();
    this.lastShowingKey = null;
    this.failedCueKeys.clear();
    this.setSubtitleNotice(null);
    if (!keepStarted) {
      // Fresh load: full-screen loader covers the stage.
      this.loading.set(true);
      this.started.set(false);
      this.paused.set(false);
      this.clearBuffering();
    } else {
      // Mid-watch reload (e.g. server-2 escalation): keep the last frame on
      // screen and show the buffering spinner instead of the full loader.
      this.beginBuffering();
    }
    this.recoverAttempts = 0;
    if (!srv) {
      this.escalated = false; // fresh, unforced load — reset escalation state
      this.nativeFailed = false;
      this.hlsFailed = false;
    }
    const savedProgress = this.readSavedProgress();
    this.resumeTime.set(!keepStarted ? savedProgress : null);
    this.pendingResumeTime = keepStarted ? savedProgress : null;
    this.lastProgressSaveAt = 0;

    // Subtitles are independent of stream resolution — fetch in parallel,
    // best-effort, and never let a failure here block playback.
    void this.loadSubtitles(token);

    try {
      const type = this.type() === 'tv' ? 'tv' : 'movie';
      const params = new URLSearchParams({ type, id });
      const s = this.season();
      const e = this.episode();
      if (type === 'tv' && s && e) {
        params.set('s', String(s));
        params.set('e', String(e));
      }
      if (srv) params.set('srv', String(srv));

      const res = await fetch(`/api/stream?${params.toString()}`);
      const data = await res.json().catch(() => ({}));
      if (token !== this.loadToken) return; // superseded by a newer load
      if (!res.ok) throw new Error(data?.error || `resolve failed (${res.status})`);
      if (!data?.master) throw new Error('no stream returned');

      this.env.set(data.env ?? null);
      this.activeServer.set(data.server ?? srv ?? 1);
      this.masterUrl.set(data.master);
      if (data.env === 'preview') void this.probeSegmentSource(data.master, token);
    } catch (err) {
      if (token !== this.loadToken) return;
      this.masterUrl.set(null);
      this.errorMsg.set(String((err as Error)?.message || err));
    } finally {
      if (token === this.loadToken) this.loading.set(false);
    }
  }

  private async attach(video: HTMLVideoElement, master: string) {
    if (this.attachedUrl === master) return;
    this.attachedUrl = master;
    this.destroyHls();
    this.wireSubtitlePersistence(video);

    // ?hls=native forces the browser's own HLS (falling back to hls.js once if
    // it errors); otherwise native is only the fallback, below.
    if (this.preferNativeHls(video)) {
      this.attachNative(video, master, true);
      return;
    }

    // Prefer hls.js wherever MSE is available — Chrome, Firefox, desktop Safari,
    // iOS 17.1+ (ManagedMediaSource) — so we drive ABR/quality, the quality menu
    // and error recovery ourselves. Native HLS picks its own (conservative)
    // quality through the relay, which we can't tune or offer a menu for; it is
    // the fallback where MSE is absent, or once hls.js has given up.
    const Hls = (await import('hls.js')).default;
    if (Hls.isSupported() && !this.hlsFailed) {
      // Tuned against how hls.js actually measures bandwidth. Its sample is
      //   processingMs = parsing.end - loading.start - min(actualTTFB, ewmaTTFB)
      // so it compensates for latency only up to its *running estimate* of it.
      // Every segment here is a cold CDN fetch relayed through a home uplink, so
      // TTFB VARIANCE — not latency — is what depresses the estimate and walks the
      // quality down. The settings below give ABR margin to absorb that variance
      // instead of reacting to it.
      const hls = new Hls({
        enableWorker: true,
        debug: this.hlsDebug,
        // Desktop Safari 17+ has both MediaSource and ManagedMediaSource, and hls.js
        // prefers the managed one. With it, a seek outside the buffered range never
        // loaded anything: `seeking` stayed true forever, no segment was requested and
        // the buffer stayed at 0-30 s (reproduced in WebKit on fiesta.show; the same
        // seek with ManagedMediaSource removed resumes in ~2 s, like Chrome). Use the
        // plain MediaSource where it exists. iPhones have only ManagedMediaSource, and
        // hls.js still falls back to it there.
        preferManagedMediaSource: false,
        capLevelToPlayerSize: false, // never downscale to the <video> element's pixel size
        // Was 8_000_000, and that was itself a bug. level-controller only
        // auto-derives a start estimate when this is left undefined, so an explicit
        // 8e6 survives into firstAutoLevel — where the only surviving test is
        // `adjustedbw >= maxBitrate`, and 8e6 >= 5,145,364. Every session on every
        // connection therefore started on 1920x1072 with an empty buffer and stepped
        // DOWN once the first real sample landed. Bandwidth-independent, which is
        // exactly why it didn't look like a connection problem.
        // At 5e6 the top variant's gate fails (5e6 < 5,145,364) and the middle one
        // passes (5e6 >= 3,281,926): start at 1280x714 and climb on fragment 2.
        // 5e6 is also exactly hls.js's own abrEwmaDefaultEstimateMax.
        abrEwmaDefaultEstimate: 5_000_000,
        // Previously 1.0/0.9 — maximally eager. With a spiky TTFB that produced
        // upswitch -> underrun -> stall -> downswitch oscillation, which is the
        // "quality drops" symptom. Back to a margin (library defaults: 0.95/0.7).
        abrBandWidthFactor: 0.95,
        abrBandWidthUpFactor: 0.8,
        // `progressive: true` was removed, back to the library default of false.
        // Honest status: this is PRECAUTIONARY, not a fix for an observed bug. It
        // was removed while chasing an audio-delay report that turned out to be
        // Bluetooth output latency, so nothing user-visible is known to have been
        // caused by it. The case for leaving it off is that it is a non-default
        // path which feeds 128KB partial chunks to the transmuxer — whose own
        // comments note it then has "no guarantee the fetch loader gives us flush
        // moof+mdat pairs" — and whose A/V realignment only runs once it holds
        // enough samples of BOTH tracks. Our responses are chunked with no
        // Content-Length, which is that jagged-input case.
        // The cost is real: time-to-first-frame rises by about one fragment
        // transfer (measured 143-592ms) because the fragment must land whole
        // before transmux. Re-enable it if startup latency matters more than
        // staying on the library's tested path.
        // maxBufferLength is a FLOOR, not a cap: the effective forward target is
        // min(max(8 * maxBufferSize / levelBitrate, maxBufferLength), maxMaxBufferLength),
        // which at the declared top bitrate is min(93.3, maxMaxBufferLength). Pinning
        // maxMaxBufferLength to 60 is what makes 60 actually mean 60.
        maxBufferLength: 60, // default 30 — rides out an upstream hiccup
        maxMaxBufferLength: 60, // default 600
        backBufferLength: 90, // default Infinity — on a 2h film the back buffer grows
        // until the browser hits its SourceBuffer quota, and the resulting eviction
        // shows up as stalls and dropped frames late in a long watch.
        // Deliberately NOT raising maxBufferHole or nudgeMaxRetry. Both were
        // considered and rejected: buffer-helper merges any gap below maxBufferHole
        // into a single range, so at 0.5 a hole of up to ~12 frames becomes invisible
        // to hls.js, is never re-fetched, and the playhead is stepped across it with
        // no event — it manufactures the dropped-frame symptom while hiding the
        // evidence. nudgeMaxRetry already resets whenever playback advances, so
        // raising it changes nothing, and each nudge moves currentTime by up to 0.6s.
        // Our subtitles are <track> elements we fill ourselves (see
        // subtitleTracks). With this on, hls.js's subtitle-track-controller
        // listens to the media's textTracks `change` event and, finding a
        // showing track that is not one of *its* tracks, calls
        // setSubtitleTrack(-1) -> toggleTrackModes(), which sets EVERY native
        // subtitles/captions track to disabled — i.e. it switched the
        // viewer's choice off again. These streams carry no in-band
        // subtitles, so nothing is lost by turning it off.
        renderTextTracksNatively: false,
      });
      this.hls = hls;

      // hls.js still reaches into the media element's text tracks on its own
      // lifecycle events: timeline-controller._cleanTracks() removes every cue
      // from every track (ours included) on MEDIA_ATTACHING and
      // MANIFEST_LOADING, and subtitle-track-controller.toggleTrackModes() can
      // disable them. Reproduced with a stack trace: Turkish filled with 1683
      // cues at 314 ms, emptied by _cleanTracks at 352 ms. After each of those
      // events, put the chosen track back and refill it.
      const reassert = () => {
        this.hlsTouchedTracksAt = performance.now();
        queueMicrotask(() => this.reassertSubtitles(video));
      };
      hls.on(Hls.Events.MEDIA_ATTACHED, reassert);
      hls.on(Hls.Events.MANIFEST_LOADING, reassert);
      hls.on(Hls.Events.MANIFEST_PARSED, reassert);
      hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, reassert);
      hls.on(Hls.Events.SUBTITLE_TRACK_SWITCH, reassert);

      // Opt-in telemetry for diagnosing playback complaints: fiesta.show/...?hlsdebug
      // Without `debug` hls.js installs a no-op logger, so the strings that actually
      // name these failures ("Injecting N audio frames ... due to Y ms gap", "hole
      // between fragments detected at") are never emitted — the evidence has been
      // absent rather than the bug. Read window.__fiestaTelemetry after a watch.
      if (this.hlsDebug) {
        (window as unknown as Record<string, unknown>)['__hls'] = hls;
        const t = {
          skew: [] as { sn: number; ms: number }[],
          levels: [] as { at: number; level: number }[],
          holes: 0,
          nudges: 0,
          stalls: 0,
        };
        (window as unknown as Record<string, unknown>)['__fiestaTelemetry'] = t;
        hls.on(Hls.Events.FRAG_PARSED, (_e, d) => {
          const a = d.frag?.elementaryStreams?.audio;
          const v = d.frag?.elementaryStreams?.video;
          if (a && v) t.skew.push({ sn: d.frag.sn as number, ms: +((a.startPTS - v.startPTS) * 1000).toFixed(2) });
        });
        hls.on(Hls.Events.LEVEL_SWITCHED, (_e, d) =>
          t.levels.push({ at: +performance.now().toFixed(0), level: d.level }),
        );
        hls.on(Hls.Events.ERROR, (_e, d) => {
          if (d.details === Hls.ErrorDetails.BUFFER_SEEK_OVER_HOLE) t.holes++;
          if (d.details === Hls.ErrorDetails.BUFFER_NUDGE_ON_STALL) t.nudges++;
          if (d.details === Hls.ErrorDetails.BUFFER_STALLED_ERROR) t.stalls++;
        });
      }

      // The quality menu reads video.videoRenditions; install it before
      // attachMedia because Video.js re-reads it on `loadstart`.
      const renditions = installRenditions(video, hls);
      this.removeRenditions = renditions.remove;
      hls.on(Hls.Events.MANIFEST_PARSED, () => renditions.list.sync());
      hls.on(Hls.Events.LEVELS_UPDATED, () => renditions.list.sync());
      hls.on(Hls.Events.LEVEL_SWITCHED, (_e, d) => renditions.list.setActive(d.level));

      this.subsyncHls = { hls, appendEvent: Hls.Events.BUFFER_APPENDING, video };
      this.startSubsync();
      if (this.playerUi() === 'custom') this.installSubsyncItem(video);

      hls.loadSource(master);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        this.restoreProgress(video);
        if (this.started() && !this.holdPaused) void video.play().catch(() => {}); // resume after a mid-watch escalation
      });
      // recoverAttempts was only ever reset on a fresh load, so the cap below was
      // three recoveries for an entire film: a 2h watch that hiccupped three times
      // in the first ten minutes had no budget left for the remaining 110. A
      // fragment that buffers cleanly is proof the stream is healthy again, so
      // spend the budget per-incident rather than per-session.
      hls.on(Hls.Events.FRAG_BUFFERED, () => {
        if (this.recoverAttempts !== 0) this.recoverAttempts = 0;
      });
      hls.on(Hls.Events.ERROR, (_evt, data) => {
        // A stall inside an already-buffered range never fires the media element's
        // `waiting` event, so the spinner — driven only by onWaiting/onSeeking —
        // stayed hidden through a visible freeze. These arrive non-fatal.
        if (
          data.details === Hls.ErrorDetails.BUFFER_STALLED_ERROR ||
          data.details === Hls.ErrorDetails.BUFFER_SEEK_OVER_HOLE ||
          data.details === Hls.ErrorDetails.BUFFER_NUDGE_ON_STALL
        ) {
          this.beginBuffering();
        }
        if (!data.fatal) return;
        // Try to recover transient fatal errors before giving up; only surface an
        // error once recovery is exhausted (or the failure is unrecoverable).
        // The video element keeps the last decoded frame on screen during this
        // window — overlay a buffering spinner instead of an error message.
        // A fatal manifest error means hls.js has already used its own retries
        // and holds no playlist; startLoad() would reload nothing and the player
        // would hang without a further error. Go straight to the fallbacks.
        const manifestFailed =
          data.details === Hls.ErrorDetails.MANIFEST_LOAD_ERROR ||
          data.details === Hls.ErrorDetails.MANIFEST_LOAD_TIMEOUT ||
          data.details === Hls.ErrorDetails.MANIFEST_PARSING_ERROR;
        if (!manifestFailed && data.type === Hls.ErrorTypes.NETWORK_ERROR && this.recoverAttempts < 3) {
          this.recoverAttempts++;
          this.beginBuffering();
          hls.startLoad();
        } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR && this.recoverAttempts < 3) {
          this.recoverAttempts++;
          this.beginBuffering();
          hls.recoverMediaError();
        } else if (!this.hlsFailed && video.canPlayType('application/vnd.apple.mpegurl')) {
          // hls.js gave up, but this browser can play HLS itself: try that once
          // before failPlayback()'s server escalation. Position comes back from
          // the saved progress, as on any re-attach.
          this.hlsFailed = true;
          this.destroyHls();
          this.attachNative(video, master, false);
        } else {
          this.failPlayback(data.details || 'playback error');
        }
      });
      return;
    }

    // Native HLS fallback (iOS Safari, or anywhere MSE is unavailable). The
    // browser drives quality here; surface a friendly message if it can't load.
    this.attachNative(video, master, false);
  }

  private preferNativeHls(video: HTMLVideoElement): boolean {
    if (this.hlsEngine !== 'native' || this.nativeFailed) return false;
    return !!video.canPlayType('application/vnd.apple.mpegurl');
  }

  private attachNative(video: HTMLVideoElement, master: string, canFallBack: boolean) {
    const native = video.canPlayType('application/vnd.apple.mpegurl');
    video.src = master;
    this.restoreProgress(video);
    if (this.started() && !this.holdPaused) void video.play().catch(() => {}); // resume after a mid-watch escalation
    this.nativeErrorHandler = () => {
      this.nativeErrorHandler = null;
      if (canFallBack) {
        // Keep the position: restoreProgress() reads the saved progress, and a
        // mid-watch failure has been saving it all along.
        this.nativeFailed = true;
        this.destroyHls();
        this.attachedUrl = null;
        void this.attach(video, master);
        return;
      }
      this.failPlayback(native ? 'native: media error' : 'unsupported: media error');
    };
    video.addEventListener('error', this.nativeErrorHandler, { once: true });
  }

  // Mid-playback stall: hold the spinner off briefly so quick seeks/microstalls
  // don't flash an overlay over a frame that's about to advance anyway.
  private beginBuffering() {
    if (this.bufferingTimer || this.buffering()) return;
    this.bufferingTimer = setTimeout(() => {
      this.bufferingTimer = null;
      if (this.started()) this.buffering.set(true);
    }, 350);
  }

  private clearBuffering() {
    if (this.bufferingTimer) {
      clearTimeout(this.bufferingTimer);
      this.bufferingTimer = null;
    }
    if (this.buffering()) this.buffering.set(false);
  }

  onWaiting() {
    if (this.started()) this.beginBuffering();
  }

  onPlaying() {
    this.clearBuffering();
  }

  onCanPlay() {
    this.clearBuffering();
  }

  onSeeking() {
    if (this.started()) this.beginBuffering();
  }

  onSeeked() {
    this.clearBuffering();
  }

  private failPlayback(detail: string) {
    this.destroyHls();
    this.attachedUrl = null; // allow a retry to re-attach the same master
    this.clearBuffering();

    // Server 1's stream resolved but won't play (e.g. dead segments). The same
    // title often lives on the other cloudnestra front, so transparently
    // escalate to server 2 once, preserving the play state mid-watch.
    if (!this.escalated && this.activeServer() === 1) {
      this.escalated = true;
      this.hlsFailed = false; // server 2 is a different stream: hls.js gets a fresh try
      void this.loadStream(2, true);
      return;
    }
    this.errorMsg.set(detail); // both fronts exhausted
  }

  retry() {
    this.attachedUrl = null;
    void this.loadStream();
  }

  private async loadSubtitles(token: number) {
    try {
      const type = this.type() === 'tv' ? 'tv' : 'movie';
      const params = new URLSearchParams({ type, id: this.imdbId() });
      const s = this.season();
      const e = this.episode();
      if (type === 'tv' && s && e) {
        params.set('s', String(s));
        params.set('e', String(e));
      }
      const res = await fetch(`/api/subs?${params.toString()}`);
      if (token !== this.loadToken) return;
      const data = await res.json().catch(() => ({}));
      if (token !== this.loadToken) return;
      const tracks = Array.isArray(data?.tracks) ? data.tracks : [];
      const marked = this.markPreferredSubtitle(tracks);

      // The list renders right away (the captions menu shows every language
      // immediately); applySubtitlePreference() fills and shows the preferred
      // one as soon as its <track> exists; the rest load when picked.
      this.subtitleTracks.set(marked);
      void this.preloadPreferredSubtitle(token, marked);
    } catch {
      if (token === this.loadToken) this.subtitleTracks.set([]);
    }
  }

  private subtitleKey(t: { lang: string; label: string }): string {
    return `${t.lang}::${t.label}`;
  }

  private trackInfo(key: string): { lang: string; label: string; src: string } | undefined {
    return this.subtitleTracks().find((t) => this.subtitleKey(t) === key);
  }

  private trackElementFor(video: HTMLVideoElement, key: string): HTMLTrackElement | null {
    return (
      Array.from(video.querySelectorAll('track')).find(
        (el) => this.subtitleKey({ lang: el.srclang, label: el.label }) === key,
      ) ?? null
    );
  }

  // HTMLTrackElement.readyState: 0 NONE, 1 LOADING, 2 LOADED, 3 ERROR. A track
  // element only starts loading (its inert stub) the first time it is set to
  // showing/hidden — and Chromium empties the TextTrack's cue list when that
  // first load completes, script-added cues included (reproduced in a blank
  // page: 5 cues added before the load, 0 a second later; cues added after
  // the load survive every later disable/show toggle). So cues are only ever
  // pushed into a track whose element has finished loading; earlier than
  // that they stay in cueCache and onTrackLoaded() pushes them.
  private isTrackElementSettled(el: HTMLTrackElement | null): boolean {
    return !el || el.readyState >= 2;
  }

  // Bound to (load)/(error) on every <track>: the element has just finished
  // its first load, which is exactly when Chromium wipes whatever cues were
  // already there. Re-fill from the cache if it did.
  onTrackLoaded(event: Event) {
    const el = event.target as HTMLTrackElement | null;
    const tt = el?.track;
    if (!el || !tt) return;
    if (tt.cues && tt.cues.length > 0) {
      this.filledTracks.add(tt); // nothing was lost
      return;
    }
    this.filledTracks.delete(tt);
    if (tt.mode === 'disabled') return; // ensureCues() fills it when it is shown
    const cues = this.cueCache.get(this.subtitleKey({ lang: el.srclang, label: el.label }));
    if (cues) this.fillTrack(tt, cues);
  }

  // The saved preference resolved against THIS title's track list: the same
  // lang+label when it exists, otherwise the first track in that language.
  // Labels carry a release tag ("English — Web", "English — DVD"), so an
  // exact match across titles is the exception, not the rule.
  private preferredKeyFor(video: HTMLVideoElement): string | null {
    const pref = this.readSubtitlePref();
    if (!pref) return null;
    const list = video.textTracks;
    for (let i = 0; i < list.length; i++) {
      const key = this.subtitleKey({ lang: list[i].language, label: list[i].label });
      if (list[i].language === pref.lang && list[i].label === pref.label && !this.failedCueKeys.has(key)) return key;
    }
    for (let i = 0; i < list.length; i++) {
      const key = this.subtitleKey({ lang: list[i].language, label: list[i].label });
      if (list[i].language === pref.lang && !this.failedCueKeys.has(key)) return key;
    }
    return null;
  }

  private textTrackFor(video: HTMLVideoElement, key: string): TextTrack | null {
    const list = video.textTracks;
    for (let i = 0; i < list.length; i++) {
      if (this.subtitleKey({ lang: list[i].language, label: list[i].label }) === key) return list[i];
    }
    return null;
  }

  // Fetch the viewer's preferred track in the background so it is on screen
  // the moment playback starts. Nothing else is preloaded: every file is an
  // OpenSubtitles download against a per-IP cap (Vercel's shared IPs for the
  // proxy, the viewer's own for the direct fallback), and preloading every
  // language (~17 per title view) is what exhausted it. With no saved
  // preference the viewer hasn't used subtitles, so nothing is fetched until a
  // pick; other tracks load on demand (see wireSubtitlePersistence).
  private async preloadPreferredSubtitle(
    token: number,
    tracks: { lang: string; label: string; src: string; isDefault: boolean }[],
  ) {
    const t = tracks.find((x) => x.isDefault);
    if (!t) return;
    const cues = await this.fetchCues(token, t);
    if (token !== this.loadToken || !cues) return; // superseded — episode/retry/server switch
    // Only a track whose element has already loaded can hold cues safely
    // (see isTrackElementSettled); otherwise it waits in cueCache.
    const video = this.videoEl()?.nativeElement;
    if (!video) return;
    const key = this.subtitleKey(t);
    const tt = this.textTrackFor(video, key);
    if (tt && this.isTrackElementSettled(this.trackElementFor(video, key))) this.fillTrack(tt, cues);
  }

  // Download + parse one subtitle file, once. Concurrent callers (viewer pick
  // racing the background preload) share the same in-flight promise. One retry
  // after a short pause covers the download host's transient 502/403s.
  private fetchCues(token: number, t: { lang: string; label: string; src: string }): Promise<VttCue[] | null> {
    const key = this.subtitleKey(t);
    const cached = this.cueCache.get(key);
    if (cached) return Promise.resolve(cached);
    const inflight = this.cueFetches.get(key);
    if (inflight) return inflight;

    const run = (async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        if (attempt > 0) await sleep(1200);
        if (token !== this.loadToken) return null;
        // Our proxy first: a file it has served before comes from Vercel's
        // cache in ~50 ms without touching OpenSubtitles.
        try {
          const res = await fetch(t.src);
          if (token !== this.loadToken) return null;
          if (res.ok) {
            const cues = parseVtt(await res.text());
            if (token !== this.loadToken) return null;
            if (cues.length > 0) {
              this.cueCache.set(key, cues);
              return cues;
            }
          }
        } catch {
          // fall through to the direct download
        }
        // Uncached and the proxy's shared IPs are over OpenSubtitles' download
        // cap (it answers 401, we relay 502): fetch from the viewer's own IP.
        try {
          const cues = await fetchSubtitleDirect(t.src);
          if (token !== this.loadToken) return null;
          if (cues) {
            this.cueCache.set(key, cues);
            return cues;
          }
        } catch {
          // retry once, then give up
        }
      }
      return null;
    })().finally(() => {
      if (this.cueFetches.get(key) === run) this.cueFetches.delete(key);
    });
    this.cueFetches.set(key, run);
    return run;
  }

  private fillTrack(track: TextTrack, cues: VttCue[]) {
    if (this.filledTracks.has(track)) return;
    this.filledTracks.add(track);
    if (track.cues && track.cues.length > 0) return; // already holds its cues (nothing was wiped)
    const CueCtor: typeof VTTCue | undefined =
      (window as unknown as { VTTCue?: typeof VTTCue }).VTTCue ??
      ((window as unknown as { TextTrackCue?: typeof VTTCue }).TextTrackCue as typeof VTTCue | undefined);
    if (!CueCtor) return;
    for (const c of cues) {
      try {
        track.addCue(new CueCtor(c.start, c.end, c.text));
      } catch {
        // a malformed cue must not take the rest of the file down with it
      }
    }
  }

  // Make sure a track that is (about to be) showing actually has its cues —
  // fetching them now if it doesn't yet.
  private async ensureCues(token: number, video: HTMLVideoElement, key: string, track: TextTrack) {
    if (this.filledTracks.has(track)) return;
    const info = this.trackInfo(key);
    if (!info) return;
    const cues = await this.fetchCues(token, info);
    if (token !== this.loadToken) return;
    if (!cues) {
      this.failedCueKeys.add(key);
      // Only act if the viewer is still waiting on this very track.
      if (track.mode !== 'showing') return;
      await this.fallBackToSibling(token, video, info);
      return;
    }
    // The <track> may have been re-rendered while we were downloading.
    const current = this.textTrackFor(video, key) ?? track;
    // Still loading its stub: onTrackLoaded() fills it the moment that ends.
    if (!this.isTrackElementSettled(this.trackElementFor(video, key))) return;
    this.fillTrack(current, cues);
  }

  // After hls.js has rewritten the text tracks: re-show whichever track the
  // viewer had (or the saved preference), and refill it from the cache
  // (hls.js's wipe leaves the TextTrack objects in place but empty, so the
  // "already filled" bookkeeping has to start over).
  private reassertSubtitles(video: HTMLVideoElement) {
    this.filledTracks = new WeakSet<TextTrack>();
    const list = video.textTracks;
    const showing: string[] = [];
    for (let i = 0; i < list.length; i++) {
      if (list[i].mode === 'showing') showing.push(this.subtitleKey({ lang: list[i].language, label: list[i].label }));
    }
    const prefKey = this.preferredKeyFor(video);
    // Several showing at once here means Chromium's locale auto-selection
    // joined in — the viewer's own choice (saved pref, then the last track
    // we reconciled to) outranks it.
    const wanted =
      (prefKey && showing.indexOf(prefKey) !== -1 ? prefKey : null) ??
      (this.lastShowingKey && showing.indexOf(this.lastShowingKey) !== -1 ? this.lastShowingKey : null) ??
      showing[0] ??
      this.lastShowingKey ??
      prefKey;
    if (!wanted) return;
    this.hlsTouchedTracksAt = performance.now();
    let target: TextTrack | null = null;
    for (let i = 0; i < list.length; i++) {
      const t = list[i];
      const isMatch = this.subtitleKey({ lang: t.language, label: t.label }) === wanted;
      if (t.mode !== (isMatch ? 'showing' : 'disabled')) t.mode = isMatch ? 'showing' : 'disabled';
      if (isMatch) target = t;
    }
    if (!target) return;
    this.lastShowingKey = wanted;
    void this.ensureCues(this.loadToken, video, wanted, target);
  }

  // The chosen file is unavailable: try the other variants of the same
  // language in list order and switch to the first that downloads, telling
  // the viewer which one is on. The saved preference is left alone — this
  // is a stand-in for one title, not a new choice.
  private async fallBackToSibling(token: number, video: HTMLVideoElement, failed: { lang: string; label: string }) {
    const failedKey = this.subtitleKey(failed);
    const siblings = this.subtitleTracks().filter(
      (t) => t.lang === failed.lang && this.subtitleKey(t) !== failedKey && !this.failedCueKeys.has(this.subtitleKey(t)),
    );
    for (const alt of siblings) {
      const cues = await this.fetchCues(token, alt);
      if (token !== this.loadToken) return;
      const altKey = this.subtitleKey(alt);
      if (!cues) {
        this.failedCueKeys.add(altKey);
        continue;
      }
      const failedTrack = this.textTrackFor(video, failedKey);
      const altTrack = this.textTrackFor(video, altKey);
      if (!altTrack) return;
      // Still what the viewer wants? (They may have moved on meanwhile.)
      if (failedTrack && failedTrack.mode !== 'showing') return;
      this.hlsTouchedTracksAt = performance.now(); // our switch, not the viewer's: don't persist it
      if (failedTrack) failedTrack.mode = 'disabled';
      altTrack.mode = 'showing';
      this.lastShowingKey = altKey;
      this.setSubtitleNotice(`“${failed.label}” is unavailable — showing “${alt.label}” instead`);
      void this.ensureCues(token, video, altKey, altTrack);
      return;
    }
    this.setSubtitleNotice('Subtitles failed to load — try another version');
  }

  private setSubtitleNotice(msg: string | null) {
    if (this.subtitleNoticeTimer) {
      clearTimeout(this.subtitleNoticeTimer);
      this.subtitleNoticeTimer = null;
    }
    this.subtitleNotice.set(msg);
    if (msg) {
      this.subtitleNoticeTimer = setTimeout(() => {
        this.subtitleNoticeTimer = null;
        this.subtitleNotice.set(null);
      }, 5000);
    }
  }

  // Mark the track matching the viewer's last-picked language (and variant,
  // when the same label exists) with the native <track default> attribute —
  // a harmless first-paint hint; applySubtitlePreference() below is what
  // actually and reliably enforces it once the tracks are in the DOM.
  private markPreferredSubtitle(
    tracks: { lang: string; label: string; src: string }[],
  ): { lang: string; label: string; src: string; isDefault: boolean }[] {
    const pref = this.readSubtitlePref();
    let preferredIndex = -1;
    if (pref) {
      preferredIndex = tracks.findIndex((t) => t.lang === pref.lang && t.label === pref.label);
      if (preferredIndex === -1) preferredIndex = tracks.findIndex((t) => t.lang === pref.lang);
    }
    return tracks.map((t, i) => ({ ...t, isDefault: i === preferredIndex }));
  }

  // Force the saved preference onto the current textTrack list. Runs whenever
  // subtitleTracks() changes (episode switch, retry, server escalation) —
  // browsers don't reliably re-apply <track default> on a swapped track list
  // once the viewer has touched captions once, so this is the source of truth.
  private applySubtitlePreference(video: HTMLVideoElement) {
    if (!this.readSubtitlePref()) return;
    const token = this.loadToken;
    const apply = () => {
      if (token !== this.loadToken) return;
      const key = this.preferredKeyFor(video);
      if (!key) return;
      const list = video.textTracks;
      let matched: TextTrack | null = null;
      for (let i = 0; i < list.length; i++) {
        const t = list[i];
        const isMatch = this.subtitleKey({ lang: t.language, label: t.label }) === key;
        t.mode = isMatch ? 'showing' : 'disabled';
        if (isMatch) matched = t;
      }
      // Chromium can independently auto-select a track matching the browser's
      // locale via its own "honor user preferences" algorithm, racing with the
      // assignment above — collapse back down to a single showing track.
      const showing = this.enforceSingleShowing(video) ?? matched;
      if (showing) {
        void this.ensureCues(token, video, this.subtitleKey({ lang: showing.language, label: showing.label }), showing);
      }
    };
    apply();
    // This runs off a subtitleTracks() effect, which can fire before the
    // freshly (re)rendered <track> elements have actually committed to the
    // DOM — video.textTracks would then be empty/stale and the assignment
    // above a silent no-op. Re-apply once the current render has settled.
    queueMicrotask(apply);
  }

  // Browsers don't guarantee only one subtitle/captions track is ever
  // 'showing' when tracks are toggled via script — multiple can end up
  // simultaneously active (observed: Chromium auto-selecting a track
  // matching its locale independently of ours). Collapse to one, preferring
  // whichever matches the saved preference if it's among the showing set.
  private enforceSingleShowing(video: HTMLVideoElement): TextTrack | null {
    const list = video.textTracks;
    const showingIdx: number[] = [];
    for (let i = 0; i < list.length; i++) {
      if (list[i].mode === 'showing') showingIdx.push(i);
    }
    if (showingIdx.length === 0) {
      this.lastShowingKey = null;
      return null;
    }

    // Several showing at once is never a viewer's doing — native captions
    // menus disable the previous track before enabling the next — it is the
    // browser's own automatic selection (Chromium enables a track matching
    // its locale on load) colliding with ours. So the saved preference wins
    // when it is among them; failing that, keep whichever was not already
    // showing last time, so a script-driven switch still lands on the new one.
    let keepIdx = showingIdx[0];
    const prefKey = this.preferredKeyFor(video);
    const prefIdx = prefKey
      ? showingIdx.find((i) => this.subtitleKey({ lang: list[i].language, label: list[i].label }) === prefKey)
      : undefined;
    if (prefIdx !== undefined) {
      keepIdx = prefIdx;
    } else {
      const previous = this.lastShowingKey;
      const fresh = showingIdx.find((i) => this.subtitleKey({ lang: list[i].language, label: list[i].label }) !== previous);
      if (fresh !== undefined) keepIdx = fresh;
    }
    for (const i of showingIdx) {
      if (i !== keepIdx) list[i].mode = 'disabled';
    }
    this.lastShowingKey = this.subtitleKey({ lang: list[keepIdx].language, label: list[keepIdx].label });
    return list[keepIdx];
  }

  // Native <video> controls fire this on the track list whenever the viewer
  // toggles captions or switches language/variant (and whenever a browser's
  // own automatic track selection kicks in). Fill the chosen track with its
  // cues if it doesn't have them yet, and persist the choice (or its absence).
  private wireSubtitlePersistence(video: HTMLVideoElement) {
    video.textTracks.onchange = () => {
      // hls.js just rewrote the list (see reassertSubtitles), or the browser
      // auto-selected a track on load: not the viewer's doing, so the saved
      // preference must not follow it — but still collapse to one track.
      const machineDriven = performance.now() - this.hlsTouchedTracksAt < 1000;
      const showing = this.enforceSingleShowing(video);
      if (showing) {
        const key = this.subtitleKey({ lang: showing.language, label: showing.label });
        void this.ensureCues(this.loadToken, video, key, showing);
      }
      if (!machineDriven) this.saveSubtitlePref(showing ? { lang: showing.language, label: showing.label } : null);
    };
  }

  private readSubtitlePref(): { lang: string; label: string } | null {
    if (typeof window === 'undefined') return null;
    try {
      const raw = window.localStorage.getItem(MoviePlayerComponent.SUBTITLE_PREF_KEY);
      if (!raw) return null;
      const data = JSON.parse(raw) as { lang?: unknown; label?: unknown };
      if (typeof data.lang !== 'string' || typeof data.label !== 'string') return null;
      return { lang: data.lang, label: data.label };
    } catch {
      return null;
    }
  }

  private saveSubtitlePref(pref: { lang: string; label: string } | null) {
    if (typeof window === 'undefined') return;
    try {
      if (!pref) {
        window.localStorage.removeItem(MoviePlayerComponent.SUBTITLE_PREF_KEY);
      } else {
        window.localStorage.setItem(MoviePlayerComponent.SUBTITLE_PREF_KEY, JSON.stringify(pref));
      }
    } catch {}
  }

  // Preview debug: read the X-Fiesta-Source header stamped on the master playlist
  // ('relay' = home residential relay, 'proxy'/'direct' = Webshare fallback path).
  // The master is a tiny playlist, so this costs ~nothing.
  private async probeSegmentSource(master: string, token: number) {
    try {
      const r = await fetch(master);
      if (token !== this.loadToken) return;
      this.segmentSource.set(r.headers.get('X-Fiesta-Source'));
    } catch {}
  }

  private autostartDone = false;

  /**
   * The click that asked for playback happened on the previous page, and a
   * gesture doesn't survive a navigation — so the browser may refuse to play.
   * If it does, drop straight back to the normal play button rather than
   * leaving a started-but-silent player on screen.
   */
  private async autoStartPlayback() {
    const video = this.videoEl()?.nativeElement;
    if (!video) return;

    const resume = this.resumeTime();
    if (resume !== null) {
      this.pendingResumeTime = resume;
      this.resumeTime.set(null);
    } else {
      this.restoreProgress(video);
    }

    this.started.set(true);
    this.paused.set(false);
    try {
      await video.play();
    } catch {
      this.started.set(false);
      this.paused.set(false);
      if (resume !== null) this.resumeTime.set(resume);
    }
  }

  startPlayback() {
    const video = this.videoEl()?.nativeElement;
    if (!video) return;
    this.restoreProgress(video);
    this.started.set(true);
    this.paused.set(false);
    void video.play().catch(() => {});
  }

  continueFromSavedProgress() {
    this.pendingResumeTime = this.resumeTime();
    this.resumeTime.set(null);
    this.startPlayback();
  }

  restartPlayback() {
    this.pendingResumeTime = null;
    this.resumeTime.set(null);
    this.clearSavedProgress();

    const video = this.videoEl()?.nativeElement;
    if (video) {
      try {
        video.currentTime = 0;
      } catch {}
    }

    this.startPlayback();
  }

  resumeTimeLabel(): string {
    const time = this.resumeTime();
    if (!time) return '';

    const hours = Math.floor(time / 3600);
    const minutes = Math.floor((time % 3600) / 60);
    const seconds = Math.floor(time % 60);

    if (hours > 0) {
      return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    }
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
  }

  onMetadataLoaded(video: HTMLVideoElement) {
    this.restoreProgress(video);
  }

  onTimeUpdate(video: HTMLVideoElement) {
    if (Date.now() - this.lastProgressSaveAt < 5000) return;
    this.saveProgress(video);
  }

  onPlaybackStarted() {
    this.started.set(true);
    this.paused.set(false);
    this.holdPaused = false;
  }

  onPlaybackPaused(video: HTMLVideoElement) {
    this.saveProgress(video);
    if (this.started() && !video.ended) {
      this.paused.set(true);
    }
  }

  onPlaybackEnded() {
    this.clearSavedProgress();
    this.paused.set(false);
  }

  private restoreProgress(video: HTMLVideoElement) {
    const time = this.pendingResumeTime;
    if (!time || time < 5) return;

    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    if (duration > 0 && time >= duration - 10) {
      this.clearSavedProgress();
      this.pendingResumeTime = null;
      return;
    }

    try {
      video.currentTime = time;
      if (video.readyState > 0) {
        this.pendingResumeTime = null;
      }
    } catch {
      // Some browsers reject seeking before metadata is ready; loadedmetadata will retry.
    }
  }

  private saveProgress(video: HTMLVideoElement) {
    if (video.ended || !Number.isFinite(video.currentTime) || video.currentTime < 5) return;

    const duration = Number.isFinite(video.duration) ? video.duration : null;
    if (duration && video.currentTime >= duration - 10) {
      this.clearSavedProgress();
      return;
    }

    const key = this.progressKey();
    if (!key) return;

    const data = {
      id: this.imdbId(),
      type: this.type() === 'tv' ? 'tv' : 'movie',
      season: this.season(),
      episode: this.episode(),
      time: Math.floor(video.currentTime),
      duration: duration ? Math.floor(duration) : null,
      updatedAt: Date.now(),
    };

    try {
      window.localStorage.setItem(key, JSON.stringify(data));
      this.lastProgressSaveAt = Date.now();
    } catch {}
  }

  private readSavedProgress(): number | null {
    const key = this.progressKey();
    if (!key) return null;

    try {
      const raw = window.localStorage.getItem(key);
      if (!raw) return null;
      const data = JSON.parse(raw) as { time?: unknown; updatedAt?: unknown };
      const updatedAt = typeof data.updatedAt === 'number' ? data.updatedAt : 0;
      if (updatedAt && Date.now() - updatedAt > 1000 * 60 * 60 * 24 * 90) {
        window.localStorage.removeItem(key);
        return null;
      }
      return typeof data.time === 'number' && Number.isFinite(data.time) ? data.time : null;
    } catch {
      return null;
    }
  }

  private clearSavedProgress() {
    const key = this.progressKey();
    if (!key) return;

    try {
      window.localStorage.removeItem(key);
    } catch {}
  }

  private progressKey(): string | null {
    const id = this.imdbId();
    if (!id || typeof window === 'undefined') return null;

    const type = this.type() === 'tv' ? 'tv' : 'movie';
    if (type === 'tv') {
      return `${MoviePlayerComponent.PROGRESS_PREFIX}${id}:tv:s${this.season() ?? 1}:e${this.episode() ?? 1}`;
    }
    return `${MoviePlayerComponent.PROGRESS_PREFIX}${id}:movie`;
  }

  private destroyHls() {
    this.stopSubsync();
    this.subsyncHls = null;
    this.subsyncItem?.remove();
    this.subsyncItem = null;
    if (this.hls) {
      this.hls.destroy();
      this.hls = null;
    }
    this.removeRenditions?.();
    this.removeRenditions = null;
    const video = this.videoEl()?.nativeElement;
    if (this.nativeErrorHandler) {
      video?.removeEventListener('error', this.nativeErrorHandler);
      this.nativeErrorHandler = null;
    }
    // Drop a native src so hls.js (or the next native attach) starts clean.
    if (video?.getAttribute('src')) {
      video.removeAttribute('src');
      video.load();
    }
  }
}
