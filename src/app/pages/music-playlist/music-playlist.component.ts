import { Component, computed, DestroyRef, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Meta, Title } from '@angular/platform-browser';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { catchError, EMPTY, firstValueFrom, switchMap, tap } from 'rxjs';
import { MusicLikeButtonComponent } from '../../components/music-like-button/music-like-button.component';
import { MusicSubnavComponent } from '../../components/music-subnav/music-subnav.component';
import { MusicTrackRowComponent } from '../../components/music-track-row/music-track-row.component';
import { NavbarComponent } from '../../components/navbar/navbar.component';
import { MusicDiscoveryService } from '../../services/music-discovery.service';
import { MusicLibraryService } from '../../services/music-library.service';
import { MusicPlayerService } from '../../services/music-player.service';
import { MusicRecommenderService } from '../../services/music-recommender.service';
import { MusicToastService } from '../../services/music-toast.service';
import { MusicUiService } from '../../services/music-ui.service';
import { MusicLibraryItem, MusicPlaylist, MusicTrack } from '../../services/music.service';
import { longDuration } from '../../utils/music-format';
import { shareMusicLink } from '../../utils/music-links';

/** TIDAL's page size for playlist items (the API default and ceiling used by the backend). */
export const PLAYLIST_PAGE_SIZE = 100;
/** Play / Shuffle / Save a copy load at most this many tracks. */
const LOAD_ALL_CAP = 1000;

/** Route /music/playlist/:id (a TIDAL playlist uuid). */
@Component({
  selector: 'app-music-playlist',
  imports: [NavbarComponent, RouterLink, MusicSubnavComponent, MusicTrackRowComponent, MusicLikeButtonComponent],
  templateUrl: './music-playlist.component.html',
})
export class MusicPlaylistComponent {
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private discovery = inject(MusicDiscoveryService);
  private recommender = inject(MusicRecommenderService);
  private title = inject(Title);
  private meta = inject(Meta);
  private library = inject(MusicLibraryService);
  private toast = inject(MusicToastService);
  private ui = inject(MusicUiService);
  protected readonly player = inject(MusicPlayerService);

  readonly playlist = signal<MusicPlaylist | null>(null);
  private readonly allTracks = signal<MusicTrack[]>([]);
  /** Source items fetched so far (includes ones filtered out as blocked), the next page's offset. */
  private readonly offset = signal(0);
  readonly total = signal(0);
  readonly status = signal<'loading' | 'done' | 'error' | 'missing'>('loading');
  readonly busy = signal(false);
  readonly saving = signal(false);
  readonly recs = signal<MusicTrack[]>([]);
  readonly recsStatus = signal<'idle' | 'loading' | 'done'>('idle');

  readonly tracks = computed(() => this.allTracks().filter((t) => !this.library.isBlocked(t)));
  readonly visibleRecs = computed(() => this.recs().filter((t) => !this.library.isBlocked(t)));
  readonly hasMore = computed(() => this.offset() < this.total());
  readonly item = computed<MusicLibraryItem | null>(() => {
    const p = this.playlist();
    return p ? { kind: 'playlist', data: p } : null;
  });
  readonly totalSeconds = computed(() => this.playlist()?.duration || this.tracks().reduce((n, t) => n + (t.duration || 0), 0));

  constructor() {
    this.title.setTitle('Playlist | Stream Fiesta');
    this.route.paramMap
      .pipe(
        tap(() => {
          this.status.set('loading');
          this.playlist.set(null);
          this.allTracks.set([]);
          this.offset.set(0);
          this.total.set(0);
          this.recs.set([]);
          this.recsStatus.set('idle');
        }),
        switchMap((p) =>
          this.discovery.playlist(p.get('id') ?? '', 0).pipe(
            tap((r) => {
              this.playlist.set(r.playlist);
              this.allTracks.set(r.tracks);
              this.total.set(r.total);
              this.offset.set(PLAYLIST_PAGE_SIZE);
              this.status.set('done');
              this.setMeta(r.playlist);
              if (r.playlist.title) this.library.recordActivity({ kind: 'playlist', data: r.playlist });
              void this.loadRecs();
            }),
            catchError((e: { status?: number }) => {
              this.status.set(e?.status === 404 || e?.status === 400 ? 'missing' : 'error');
              return EMPTY;
            }),
          ),
        ),
        takeUntilDestroyed(inject(DestroyRef)),
      )
      .subscribe();
  }

