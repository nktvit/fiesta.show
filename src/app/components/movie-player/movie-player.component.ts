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

  // preview-only debug: show whether segments load direct vs via the proxy
  readonly env = signal<string | null>(null);
  readonly isPreview = computed(() => this.env() === 'preview');
  readonly segmentSource = signal<string | null>(null);

  // external subtitle tracks (best per language) from /api/subs
  readonly subtitleTracks = signal<{ lang: string; label: string; src: string }[]>([]);

  // which cloudnestra front actually served the current stream (1=vidsrc, 2=vsembed)
  readonly activeServer = signal<number>(1);

  private hls: Hls | null = null;
  private attachedUrl: string | null = null;
  private loadToken = 0;
  private recoverAttempts = 0;
  // true once we've already escalated server 1 -> server 2, so we don't loop
  private escalated = false;
  private pendingResumeTime: number | null = null;
  private lastProgressSaveAt = 0;

  private static readonly UNAVAILABLE = 'This title isn’t available to stream right now';
  private static readonly PROGRESS_PREFIX = 'fiesta:playback-progress:';

  constructor() {
    // Attach the stream once both the resolved master URL and the <video> exist.
    effect(() => {
      const url = this.masterUrl();
      const ref = this.videoEl();
      if (url && ref) void this.attach(ref.nativeElement, url);
    });
  }

  ngOnChanges(_changes: SimpleChanges) {
    void this.loadStream();
  }

  ngOnDestroy() {
    this.destroyHls();
  }

  private async loadStream(srv?: 1 | 2, keepStarted = false) {
    const id = this.imdbId();
    if (!id) {
      this.masterUrl.set(null);
      return;
    }

    const token = ++this.loadToken;
    this.errorMsg.set(null);
    this.loading.set(true);
    this.segmentSource.set(null);
    this.subtitleTracks.set([]);
    if (!keepStarted) this.started.set(false);
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

    // Safari (and iOS) play HLS natively. Surface a friendly message if the
    // source can't be loaded (e.g. the upstream file is gone).
    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = master;
      this.restoreProgress(video);
      if (this.started()) void video.play().catch(() => {}); // resume after a mid-watch escalation
      video.addEventListener('error', () => this.failPlayback('native: media error'), { once: true });
      return;
    }

    const Hls = (await import('hls.js')).default;
    if (Hls.isSupported()) {
      const hls = new Hls({ enableWorker: true });
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
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR && this.recoverAttempts < 3) {
          this.recoverAttempts++;
          hls.startLoad();
        } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR && this.recoverAttempts < 3) {
          this.recoverAttempts++;
          hls.recoverMediaError();
        } else {
          this.failPlayback(data.details || 'playback error');
        }
      });
    } else {
      video.src = master; // last-resort fallback
      this.restoreProgress(video);
      video.addEventListener('error', () => this.failPlayback('unsupported: media error'), { once: true });
    }
  }

  private failPlayback(detail: string) {
    this.destroyHls();
    this.attachedUrl = null; // allow a retry to re-attach the same master

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
      this.subtitleTracks.set(Array.isArray(data?.tracks) ? data.tracks : []);
    } catch {
      if (token === this.loadToken) this.subtitleTracks.set([]);
    }
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

  onPlaybackPaused(video: HTMLVideoElement) {
    this.saveProgress(video);
  }

  onPlaybackEnded() {
    this.clearSavedProgress();
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
