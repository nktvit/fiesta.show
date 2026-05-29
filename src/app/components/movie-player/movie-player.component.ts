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
  // kept for parent compatibility (query-param persistence); single clean source now
  readonly server = input<number>(0);
  readonly serverChange = output<number>();

  readonly videoEl = viewChild<ElementRef<HTMLVideoElement>>('videoEl');

  readonly loading = signal(false);
  readonly errorMsg = signal<string | null>(null);
  readonly masterUrl = signal<string | null>(null);

  // preview-only debug: show whether segments load direct vs via the proxy
  readonly env = signal<string | null>(null);
  readonly isPreview = computed(() => this.env() === 'preview');
  readonly segmentSource = signal<string | null>(null);

  private hls: Hls | null = null;
  private attachedUrl: string | null = null;
  private loadToken = 0;

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

    // Safari (and iOS) play HLS natively.
    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = master;
      return;
    }

    const Hls = (await import('hls.js')).default;
    if (Hls.isSupported()) {
      const hls = new Hls({ enableWorker: true });
      this.hls = hls;
      hls.loadSource(master);
      hls.attachMedia(video);
      hls.on(Hls.Events.ERROR, (_evt, data) => {
        if (data.fatal) this.errorMsg.set(`playback error: ${data.details}`);
      });
    } else {
      video.src = master; // last-resort fallback
    }
  }

  // Preview debug: fetch one real segment and read the X-Fiesta-Source header the
  // worker stamps, to confirm whether segments load direct or via the proxy.
  private async probeSegmentSource(master: string, token: number) {
    try {
      const firstUri = (text: string) =>
        text.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#'));
      const masterTxt = await (await fetch(master)).text();
      const variant = firstUri(masterTxt);
      if (!variant) return;
      const mediaTxt = await (await fetch(variant)).text();
      const seg = firstUri(mediaTxt);
      if (!seg) return;
      const r = await fetch(seg, { headers: { Range: 'bytes=0-0' } });
      if (token !== this.loadToken) return;
      this.segmentSource.set(r.headers.get('X-Fiesta-Source'));
    } catch {}
  }

  private destroyHls() {
    if (this.hls) {
      this.hls.destroy();
      this.hls = null;
    }
  }
}
