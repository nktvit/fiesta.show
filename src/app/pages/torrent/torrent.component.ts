import { Component, ElementRef, OnDestroy, OnInit, inject, signal, viewChild } from '@angular/core';
import { Title } from '@angular/platform-browser';
import { DecimalPipe } from '@angular/common';
import type Hls from 'hls.js';
import { NavbarComponent } from '../../components/navbar/navbar.component';

interface TorrentStatus {
  id: string;
  name: string;
  progress: number;
  downloadSpeed: number;
  numPeers: number;
  done: boolean;
  file: { name: string; path: string; length: number; progress: number; playableInBrowser: boolean } | null;
  stream: string | null;
  hls: string | null;
  play: 'direct' | 'hls' | null;
}

interface Level { index: number; label: string }

const STORAGE_KEY = 'fiesta.torrent.id';

/**
 * Test page for the torrent pipeline (preview / local only: /api/torrent answers 404 on production).
 * Drop a magnet link or a .torrent, watch it download on the Mac mini and play it while it is still arriving.
 */
@Component({
  selector: 'app-torrent',
  imports: [NavbarComponent, DecimalPipe],
  templateUrl: './torrent.component.html',
})
export class TorrentComponent implements OnInit, OnDestroy {
  private readonly title = inject(Title);
  readonly videoEl = viewChild<ElementRef<HTMLVideoElement>>('video');

  readonly magnet = signal('');
  readonly status = signal<TorrentStatus | null>(null);
  readonly error = signal('');
  readonly busy = signal(false);
  readonly unavailable = signal(false);
  readonly levels = signal<Level[]>([]);
  readonly chosenLevel = signal(-1); // -1 = auto
  readonly live = signal({ level: '', bufferAhead: 0, bandwidthMbps: 0, dropped: 0, state: 'idle' });

  private id = '';
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  private statsTimer: ReturnType<typeof setInterval> | undefined;
  private hls: Hls | null = null;
  private attached = '';
  private destroyed = false;
  /** Bumped on every add/remove so a poll that was in flight for the previous torrent is ignored. */
  private gen = 0;

  ngOnInit() {
    this.title.setTitle('Torrent player');
    let saved = '';
    try { saved = localStorage.getItem(STORAGE_KEY) || ''; } catch { /* private mode */ }
    if (/^[0-9a-f]{40}$/.test(saved)) {
      this.id = saved;
      void this.poll();
    }
    this.statsTimer = setInterval(() => this.sampleStats(), 1000);
  }

  ngOnDestroy() {
    this.destroyed = true;
    clearTimeout(this.pollTimer);
    clearInterval(this.statsTimer);
    this.hls?.destroy();
  }

  setMagnet(e: Event) { this.magnet.set((e.target as HTMLInputElement).value.trim()); }

  async addMagnet() {
    const m = this.magnet();
    if (!m.startsWith('magnet:?')) { this.error.set('That is not a magnet link (it must start with magnet:?)'); return; }
    await this.add({ magnet: m });
  }

