import {
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
import type Hls from 'hls.js';

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

  // external subtitle tracks (best per language) from /api/subs, listed for
  // the native captions menu. None get the raw network URL as their [src] —
  // see trackSrc/vttCache: a <track> whose src is assigned dynamically after
  // it already exists in the DOM can silently never fetch (observed: reliable
  // for a blob: URL, not for a plain network URL — assign only once fetched).
  // The default/preferred track is fetched before this list is even rendered
  // (see loadSubtitles); every other language is fetched afterward in the
  // background, one at a time (see preloadRemainingSubtitles) — OpenSubtitles'
  // legacy download host rate-limits a burst of simultaneous requests hard.
  readonly subtitleTracks = signal<{ lang: string; label: string; src: string; isDefault: boolean }[]>([]);
  // subtitleKey -> blob: URL of the already-fetched VTT text — the only
  // source of truth for whether a track has real, loadable content.
  readonly vttCache = signal<Map<string, string>>(new Map());

  // which cloudnestra front actually served the current stream (1=vidsrc, 2=vsembed)
  readonly activeServer = signal<number>(1);

  private hls: Hls | null = null;
  private attachedUrl: string | null = null;
  private loadToken = 0;
  private recoverAttempts = 0;
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

  constructor() {
    // Attach the stream once both the resolved master URL and the <video> exist.
    effect(() => {
      const url = this.masterUrl();
      const ref = this.videoEl();
      if (url && ref) void this.attach(ref.nativeElement, url);
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
    this.clearVttCache();
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
    this.clearVttCache();
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
      // The relay passes the source through, so bandwidth has headroom — bias ABR
      // toward higher quality instead of hls.js's conservative defaults, which
      // otherwise park on a low variant (smooth but soft) and never climb back up.
      const hls = new Hls({
        enableWorker: true,
        capLevelToPlayerSize: false, // never downscale to the <video> element's pixel size
        abrEwmaDefaultEstimate: 8_000_000, // start optimistic (~8 Mbit/s) instead of the 500 kbit/s floor
        abrBandWidthFactor: 1.0, // trust the full measured bandwidth (default 0.95)
        abrBandWidthUpFactor: 0.9, // upswitch readily (default 0.7)
        progressive: true, // append fragment bytes to the buffer as they stream in
        // rather than waiting for the whole segment response to finish
      });
      this.hls = hls;
      hls.loadSource(master);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        this.restoreProgress(video);
        if (this.started()) void video.play().catch(() => {}); // resume after a mid-watch escalation
      });
      hls.on(Hls.Events.ERROR, (_evt, data) => {
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
      const preferred = marked.find((t) => t.isDefault);

      // Fetch the default/restored track BEFORE the <track> list even
      // renders. A <track> element born with its real (blob:) src loads
      // reliably; one whose src is assigned after the fact — as this always
      // was for the default, via the native [default]/mode="showing" path —
      // can silently never fetch. Confirmed by direct repro: toggling mode
      // and even re-touching the *same* network src attribute did nothing;
      // only ever assigning a track a src it didn't already have (blob or
      // otherwise) reliably kicks off a load.
      if (preferred) {
        await this.prefetchTrack(token, preferred);
        if (token !== this.loadToken) return;
      }

      this.subtitleTracks.set(marked);
      void this.preloadRemainingSubtitles(token, marked);
    } catch {
      if (token === this.loadToken) this.subtitleTracks.set([]);
    }
  }

  private subtitleKey(t: { lang: string; label: string }): string {
    return `${t.lang}::${t.label}`;
  }

  // A track only ever gets a real src once its VTT text has actually been
  // fetched and cached as a blob: URL (see prefetchTrack) — never the raw
  // network URL directly (see the loadSubtitles/subtitleTracks comment for
  // why). Unloaded tracks still list in the native captions menu with no src.
  trackSrc(t: { lang: string; label: string }): string | null {
    return this.vttCache().get(this.subtitleKey(t)) ?? null;
  }

  // Fetch every non-default language's VTT text in the background — one at a
  // time, spaced out (see PRELOAD_GAP_MS) — so OpenSubtitles' legacy download
  // host never sees a burst, caching each as a blob: URL so switching to it
  // later is instant. Best-effort throughout: a fetch failure just leaves
  // that track to load on demand when/if the viewer picks it (see
  // wireSubtitlePersistence), never blocks or degrades playback.
  private async preloadRemainingSubtitles(
    token: number,
    tracks: { lang: string; label: string; src: string; isDefault: boolean }[],
  ) {
    if (!this.canPreloadSubtitles()) return;
    for (const t of tracks) {
      if (t.isDefault) continue; // already fetched up front in loadSubtitles
      await sleep(MoviePlayerComponent.PRELOAD_GAP_MS);
      if (token !== this.loadToken) return; // superseded — episode/retry/server switch
      await this.prefetchTrack(token, t);
    }
  }

  private async prefetchTrack(token: number, t: { lang: string; label: string; src: string }) {
    const key = this.subtitleKey(t);
    if (this.vttCache().has(key)) return; // already fetched (e.g. the viewer beat the preload queue to it)
    try {
      const res = await fetch(t.src);
      if (token !== this.loadToken || !res.ok) return;
      const text = await res.text();
      if (token !== this.loadToken) return;
      const url = URL.createObjectURL(new Blob([text], { type: 'text/vtt' }));
      this.vttCache.update((cache) => new Map(cache).set(key, url));
    } catch {
      // best-effort — this track just stays unloaded until retried
    }
  }

  // Data-saver or a genuinely slow connection: skip background preloading
  // and leave every non-default track on the existing load-on-demand path.
  // Subtitle files are tiny (tens of KB), so this is a light-touch guard, not
  // real bandwidth probing — the Network Information API isn't universally
  // supported (notably Safari/Firefox), and preloading is the safe default
  // when we simply can't tell.
  private canPreloadSubtitles(): boolean {
    const conn = (navigator as any)?.connection;
    if (!conn) return true;
    if (conn.saveData) return false;
    if (typeof conn.effectiveType === 'string' && /2g/.test(conn.effectiveType)) return false;
    return true;
  }

  private clearVttCache() {
    for (const url of this.vttCache().values()) URL.revokeObjectURL(url);
    this.vttCache.set(new Map());
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
    const key = this.subtitleKey(pref);
    const apply = () => {
      const cached = this.vttCache().get(key);
      const list = video.textTracks;
      for (let i = 0; i < list.length; i++) {
        const t = list[i];
        const isMatch = t.language === pref.lang && t.label === pref.label;
        if (isMatch && cached) {
          // Assign directly rather than trust the reactive [attr.src]
          // binding to have already committed (see assignTrackSrc).
          this.assignTrackSrc(video, key, cached, t);
        } else {
          t.mode = isMatch ? 'showing' : 'disabled';
        }
      }
      // Chromium can independently auto-select a track matching the browser's
      // locale via its own "honor user preferences" algorithm, racing with the
      // assignment above — collapse back down to a single showing track.
      this.enforceSingleShowing(video);
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
  // own automatic track selection kicks in). If the background preload queue
  // hasn't reached this track yet, fetch it now — ahead of the queue, since
  // this one's urgent — and persist the choice (or its absence) for future
  // playback.
  private wireSubtitlePersistence(video: HTMLVideoElement) {
    video.textTracks.onchange = () => {
      const showing = this.enforceSingleShowing(video);
      if (showing) {
        const key = this.subtitleKey({ lang: showing.language, label: showing.label });
        const shownTrack = showing;
        const cached = this.vttCache().get(key);
        if (cached) {
          this.assignTrackSrc(video, key, cached, shownTrack);
        } else {
          const token = this.loadToken;
          const track = this.subtitleTracks().find((t) => this.subtitleKey(t) === key);
          if (track) {
            void this.prefetchTrack(token, track).then(() => {
              if (token !== this.loadToken) return;
              const url = this.vttCache().get(key);
              if (url) this.assignTrackSrc(video, key, url, shownTrack);
            });
          }
        }
      }
      this.saveSubtitlePref(showing ? { lang: showing.language, label: showing.label } : null);
    };
  }

  // Assigns a <track> element's src directly via the DOM rather than trusting
  // that Angular's reactive [attr.src] binding (driven by the vttCache signal
  // write that just happened) has already committed to the DOM by the time
  // we act — confirmed unreliable in practice: mode can be (re)asserted
  // before that render lands, and a mode change alone doesn't retrigger a
  // fetch once the browser considers a track already "handled".
  private assignTrackSrc(video: HTMLVideoElement, key: string, url: string, showTrack: TextTrack) {
    const el = Array.from(video.querySelectorAll('track')).find(
      (t) => this.subtitleKey({ lang: t.srclang, label: t.label }) === key,
    );
    if (el && el.getAttribute('src') !== url) el.setAttribute('src', url);
    showTrack.mode = 'showing';
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
