import { Component, computed, DestroyRef, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Meta, Title } from '@angular/platform-browser';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { catchError, EMPTY, merge, switchMap, tap } from 'rxjs';
import { MusicAlbumCardComponent } from '../../components/music-album-card/music-album-card.component';
import { MusicArtistCardComponent } from '../../components/music-artist-card/music-artist-card.component';
import { MusicLikeButtonComponent } from '../../components/music-like-button/music-like-button.component';
import { MusicRailComponent } from '../../components/music-rail/music-rail.component';
import { MusicSubnavComponent } from '../../components/music-subnav/music-subnav.component';
import { MusicTrackRowComponent } from '../../components/music-track-row/music-track-row.component';
import { NavbarComponent } from '../../components/navbar/navbar.component';
import { MusicAlbumExtras, MusicAotyScore, MusicCatalogService } from '../../services/music-catalog.service';
import { MusicDownloadService } from '../../services/music-download.service';
import { MusicLibraryService } from '../../services/music-library.service';
import { MusicPlayerService } from '../../services/music-player.service';
import { MusicSettingsService } from '../../services/music-settings.service';
import { MusicToastService } from '../../services/music-toast.service';
import { MusicUiService } from '../../services/music-ui.service';
import { MusicAlbum, MusicLibraryItem, MusicService, MusicTrack } from '../../services/music.service';
import { coverColor } from '../../utils/music-color';
import { longDuration } from '../../utils/music-format';
import { shareMusicLink } from '../../utils/music-links';

const NO_EXTRAS: MusicAlbumExtras = { moreByArtist: [], epsSingles: [], similarAlbums: [], similarArtists: [], copyright: '', releaseDate: '' };

/** /music/album/:id */
@Component({
  selector: 'app-music-album',
  imports: [
    NavbarComponent, RouterLink, MusicTrackRowComponent, MusicSubnavComponent, MusicRailComponent, MusicAlbumCardComponent,
    MusicArtistCardComponent, MusicLikeButtonComponent,
  ],
  templateUrl: './music-album.component.html',
})
export class MusicAlbumComponent {
  private route = inject(ActivatedRoute);
  private music = inject(MusicService);
  private catalog = inject(MusicCatalogService);
  private title = inject(Title);
  private meta = inject(Meta);
  private toast = inject(MusicToastService);
  private ui = inject(MusicUiService);
  private library = inject(MusicLibraryService);
  protected readonly player = inject(MusicPlayerService);
  protected readonly settings = inject(MusicSettingsService);
  protected readonly download = inject(MusicDownloadService);

  readonly album = signal<MusicAlbum | null>(null);
  private readonly allTracks = signal<MusicTrack[]>([]);
  readonly extras = signal<MusicAlbumExtras>(NO_EXTRAS);
  readonly aoty = signal<MusicAotyScore | null>(null);
  readonly tint = signal<string | null>(null);
  readonly status = signal<'loading' | 'done' | 'error'>('loading');

  readonly tracks = computed(() => this.allTracks().filter((t) => !this.library.isBlocked(t)));
  readonly item = computed<MusicLibraryItem | null>(() => {
    const a = this.album();
    return a ? { kind: 'album', data: a } : null;
  });
  readonly moreByArtist = computed(() => this.extras().moreByArtist.filter((a) => !this.library.isBlocked({ kind: 'album', data: a })));
  readonly epsSingles = computed(() => this.extras().epsSingles.filter((a) => !this.library.isBlocked({ kind: 'album', data: a })));
  readonly similarAlbums = computed(() => this.extras().similarAlbums.filter((a) => !this.library.isBlocked({ kind: 'album', data: a })));
  readonly similarArtists = computed(() => this.extras().similarArtists.filter((a) => !this.library.isBlocked({ kind: 'artist', data: a })));
  readonly releaseDate = computed(() => {
    const raw = this.extras().releaseDate || this.album()?.releaseDate || '';
    const d = raw ? new Date(raw.length === 10 ? raw + 'T00:00:00' : raw) : null;
    return d && !Number.isNaN(d.getTime()) ? d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }) : '';
  });
  readonly copyright = computed(() => this.extras().copyright || this.album()?.copyright || '');
  readonly headerStyle = computed(() => {
    const c = this.tint();
    return this.settings.albumBackground() && c ? `background-image: linear-gradient(to bottom, ${c}cc 0%, ${c}33 70%, transparent 100%)` : '';
  });

  constructor() {
    this.route.paramMap
      .pipe(
        tap(() => {
          this.status.set('loading');
          this.extras.set(NO_EXTRAS);
          this.aoty.set(null);
          this.tint.set(null);
        }),
        switchMap((p) => {
          const id = p.get('id') ?? '';
          return this.music.album(id).pipe(
            tap((r) => {
              this.album.set(r.album);
              this.allTracks.set(r.tracks);
              this.status.set('done');
              this.setMeta(r.album);
              this.library.recordActivity({ kind: 'album', data: r.album });
              void coverColor(r.album.cover).then((c) => {
                if (this.album()?.id === r.album.id) this.tint.set(c);
              });
            }),
            // The secondary data never blocks or fails the page.
            switchMap((r) =>
              merge(
                this.catalog.albumExtras(id).pipe(
                  tap((x) => this.extras.set({ ...NO_EXTRAS, ...x })),
                  catchError(() => EMPTY),
                ),
                this.catalog.aoty(r.album.title, r.album.artist).pipe(
                  tap((x) => this.aoty.set(x && (x.critic !== undefined || x.user !== undefined) ? x : null)),
                  catchError(() => EMPTY),
                ),
              ),
            ),
            catchError(() => {
              if (this.status() !== 'done') this.status.set('error');
              return EMPTY;
            }),
          );
        }),
        takeUntilDestroyed(inject(DestroyRef)),
      )
      .subscribe();
  }

  private setMeta(a: MusicAlbum): void {
    this.title.setTitle(`${a.title} by ${a.artist} | Stream Fiesta`);
    this.meta.updateTag({
      name: 'description',
      content: `Listen to ${a.title} by ${a.artist}${a.year ? ' (' + a.year + ')' : ''} in lossless on Stream Fiesta.`,
    });
  }

  playAll(): void {
    const a = this.album();
    const t = this.tracks();
    if (a && t.length) void this.player.play(t[0], t, { context: { type: 'album', id: a.id, label: a.title } });
  }

  shuffleAll(): void {
    const a = this.album();
    const t = this.tracks();
    if (!a || !t.length) return;
    const start = t[Math.floor(Math.random() * t.length)];
    void this.player.play(start, t, { shuffle: true, context: { type: 'album', id: a.id, label: a.title } });
  }

  addToPlaylist(): void {
    const t = this.tracks();
    if (t.length) this.ui.openAddToPlaylist(t);
  }

  async share(): Promise<void> {
    const a = this.album();
    if (!a) return;
    const r = await shareMusicLink({ title: `${a.title} by ${a.artist}`, path: `/music/album/${a.id}` });
    if (r === 'copied') this.toast.show({ message: 'Link copied' });
    else if (r === 'failed') this.toast.show({ message: "Couldn't copy the link", tone: 'warn' });
  }

  downloadAlbum(): void {
    const a = this.album();
    if (a) void this.download.downloadAlbum(a, this.tracks());
  }

  duration(seconds: number): string {
    return longDuration(seconds);
  }
}
