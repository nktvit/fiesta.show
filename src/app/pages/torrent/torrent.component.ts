import { Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { Title } from '@angular/platform-browser';
import { DecimalPipe } from '@angular/common';
import { NavbarComponent } from '../../components/navbar/navbar.component';
import { MoviePlayerComponent } from '../../components/movie-player/movie-player.component';

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
  encode?: EncodeInfo['state'];
  encodeInfo?: EncodeInfo;
  subtitles?: { lang: string; title: string; src: string }[];
}

interface EncodeInfo {
  state: 'none' | 'queued' | 'running' | 'paused' | 'done' | 'failed';
  priority?: 'watch' | 'background';
  encodedSeconds?: number;
  duration?: number;
  speed?: number;
  slow?: boolean;
}

interface LibraryItem {
  id: string;
  name: string;
  progress: number;
  downloadSpeed: number;
  numPeers: number;
  done: boolean;
  encode: EncodeInfo['state'];
  encodeInfo?: EncodeInfo;
  play: 'direct' | 'hls' | null;
  file: { name: string; path: string; length: number } | null;
}

const STORAGE_KEY = 'fiesta.torrent.id';

/**
 * Test page for the torrent pipeline (preview / local only: /api/torrent answers 404 on production).
 * Drop a magnet link or a .torrent, watch it download on the Mac mini and play it while it is still arriving.
 */
@Component({
  selector: 'app-torrent',
  imports: [NavbarComponent, DecimalPipe, MoviePlayerComponent],
  templateUrl: './torrent.component.html',
})
export class TorrentComponent implements OnInit, OnDestroy {
  private readonly title = inject(Title);

  readonly magnet = signal('');
  readonly status = signal<TorrentStatus | null>(null);
  readonly error = signal('');
  readonly busy = signal(false);
  readonly unavailable = signal(false);
  readonly library = signal<LibraryItem[]>([]);
  readonly currentId = signal('');
  /** What the shared player plays. Set once per torrent: the URL carries a 6 h token and a new one would restart playback. */
  readonly source = signal('');
  readonly sourceIsFile = signal(false);
  /** The movie's own text subtitle tracks (a remux brings them); the site's subtitle lookup stays the fallback inside the player. */
  readonly subtitles = computed(() => (this.status()?.subtitles ?? []).map((x) => ({ lang: x.lang, label: x.title || x.lang, src: x.src })));

  private id = '';
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  private libTimer: ReturnType<typeof setInterval> | undefined;
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
    this.currentId.set(this.id);
    void this.loadLibrary();
    this.libTimer = setInterval(() => void this.loadLibrary(), 4000);
  }

  ngOnDestroy() {
    this.destroyed = true;
    clearTimeout(this.pollTimer);
    clearInterval(this.libTimer);
  }

  async loadLibrary() {
    try {
      const r = await fetch('/api/torrent', { cache: 'no-store' });
      if (r.status === 404 && (await r.json().catch(() => ({}))).error === 'not_found') { this.unavailable.set(true); return; }
      if (!r.ok) return;
      const list = (await r.json()) as LibraryItem[];
      if (Array.isArray(list)) this.library.set(list);
    } catch { /* the next tick tries again */ }
  }

  /** Switch the player to a torrent from the library. */
  open(id: string) {
    if (id === this.id) return;
    this.reset();
    this.id = id;
    this.currentId.set(id);
    this.status.set(null);
    this.error.set('');
    try { localStorage.setItem(STORAGE_KEY, id); } catch { /* ignore */ }
    void this.poll();
  }

  async removeItem(id: string, e: Event) {
    e.stopPropagation();
    if (id === this.id) { await this.remove(); } else { await fetch(`/api/torrent?id=${id}`, { method: 'DELETE' }).catch(() => {}); }
    await this.loadLibrary();
  }

  /** One line about what the encoder is doing for this movie. */
  encodeLabel(i: { play: string | null; done: boolean; encode?: EncodeInfo['state']; encodeInfo?: EncodeInfo; downloadSpeed?: number; numPeers?: number }) {
    if (i.play === 'direct') return 'plays as is';
    const e = i.encodeInfo;
    const min = (sec = 0) => `${Math.floor(sec / 60)}`;
    switch (i.encode) {
      case 'done': return 'encoded';
      case 'failed': return 'encode failed';
      case 'queued': return 'queued for encoding';
      case 'paused': return `paused while someone is watching · ${min(e?.encodedSeconds)}/${min(e?.duration)} min`;
      case 'running': return `encoding ${min(e?.encodedSeconds)}/${min(e?.duration)} min${e?.speed ? ` · ${e.speed.toFixed(1)}× playback` : ''}${e?.slow ? ' · SLOWER than playback' : ''}`;
      default: return i.done ? 'not encoded yet' : !i.numPeers && !i.downloadSpeed ? 'checking files on disk…' : 'downloading';
    }
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
    void this.loadLibrary();
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
      this.currentId.set(j.id);
      try { localStorage.setItem(STORAGE_KEY, j.id); } catch { /* ignore */ }
      void this.poll();
      void this.loadLibrary();
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
    this.currentId.set('');
    this.status.set(null);
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
  }

  private reset() {
    this.gen++;
    clearTimeout(this.pollTimer);
    this.source.set('');
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
      this.pickSource(j as TorrentStatus);
    } catch (e) {
      this.error.set(String((e as Error)?.message || e));
    }
    if (gen !== this.gen) return;
    const s = this.status();
    this.pollTimer = setTimeout(() => void this.poll(), s?.done ? 5000 : 1500);
  }

  private pickSource(s: TorrentStatus) {
    if (this.source()) return;
    const url = s.play === 'hls' ? s.hls : s.play === 'direct' ? s.stream : null;
    if (!url) return;
    this.sourceIsFile.set(s.play === 'direct');
    this.source.set(url);
  }

  gb(bytes: number) { return bytes / 1073741824; }

  mb(bytes: number) { return bytes / 1048576; }
}
