import {
  Component,
  ElementRef,
  HostListener,
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
import type Hls from 'hls.js';
import { parseVtt, VttCue } from '../../utils/vtt';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

@Component({
  selector: 'app-movie-player',
  imports: [],
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
  // background queue never download the same file twice at once.
  private readonly cueFetches = new Map<string, Promise<VttCue[] | null>>();

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
  // Defer the buffering spinner so quick seeks/microstalls don't flash it.
  private bufferingTimer: ReturnType<typeof setTimeout> | null = null;
  // true once we've already escalated server 1 -> server 2, so we don't loop
  private escalated = false;
  private pendingResumeTime: number | null = null;
  private lastProgressSaveAt = 0;

  private static readonly UNAVAILABLE = 'This title isn’t available to stream right now';
  private static readonly PROGRESS_PREFIX = 'fiesta:playback-progress:';
  private static readonly SUBTITLE_PREF_KEY = 'fiesta:subtitle-pref';
  // Gap between the start of one background subtitle prefetch and the next —
  // keeps our own preloading well clear of OpenSubtitles' burst rate limit.
  // This host is genuinely fragile under volume (observed: their download
  // host, dl.opensubtitles.org, started 502ing every request from this
  // project's Vercel egress IP under sustained testing, while the same file
  // fetched from an unrelated IP succeeded immediately — an IP-level
  // rate-limit/block, not a per-request fluke), so this errs conservative.
  private static readonly PRELOAD_GAP_MS = 800;
  private static readonly SEEK_STEP = 10;

  constructor() {
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
      this.applySubtitlePreference(ref.nativeElement);
    });
  }

  ngOnChanges(_changes: SimpleChanges) {
    void this.loadStream();
  }

  ngOnDestroy() {
    this.destroyHls();
    if (this.bufferingTimer) clearTimeout(this.bufferingTimer);
    if (this.subtitleNoticeTimer) clearTimeout(this.subtitleNoticeTimer);
    this.cueCache.clear();
    this.cueFetches.clear();
  }

  // Keyboard transport for the native player: Left/Right step 10 s. The
  // browser's own handling (Chromium: 5 s, only while the <video> itself is
  // focused; Safari: nothing) is replaced so the keys work anywhere on the
  // page once playback has started, but never while typing in a field.
  @HostListener('document:keydown', ['$event'])
  onDocumentKeydown(event: KeyboardEvent) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    if (event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented) return;
    if (!this.started() || !this.masterUrl()) return;
    const target = event.target as HTMLElement | null;
    if (target && this.isEditable(target)) return;
    const video = this.videoEl()?.nativeElement;
    if (!video) return;
    event.preventDefault();
    this.seekBy(video, event.key === 'ArrowLeft' ? -MoviePlayerComponent.SEEK_STEP : MoviePlayerComponent.SEEK_STEP);
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
    if (!srv) this.escalated = false; // fresh, unforced load — reset escalation state
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

    // Prefer hls.js wherever MSE is available — including desktop Safari — so we
    // drive ABR/quality and error recovery ourselves. Safari's native HLS would
    // otherwise pick its own (conservative) quality through the relay, which we
    // can't tune. Native HLS is the fallback only when MSE is absent (iOS Safari).
    const Hls = (await import('hls.js')).default;
    if (Hls.isSupported()) {
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
      });
      this.hls = hls;

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

      hls.loadSource(master);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        this.restoreProgress(video);
        if (this.started()) void video.play().catch(() => {}); // resume after a mid-watch escalation
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
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR && this.recoverAttempts < 3) {
          this.recoverAttempts++;
          this.beginBuffering();
          hls.startLoad();
        } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR && this.recoverAttempts < 3) {
          this.recoverAttempts++;
          this.beginBuffering();
          hls.recoverMediaError();
        } else {
          this.failPlayback(data.details || 'playback error');
        }
      });
      return;
    }

    // Native HLS fallback (iOS Safari, or anywhere MSE is unavailable). The
    // browser drives quality here; surface a friendly message if it can't load.
    const native = video.canPlayType('application/vnd.apple.mpegurl');
    video.src = master;
    this.restoreProgress(video);
    if (this.started()) void video.play().catch(() => {}); // resume after a mid-watch escalation
    video.addEventListener('error', () => this.failPlayback(native ? 'native: media error' : 'unsupported: media error'), {
      once: true,
    });
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
      // one as soon as its <track> exists, and the queue below fetches the rest.
      this.subtitleTracks.set(marked);
      void this.preloadRemainingSubtitles(token, marked);
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

  private textTrackFor(video: HTMLVideoElement, key: string): TextTrack | null {
    const list = video.textTracks;
    for (let i = 0; i < list.length; i++) {
      if (this.subtitleKey({ lang: list[i].language, label: list[i].label }) === key) return list[i];
    }
    return null;
  }

  // Fetch every language's VTT in the background — preferred first, then
  // one at a time, spaced out (see PRELOAD_GAP_MS) — so OpenSubtitles' legacy
  // download host never sees a burst, and push each into its TextTrack so a
  // later pick in the captions menu is instant. Best-effort throughout: a
  // failure leaves that track to be fetched on demand when/if the viewer
  // picks it (see wireSubtitlePersistence), never blocks playback.
  private async preloadRemainingSubtitles(
    token: number,
    tracks: { lang: string; label: string; src: string; isDefault: boolean }[],
  ) {
    const ordered = [...tracks.filter((t) => t.isDefault), ...tracks.filter((t) => !t.isDefault)];
    let first = true;
    for (const t of ordered) {
      if (!first) {
        if (!this.canPreloadSubtitles()) return;
        await sleep(MoviePlayerComponent.PRELOAD_GAP_MS);
      }
      first = false;
      if (token !== this.loadToken) return; // superseded — episode/retry/server switch
      const cues = await this.fetchCues(token, t);
      if (token !== this.loadToken) return;
      const video = this.videoEl()?.nativeElement;
      const tt = video && cues ? this.textTrackFor(video, this.subtitleKey(t)) : null;
      if (tt && cues) this.fillTrack(tt, cues);
    }
  }

  // Download + parse one subtitle file, once. Concurrent callers (viewer pick
  // racing the preload queue) share the same in-flight promise. One retry
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
        try {
          const res = await fetch(t.src);
          if (token !== this.loadToken) return null;
          if (!res.ok) continue;
          const cues = parseVtt(await res.text());
          if (token !== this.loadToken) return null;
          if (cues.length === 0) continue;
          this.cueCache.set(key, cues);
          return cues;
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
  // fetching them now, ahead of the background queue, if it doesn't yet.
  private async ensureCues(token: number, video: HTMLVideoElement, key: string, track: TextTrack) {
    if (this.filledTracks.has(track)) return;
    const info = this.trackInfo(key);
    if (!info) return;
    const cues = await this.fetchCues(token, info);
    if (token !== this.loadToken) return;
    if (!cues) {
      // Only complain if the viewer is still waiting on this very track.
      if (track.mode === 'showing') this.setSubtitleNotice('Subtitles failed to load — try another version');
      return;
    }
    // The <track> may have been re-rendered while we were downloading.
    const current = this.textTrackFor(video, key) ?? track;
    this.fillTrack(current, cues);
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

  // Data-saver or a genuinely slow connection: skip background preloading
  // and leave every non-default track on the load-on-demand path. Subtitle
  // files are tiny (tens of KB), so this is a light-touch guard, not real
  // bandwidth probing — the Network Information API isn't universally
  // supported (notably Safari/Firefox), and preloading is the safe default
  // when we simply can't tell.
  private canPreloadSubtitles(): boolean {
    const conn = (navigator as any)?.connection;
    if (!conn) return true;
    if (conn.saveData) return false;
    if (typeof conn.effectiveType === 'string' && /2g/.test(conn.effectiveType)) return false;
    return true;
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
    const pref = this.readSubtitlePref();
    if (!pref) return;
    const token = this.loadToken;
    const apply = () => {
      if (token !== this.loadToken) return;
      const list = video.textTracks;
      let matched: TextTrack | null = null;
      for (let i = 0; i < list.length; i++) {
        const t = list[i];
        const isMatch = t.language === pref.lang && t.label === pref.label;
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
    if (showingIdx.length === 0) return null;

    let keepIdx = showingIdx[0];
    const pref = this.readSubtitlePref();
    if (pref) {
      const match = showingIdx.find((i) => list[i].language === pref.lang && list[i].label === pref.label);
      if (match !== undefined) keepIdx = match;
    }
    for (const i of showingIdx) {
      if (i !== keepIdx) list[i].mode = 'disabled';
    }
    return list[keepIdx];
  }

  // Native <video> controls fire this on the track list whenever the viewer
  // toggles captions or switches language/variant (and whenever a browser's
  // own automatic track selection kicks in). Fill the chosen track with its
  // cues if the background queue hasn't reached it yet — ahead of the queue,
  // since this one's urgent — and persist the choice (or its absence).
  private wireSubtitlePersistence(video: HTMLVideoElement) {
    video.textTracks.onchange = () => {
      const showing = this.enforceSingleShowing(video);
      if (showing) {
        const key = this.subtitleKey({ lang: showing.language, label: showing.label });
        void this.ensureCues(this.loadToken, video, key, showing);
      }
      this.saveSubtitlePref(showing ? { lang: showing.language, label: showing.label } : null);
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
    if (this.hls) {
      this.hls.destroy();
      this.hls = null;
    }
  }
}
