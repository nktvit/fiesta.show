import { computed, inject, Injectable, Signal, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { audioKind, fetchAudio } from '../utils/music-download-fetch';
import { defaultDownloadPrefs, DownloadQuality, MusicDownloadPrefs, sanitizeDownloadPrefs } from '../utils/music-download-prefs';
import { buildSidecars, sidecarNameFor } from '../utils/music-download-sidecars';
import { flatName, formatDownloadName, nameDataFor, safeName, uniqueName } from '../utils/music-download-template';
import { rememberedFolder, saveBlob, streamToFolder, writeToFolder, ZipEntry, zipResponse } from '../utils/music-download-writer';
import { remuxFlac } from '../utils/music-flac-remux';
import { FlacBlock, FlacTags, pictureBlock, rebuildFlacWithBlocks, vorbisCommentBlock } from '../utils/music-flac-tags';
import { proxiedImage, tidalImage } from '../utils/music-format';
import { toLRC, toTTML } from '../utils/music-lyrics-lrc';
import { concatBytes } from '../utils/music-mp4-boxes';
import { Mp4Tags, tagMp4 } from '../utils/music-mp4-tags';
import { MusicLibraryService } from './music-library.service';
import { MusicLyrics, MusicLyricsService } from './music-lyrics.service';
import { MusicSettingsService } from './music-settings.service';
import { MusicToastService } from './music-toast.service';
import { MusicAlbum, MusicQuality, MusicService, MusicTrack } from './music.service';

/**
 * The single switch for public downloads. The owner decided downloads ship
 * DEFAULT OFF: with false every download entry point (menus, buttons, settings
 * section, tray) hides itself. Flip to true to turn the feature on.
 */
export const MUSIC_DOWNLOADS_ENABLED = false;

export type MusicDownloadKind = 'track' | 'album' | 'playlist' | 'liked' | 'queue' | 'selection' | 'discography';

export interface MusicDownloadTask {
  id: string;
  /** What the tray shows ("Discovery", "Liked songs"). */
  name: string;
  kind: MusicDownloadKind;
  status: 'queued' | 'running' | 'done' | 'error' | 'cancelled';
  /** Tracks finished / total. */
  done: number;
  total: number;
  /** 0..1 overall. */
  progress: number;
  error?: string;
  /** The saved file name once done ("Daft Punk - One More Time.flac"). */
  fileName?: string;
  /** Short note: "30 s preview", "2 of 12 failed". */
  detail?: string;
}

/** Shown in a confirm dialog before an artist's albums are queued. */
export interface MusicArtistDownloadRequest {
  artistId: number;
  name: string;
  albums: MusicAlbum[];
}

interface Job {
  run: (ctx: JobContext) => Promise<void>;
  controller: AbortController;
}

interface JobContext {
  id: string;
  signal: AbortSignal;
  progress: (fraction: number, done?: number) => void;
  finish: (fileName: string, detail?: string) => void;
  setTotal: (total: number) => void;
}

interface CoverBytes {
  mime: string;
  data: Uint8Array;
}

type CoverCache = Map<string, Promise<CoverBytes | null>>;

interface Prepared {
  parts: Uint8Array[];
  ext: 'flac' | 'm4a';
  mime: string;
  preview: boolean;
  lyrics: MusicLyrics | null;
}

interface PrepareOpts {
  signal: AbortSignal;
  prefs: MusicDownloadPrefs;
  album?: MusicAlbum | null;
  position?: number;
  trackCount?: number;
  /** Fetch lyrics (tags and/or a sidecar). */
  wantLyrics: boolean;
  covers: CoverCache;
  onProgress: (fraction: number) => void;
}

const LYRICS_TIMEOUT_MS = 8000;
const abortError = () => new DOMException('aborted', 'AbortError');
const isAbort = (e: unknown) => (e as { name?: string } | null)?.name === 'AbortError';

/** Track and bulk (ZIP) downloads, with a queue the tray shows. Owned by package P12. */
@Injectable({ providedIn: 'root' })
export class MusicDownloadService {
  private readonly toast = inject(MusicToastService);
  private readonly api = inject(MusicService);
  private readonly lyricsApi = inject(MusicLyricsService);
  private readonly library = inject(MusicLibraryService);
  private readonly settings = inject(MusicSettingsService);

  private readonly _tasks = signal<MusicDownloadTask[]>([]);
  private readonly jobs = new Map<string, Job>();
  private readonly switchOn = signal<boolean>(MUSIC_DOWNLOADS_ENABLED);
  private running = false;
  private seq = 0;

  /** MUSIC_DOWNLOADS_ENABLED and the browser can save files. Every entry point hides when false. */
  readonly enabled: Signal<boolean> = computed(() => this.switchOn() && typeof Blob !== 'undefined');
  readonly tasks = this._tasks.asReadonly();
  /** Persisted preferences at `fiesta:music:downloads`; read validated with `currentPrefs()`. */
  readonly prefs = this.settings.scoped<MusicDownloadPrefs>('downloads', defaultDownloadPrefs());
  /** Set while the "download N albums?" dialog is open. */
  readonly artistRequest = signal<MusicArtistDownloadRequest | null>(null);

  currentPrefs(): MusicDownloadPrefs {
    return sanitizeDownloadPrefs(this.prefs());
  }

  setPrefs(patch: Partial<Omit<MusicDownloadPrefs, 'sidecars'>> & { sidecars?: Partial<MusicDownloadPrefs['sidecars']> }): void {
    const cur = this.currentPrefs();
    this.prefs.set({ ...cur, ...patch, sidecars: { ...cur.sidecars, ...patch.sidecars } });
  }

  /** One track as a single file. */
  async downloadTrack(track: MusicTrack): Promise<void> {
    if (!this.enabled()) return;
    this.enqueue({ name: track.title || 'Track', kind: 'track', total: 1 }, (ctx) => this.runSingle(track, ctx));
  }

  async downloadTracks(
    tracks: MusicTrack[],
    opts?: { name?: string; album?: MusicAlbum; kind?: 'album' | 'playlist' | 'liked' | 'queue' | 'selection' | 'discography' },
  ): Promise<void> {
    if (!this.enabled()) return;
    const list = tracks.filter((t) => !this.library.isBlocked(t));
    if (!list.length) {
      this.toast.show({ message: 'Nothing to download', tone: 'warn' });
      return;
    }
    if (list.length === 1 && !opts?.kind) return this.downloadTrack(list[0]);
    const name = opts?.name || opts?.album?.title || 'Downloads';
    this.enqueue({ name, kind: opts?.kind ?? 'selection', total: list.length }, (ctx) => this.runBulk(list, name, opts?.album ?? null, ctx));
  }

  async downloadAlbum(album: MusicAlbum, tracks: MusicTrack[]): Promise<void> {
    return this.downloadTracks(tracks, { name: album.title, album, kind: 'album' });
  }

  /** Looks up the artist's albums and asks to confirm; `confirmArtist()` queues one ZIP per album. */
  async downloadArtist(artistId: number): Promise<void> {
    if (!this.enabled()) return;
    try {
      const res = await firstValueFrom(this.api.artist(artistId));
      const seen = new Set<number>();
      const albums = (res.albums ?? []).filter((a) => {
        if (seen.has(a.id) || this.library.isBlocked({ kind: 'album', data: a })) return false;
        seen.add(a.id);
        return true;
      });
      if (!albums.length) {
        this.toast.show({ message: 'No albums to download', tone: 'warn' });
        return;
      }
      this.artistRequest.set({ artistId, name: res.artist.name, albums });
    } catch {
      this.toast.show({ message: 'Could not load the artist', tone: 'warn' });
    }
  }

  confirmArtist(): void {
    const req = this.artistRequest();
    this.artistRequest.set(null);
    if (!req || !this.enabled()) return;
    for (const album of req.albums) {
      this.enqueue({ name: `${album.artist || req.name} - ${album.title}`, kind: 'discography', total: Math.max(1, album.tracks || 1) }, async (ctx) => {
        const res = await firstValueFrom(this.api.album(album.id));
        if (ctx.signal.aborted) throw abortError();
        const tracks = res.tracks.filter((t) => !this.library.isBlocked(t));
        if (!tracks.length) throw new Error('No tracks to download');
        ctx.setTotal(tracks.length);
        await this.runBulk(tracks, `${res.album.artist} - ${res.album.title}`, res.album, ctx);
      });
    }
  }

  cancelArtist(): void {
    this.artistRequest.set(null);
  }

  cancel(id: string): void {
    this.jobs.get(id)?.controller.abort();
    this.patch(id, (t) => (t.status === 'queued' || t.status === 'running' ? { ...t, status: 'cancelled' } : t));
  }

  retry(id: string): void {
    const job = this.jobs.get(id);
    const t = this._tasks().find((x) => x.id === id);
    if (!job || !t || (t.status !== 'error' && t.status !== 'cancelled')) return;
    job.controller = new AbortController();
    this.patch(id, (x) => ({ ...x, status: 'queued', done: 0, progress: 0, error: undefined, detail: undefined, fileName: undefined }));
    void this.pump();
  }

  dismiss(id: string): void {
    this.cancel(id);
    this.jobs.delete(id);
    this._tasks.update((l) => l.filter((x) => x.id !== id));
  }

  clearFinished(): void {
    for (const t of this._tasks()) if (t.status === 'done' || t.status === 'cancelled') this.jobs.delete(t.id);
    this._tasks.update((l) => l.filter((t) => t.status === 'queued' || t.status === 'running' || t.status === 'error'));
  }

  // ── queue ────────────────────────────────────────────────────────────────

  private enqueue(meta: { name: string; kind: MusicDownloadKind; total: number }, run: Job['run']): string {
    const id = `dl-${Date.now().toString(36)}-${++this.seq}`;
    this.jobs.set(id, { run, controller: new AbortController() });
    this._tasks.update((l) => [...l, { id, name: meta.name, kind: meta.kind, status: 'queued', done: 0, total: meta.total, progress: 0 }]);
    void this.pump();
    return id;
  }

  private patch(id: string, fn: (t: MusicDownloadTask) => MusicDownloadTask): void {
    this._tasks.update((l) => l.map((t) => (t.id === id ? fn(t) : t)));
  }

  /** Runs queued tasks one at a time. */
  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (;;) {
        const next = this._tasks().find((t) => t.status === 'queued');
        const job = next && this.jobs.get(next.id);
        if (!next || !job) break;
        const id = next.id;
        const signal = job.controller.signal;
        this.patch(id, (t) => ({ ...t, status: 'running' }));
        const ctx: JobContext = {
          id,
          signal,
          progress: (fraction, done) =>
            this.patch(id, (t) => (t.status === 'running' ? { ...t, progress: Math.min(1, Math.max(0, fraction)), done: done ?? t.done } : t)),
          finish: (fileName, detail) => {
            this.patch(id, (t) => (t.status === 'running' ? { ...t, status: 'done', progress: 1, done: t.total, fileName, detail } : t));
            this.toast.show({ message: `Saved ${fileName}` });
          },
          setTotal: (total) => this.patch(id, (t) => ({ ...t, total })),
        };
        try {
          await job.run(ctx);
        } catch (e) {
          const aborted = signal.aborted || isAbort(e);
          this.patch(id, (t) => (aborted ? { ...t, status: 'cancelled' } : { ...t, status: 'error', error: errorText(e) }));
          if (!aborted) this.toast.show({ message: `Download failed: ${next.name}`, tone: 'warn' });
        }
      }
    } finally {
      this.running = false;
    }
  }

  // ── one track ────────────────────────────────────────────────────────────

  private async runSingle(track: MusicTrack, ctx: JobContext): Promise<void> {
    const prefs = this.currentPrefs();
    const dir = prefs.saveToFolder ? await rememberedFolder(true) : null;
    const prepared = await this.prepare(track, {
      signal: ctx.signal,
      prefs,
      wantLyrics: prefs.embedLyrics || (!!dir && prefs.lyricsSidecar !== 'off'),
      covers: new Map(),
      onProgress: (f) => ctx.progress(f * 0.97),
    });
    if (ctx.signal.aborted) throw abortError();
    const path = formatDownloadName(prefs.trackTemplate, nameDataFor(track)) + '.' + prepared.ext;
    const fileName = flatName(path);
    if (dir) {
      await writeToFolder(dir, path, prepared.parts as BlobPart[]);
      const side = this.lyricsSidecar(prepared.lyrics, track, prefs);
      if (side) await writeToFolder(dir, sidecarNameFor(path, side.ext), [side.text]);
    } else {
      saveBlob(fileName, blobOf(prepared.parts, prepared.mime));
    }
    if (prepared.preview) this.toast.show({ message: `${track.title}: only a 30 second preview was available`, tone: 'warn' });
    ctx.finish(fileName, prepared.preview ? '30 s preview' : undefined);
  }

  /** Fetches audio, cover and lyrics for one track and produces the tagged file. */
  private async prepare(track: MusicTrack, o: PrepareOpts): Promise<Prepared> {
    const manifest = await firstValueFrom(this.api.manifest(track.id, qualityFor(o.prefs.quality)));
    if (o.signal.aborted) throw abortError();
    const coverP = o.prefs.embedCover ? cachedCover(o.covers, tidalImage(track.cover, 640)) : Promise.resolve(null);
    const lyricsP = o.wantLyrics ? this.fetchLyrics(track, o.signal) : Promise.resolve(null);
    const audio = await fetchAudio(manifest, { signal: o.signal, onProgress: o.onProgress });
    const [cover, lyrics] = await Promise.all([coverP, lyricsP]);
    if (o.signal.aborted) throw abortError();

    const tags = tagsFor(track, o.album ?? null, o.position, o.trackCount);
    const lyricText = o.prefs.embedLyrics && lyrics?.lines.length ? toLRC(lyrics.lines) : '';
    const kind = audioKind(audio.codec, audio.mime);
    let parts: Uint8Array[];
    let mime = 'audio/mp4';
    if (kind === 'flac') {
      mime = 'audio/flac';
      const extra: FlacBlock[] = [vorbisCommentBlock(flacTags(tags, lyricText))];
      if (cover) extra.push(pictureBlock(cover.mime, cover.data));
      if (audio.kind === 'segments') parts = remuxFlac(audio.init, audio.parts, extra);
      else parts = rebuildFlacWithBlocks(audio.parts[0], extra) ?? audio.parts;
    } else {
      const bytes = audio.kind === 'segments' ? concatBytes([audio.init, ...audio.parts]) : audio.parts[0];
      parts = tagMp4(bytes, { ...mp4Tags(tags, lyricText), cover: cover ?? undefined }) ?? [bytes];
    }
    return { parts, ext: kind, mime, preview: manifest.presentation === 'PREVIEW', lyrics };
  }

  private async fetchLyrics(track: MusicTrack, signal: AbortSignal): Promise<MusicLyrics | null> {
    const timer = new AbortController();
    const t = setTimeout(() => timer.abort(), LYRICS_TIMEOUT_MS);
    const onAbort = () => timer.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      return await Promise.race([
        this.lyricsApi.fetch(track, { signal: timer.signal }),
        new Promise<null>((resolve) => timer.signal.addEventListener('abort', () => resolve(null), { once: true })),
      ]);
    } catch {
      return null;
    } finally {
      clearTimeout(t);
      signal.removeEventListener('abort', onAbort);
    }
  }

  private lyricsSidecar(lyrics: MusicLyrics | null, track: MusicTrack, prefs: MusicDownloadPrefs): { ext: 'lrc' | 'ttml'; text: string } | null {
    if (!lyrics?.lines.length || prefs.lyricsSidecar === 'off') return null;
    if (prefs.lyricsSidecar === 'ttml') return { ext: 'ttml', text: toTTML(lyrics.lines, { songwriters: lyrics.songwriters }) };
    return { ext: 'lrc', text: toLRC(lyrics.lines, { ti: track.title, ar: track.artist, al: track.album }) };
  }

  // ── many tracks ──────────────────────────────────────────────────────────

  private async runBulk(tracks: MusicTrack[], name: string, album: MusicAlbum | null, ctx: JobContext): Promise<void> {
    const prefs = this.currentPrefs();
    const total = tracks.length;
    const width = Math.max(2, String(total).length);
    const covers: CoverCache = new Map();
    const used = new Set<string>();
    const paths: string[] = new Array<string>(total).fill('');
    const failed: string[] = [];
    const base = safeName(album ? `${album.artist} - ${album.title}` : name, 'Downloads');
    const meta = { title: album?.title ?? name, creator: album?.artist, cover: album?.cover ?? tracks[0]?.cover };
    const wantLyrics = prefs.embedLyrics || prefs.lyricsSidecar !== 'off';
    const files = prefs.bulkMode === 'files';
    const dir = prefs.saveToFolder ? await rememberedFolder(true) : null;
    let preview = false;

    const entries = async function* (self: MusicDownloadService): AsyncGenerator<ZipEntry> {
      for (let i = 0; i < total; i++) {
        if (ctx.signal.aborted) throw abortError();
        const t = tracks[i];
        try {
          const p = await self.prepare(t, {
            signal: ctx.signal, prefs, album, position: i + 1, trackCount: total, wantLyrics, covers,
            onProgress: (f) => ctx.progress((i + f * 0.95) / total, i),
          });
          preview ||= p.preview;
          const path = uniqueName(formatDownloadName(prefs.bulkTemplate, nameDataFor(t, album, i + 1), width) + '.' + p.ext, used);
          paths[i] = path;
          yield { name: path, input: blobOf(p.parts, p.mime) };
          const side = self.lyricsSidecar(p.lyrics, t, prefs);
          if (side) yield { name: uniqueName(sidecarNameFor(path, side.ext), used), input: side.text };
        } catch (e) {
          if (ctx.signal.aborted || isAbort(e)) throw e;
          failed.push(t.title);
        }
        ctx.progress((i + 1) / total, i + 1);
      }
      if (failed.length === total) throw new Error('No track could be downloaded');
      const cover = prefs.sidecars.cover && meta.cover ? await cachedCover(covers, tidalImage(meta.cover, 640)) : null;
      if (cover) yield { name: uniqueName('cover.jpg', used), input: cover.data };
      for (const s of buildSidecars(prefs.sidecars, meta, tracks, paths, album)) yield { name: uniqueName(s.name, used), input: s.text };
    };

    const detail = () => [preview ? '30 s preview' : '', failed.length ? `${failed.length} of ${total} failed` : ''].filter(Boolean).join(', ') || undefined;
    if (!files) {
      const zipName = `${base}.zip`;
      const res = await zipResponse(entries(this));
      if (dir && res.body) {
        await streamToFolder(dir, zipName, res.body);
      } else {
        const blob = await res.blob();
        if (ctx.signal.aborted) throw abortError();
        saveBlob(zipName, blob);
      }
      ctx.finish(zipName, detail());
    } else {
      for await (const e of entries(this)) {
        const blob = e.input instanceof Blob ? e.input : new Blob([e.input as BlobPart]);
        if (dir) await writeToFolder(dir, `${base}/${e.name}`, [blob]);
        else saveBlob(flatName(e.name), blob);
      }
      ctx.finish(dir ? `${dir.name}/${base}` : `${used.size} files`, detail());
    }
    if (failed.length) this.toast.show({ message: `${name}: ${failed.length} track${failed.length === 1 ? '' : 's'} could not be downloaded`, tone: 'warn' });
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** Blob from byte parts (TS types Uint8Array<ArrayBufferLike> too wide for BlobPart). */
function blobOf(parts: Uint8Array[], type: string): Blob {
  return new Blob(parts as BlobPart[], { type });
}

function errorText(e: unknown): string {
  const status = (e as { status?: number } | null)?.status;
  if (typeof status === 'number' && status > 0) return status === 401 ? 'TIDAL session expired' : `Server error ${status}`;
  return e instanceof Error && e.message ? e.message : 'Download failed';
}

function qualityFor(q: DownloadQuality): MusicQuality {
  return q === 'LOW' ? 'LOW' : q === 'HIGH' ? 'HIGH' : 'LOSSLESS';
}

function cachedCover(cache: CoverCache, url: string): Promise<CoverBytes | null> {
  if (!url) return Promise.resolve(null);
  let p = cache.get(url);
  if (!p) {
    p = (async () => {
      try {
        const r = await fetch(proxiedImage(url));
        if (!r.ok) return null;
        const mime = (r.headers.get('content-type') || 'image/jpeg').split(';')[0];
        return /^image\//.test(mime) ? { mime, data: new Uint8Array(await r.arrayBuffer()) } : null;
      } catch {
        return null;
      }
    })();
    cache.set(url, p);
  }
  return p;
}

interface TagSet {
  title: string;
  artists: string[];
  album: string;
  albumArtist: string;
  trackNumber: number;
  trackTotal: number;
  date: string;
  isrc: string;
  copyright: string;
}

function tagsFor(t: MusicTrack, album: MusicAlbum | null, position?: number, count?: number): TagSet {
  const artists = t.artists?.length ? t.artists.map((a) => a.name) : t.artist ? [t.artist] : [];
  return {
    title: t.version ? `${t.title} (${t.version})` : t.title,
    artists,
    album: t.album || album?.title || '',
    albumArtist: album?.artist || artists[0] || '',
    trackNumber: t.trackNumber || position || 0,
    trackTotal: album?.tracks || count || 0,
    date: t.releaseDate || album?.releaseDate || album?.year || '',
    isrc: t.isrc || '',
    copyright: t.copyright || album?.copyright || '',
  };
}

function flacTags(t: TagSet, lyrics: string): FlacTags {
  return {
    TITLE: t.title,
    ARTIST: t.artists,
    ALBUM: t.album,
    ALBUMARTIST: t.albumArtist,
    TRACKNUMBER: t.trackNumber ? String(t.trackNumber) : undefined,
    TRACKTOTAL: t.trackTotal ? String(t.trackTotal) : undefined,
    DATE: t.date,
    ISRC: t.isrc,
    COPYRIGHT: t.copyright,
    LYRICS: lyrics,
  };
}

function mp4Tags(t: TagSet, lyrics: string): Mp4Tags {
  return {
    title: t.title,
    artist: t.artists.join(', '),
    album: t.album,
    albumArtist: t.albumArtist,
    trackNumber: t.trackNumber,
    trackTotal: t.trackTotal,
    date: t.date,
    copyright: t.copyright,
    isrc: t.isrc,
    lyrics,
  };
}