  private setMeta(p: MusicPlaylist): void {
    const name = p.title || 'Playlist';
    this.title.setTitle(`${name} | Stream Fiesta`);
    this.meta.updateTag({
      name: 'description',
      content: (p.description ? p.description.slice(0, 150) + ' ' : '') + `Listen to ${name} in lossless on Stream Fiesta.`,
    });
  }

  /** Appends the next page of 100. Returns false when there was nothing to add or it failed. */
  async loadMore(): Promise<boolean> {
    const p = this.playlist();
    if (!p || this.busy() || !this.hasMore()) return false;
    this.busy.set(true);
    try {
      const r = await firstValueFrom(this.discovery.playlist(p.uuid, this.offset()));
      const have = new Set(this.allTracks().map((t) => t.id));
      this.allTracks.update((list) => list.concat(r.tracks.filter((t) => !have.has(t.id))));
      this.offset.update((o) => o + PLAYLIST_PAGE_SIZE);
      this.total.set(r.total);
      return true;
    } catch {
      this.toast.show({ message: "Couldn't load more songs", tone: 'warn' });
      return false;
    } finally {
      this.busy.set(false);
    }
  }

  private async loadAll(): Promise<void> {
    while (this.hasMore() && this.offset() < LOAD_ALL_CAP) {
      if (!(await this.loadMore())) break;
    }
  }

  async loadRecs(): Promise<void> {
    this.recsStatus.set('loading');
    try {
      this.recs.set(await this.recommender.forPlaylist(this.tracks(), 10));
    } catch {
      this.recs.set([]);
    }
    this.recsStatus.set('done');
  }

  async playAll(): Promise<void> {
    const p = this.playlist();
    if (!p) return;
    await this.loadAll();
    const t = this.tracks();
    if (t.length) void this.player.play(t[0], t, { context: { type: 'playlist', id: p.uuid, label: p.title } });
  }

  async shuffleAll(): Promise<void> {
    const p = this.playlist();
    if (!p) return;
    await this.loadAll();
    const t = this.tracks();
    if (t.length) {
      void this.player.play(t[Math.floor(Math.random() * t.length)], t, { shuffle: true, context: { type: 'playlist', id: p.uuid, label: p.title } });
    }
  }

  /** Copies the playlist into the visitor's own library (all pages, up to the cap). */
  async saveCopy(): Promise<void> {
    const p = this.playlist();
    if (!p || this.saving()) return;
    this.saving.set(true);
    try {
      await this.loadAll();
      const t = this.tracks();
      if (!t.length) {
        this.toast.show({ message: 'There are no songs to copy', tone: 'warn' });
        return;
      }
      const copy = this.library.createPlaylist(p.title || 'Playlist', t, p.description);
      this.toast.show({
        message: `Saved ${t.length} songs to "${copy.name}"`,
        action: { label: 'Open', run: () => void this.router.navigate(['/music/library/playlist', copy.id]) },
      });
    } finally {
      this.saving.set(false);
    }
  }

  addToPlaylist(): void {
    const t = this.tracks();
    if (t.length) this.ui.openAddToPlaylist(t);
  }

  async share(): Promise<void> {
    const p = this.playlist();
    if (!p) return;
    const r = await shareMusicLink({ title: p.title, path: `/music/playlist/${p.uuid}` });
    if (r === 'copied') this.toast.show({ message: 'Link copied' });
    else if (r === 'failed') this.toast.show({ message: "Couldn't copy the link", tone: 'warn' });
  }

  protected duration(s: number): string {
    return longDuration(s);
  }
}
