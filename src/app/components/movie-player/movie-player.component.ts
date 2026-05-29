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

  // preview-only debug: show whether segments load direct vs via the proxy
  readonly env = signal<string | null>(null);
  readonly isPreview = computed(() => this.env() === 'preview');
  readonly segmentSource = signal<string | null>(null);

  // external subtitle tracks (best per language) from /api/subs
  readonly subtitleTracks = signal<{ lang: string; label: string; src: string }[]>([]);

  private hls: Hls | null = null;
  private attachedUrl: string | null = null;
  private loadToken = 0;
  private recoverAttempts = 0;

  private static readonly UNAVAILABLE = 'This title isn’t available to stream right now';

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

  private async loadStream() {
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
    this.started.set(false);
    this.recoverAttempts = 0;

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

      const res = await fetch(`/api/stream?${params.toString()}`);
      const data = await res.json().catch(() => ({}));
      if (token !== this.loadToken) return; // superseded by a newer load
      if (!res.ok) throw new Error(data?.error || `resolve failed (${res.status})`);
      if (!data?.master) throw new Error('no stream returned');

      this.env.set(data.env ?? null);
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
      video.addEventListener('error', () => this.failPlayback('native: media error'), { once: true });
      return;
    }

    const Hls = (await import('hls.js')).default;
    if (Hls.isSupported()) {
      const hls = new Hls({ enableWorker: true });
      this.hls = hls;
      hls.loadSource(master);
      hls.attachMedia(video);
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
      video.addEventListener('error', () => this.failPlayback('unsupported: media error'), { once: true });
    }
  }

  private failPlayback(detail: string) {
    this.destroyHls();
    this.attachedUrl = null; // allow a retry to re-attach the same master
    this.errorMsg.set(detail);
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
    this.started.set(true);
    void video.play().catch(() => {});
  }

  private destroyHls() {
    if (this.hls) {
      this.hls.destroy();
      this.hls = null;
    }
  }
}