  async addFile(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    const bytes = new Uint8Array(await file.arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    await this.add({ torrent: btoa(bin) });
    input.value = '';
  }

  private async add(body: object) {
    this.error.set('');
    this.busy.set(true);
    try {
      const r = await fetch('/api/torrent', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({}));
      if (r.status === 404) { this.unavailable.set(true); return; }
      if (!r.ok || !j.id) { this.error.set(j.error || `Could not add it (${r.status})`); return; }
      this.reset();
      this.id = j.id;
      try { localStorage.setItem(STORAGE_KEY, j.id); } catch { /* ignore */ }
      void this.poll();
    } catch (e) {
      this.error.set(String((e as Error)?.message || e));
    } finally {
      this.busy.set(false);
    }
  }

  async remove() {
    if (!this.id) return;
    const id = this.id;
    await fetch(`/api/torrent?id=${id}`, { method: 'DELETE' }).catch(() => {});
    this.reset();
    this.id = '';
    this.status.set(null);
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
  }

  private reset() {
    this.gen++;
    clearTimeout(this.pollTimer);
    this.hls?.destroy();
    this.hls = null;
    this.attached = '';
    this.levels.set([]);
    this.chosenLevel.set(-1);
    const v = this.videoEl()?.nativeElement;
    if (v) { v.removeAttribute('src'); v.load(); }
  }

  private async poll() {
    if (this.destroyed || !this.id) return;
    const gen = this.gen;
    try {
      const r = await fetch(`/api/torrent?id=${this.id}`, { cache: 'no-store' });
      if (gen !== this.gen) return; // replaced or removed while we waited
      if (r.status === 404) {
        const j = await r.json().catch(() => ({}));
        if (j.error === 'not_found') this.unavailable.set(true);
        else { this.status.set(null); this.error.set('The box no longer knows that torrent.'); this.id = ''; }
        return;
      }
      const j = await r.json();
      if (gen !== this.gen) return;
      if (!r.ok) throw new Error(j.error || `status ${r.status}`);
      this.status.set(j as TorrentStatus);
      this.error.set('');
      void this.attach(j as TorrentStatus);
    } catch (e) {
      this.error.set(String((e as Error)?.message || e));
    }
    if (gen !== this.gen) return;
    const s = this.status();
    this.pollTimer = setTimeout(() => void this.poll(), s?.done ? 5000 : 1500);
  }

  private async attach(s: TorrentStatus) {
    const url = s.play === 'hls' ? s.hls : s.play === 'direct' ? s.stream : null;
    const video = this.videoEl()?.nativeElement;
    if (!url || !video || this.attached) return; // attach once: the URL carries a 6 h token
    this.attached = url;
    if (s.play === 'direct') { video.src = url; return; }
    const { default: HlsCtor } = await import('hls.js');
    if (!HlsCtor.isSupported()) {
      // iPhone Safari without MSE: its native HLS player takes over.
      if (video.canPlayType('application/vnd.apple.mpegurl')) { video.src = url; return; }
      this.error.set('This browser cannot play HLS.');
      return;
    }
    const hls = new HlsCtor({ maxBufferLength: 30, startLevel: -1, startPosition: 0 });
    this.hls = hls;
    hls.on(HlsCtor.Events.MANIFEST_PARSED, () => {
      this.levels.set(hls.levels.map((l, index) => ({ index, label: `${l.height}p · ${(l.bitrate / 1e6).toFixed(1)} Mbit/s` })));
    });
    hls.on(HlsCtor.Events.ERROR, (_e, d) => { if (d.fatal) this.error.set(`Playback error: ${d.details}`); });
    hls.loadSource(url);
    hls.attachMedia(video);
  }

  chooseLevel(e: Event) {
    const i = +(e.target as HTMLSelectElement).value;
    this.chosenLevel.set(i);
    if (this.hls) this.hls.currentLevel = i; // -1 = auto
  }

  private sampleStats() {
    const v = this.videoEl()?.nativeElement;
    if (!v) return;
    let ahead = 0;
    for (let i = 0; i < v.buffered.length; i++) {
      if (v.currentTime >= v.buffered.start(i) && v.currentTime <= v.buffered.end(i)) ahead = v.buffered.end(i) - v.currentTime;
    }
    const lvl = this.hls?.levels[this.hls.currentLevel];
    const q = (v as HTMLVideoElement).getVideoPlaybackQuality?.();
    this.live.set({
      level: lvl ? `${lvl.height}p` : v.videoHeight ? `${v.videoHeight}p` : '',
      bufferAhead: Math.round(ahead * 10) / 10,
      bandwidthMbps: this.hls ? Math.round((this.hls.bandwidthEstimate / 1e6) * 10) / 10 : 0,
      dropped: q?.droppedVideoFrames ?? 0,
      state: v.error ? 'error' : v.seeking ? 'seeking' : v.readyState < 3 && !v.paused ? 'buffering' : v.paused ? 'paused' : 'playing',
    });
  }

  mb(bytes: number) { return bytes / 1048576; }
}
