import { Component, computed, DestroyRef, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Meta, Title } from '@angular/platform-browser';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { catchError, EMPTY, switchMap, tap } from 'rxjs';
import { MusicLikeButtonComponent } from '../../components/music-like-button/music-like-button.component';
import { MusicSubnavComponent } from '../../components/music-subnav/music-subnav.component';
import { MusicTrackRowComponent } from '../../components/music-track-row/music-track-row.component';
import { NavbarComponent } from '../../components/navbar/navbar.component';
import { MusicCatalogService } from '../../services/music-catalog.service';
import { MusicDiscoveryService } from '../../services/music-discovery.service';
import { MusicLibraryService } from '../../services/music-library.service';
import { MusicPlayerService } from '../../services/music-player.service';
import { MusicToastService } from '../../services/music-toast.service';
import { MusicUiService } from '../../services/music-ui.service';
import { MusicAlbum, MusicLibraryItem, MusicTrack } from '../../services/music.service';
import { time } from '../../utils/music-format';
import { musicUrl, shareMusicLink } from '../../utils/music-links';

/** /music/track/:id - one song, its album's tracks and similar tracks. */
@Component({
  selector: 'app-music-track',
  imports: [NavbarComponent, RouterLink, MusicSubnavComponent, MusicTrackRowComponent, MusicLikeButtonComponent],
  templateUrl: './music-track.component.html',
})
export class MusicTrackComponent {
  private route = inject(ActivatedRoute);
  private catalog = inject(MusicCatalogService);
  private discovery = inject(MusicDiscoveryService);
  private title = inject(Title);
  private meta = inject(Meta);
  private toast = inject(MusicToastService);
  private ui = inject(MusicUiService);
  private library = inject(MusicLibraryService);
  protected readonly player = inject(MusicPlayerService);

  readonly track = signal<MusicTrack | null>(null);
  readonly album = signal<MusicAlbum | null>(null);
  private readonly albumList = signal<MusicTrack[]>([]);
  private readonly similar = signal<MusicTrack[]>([]);
  readonly status = signal<'loading' | 'done' | 'error'>('loading');

  readonly albumTracks = computed(() => this.albumList().filter((t) => !this.library.isBlocked(t)));
  readonly similarTracks = computed(() => this.similar().filter((t) => !this.library.isBlocked(t)));
  readonly item = computed<MusicLibraryItem | null>(() => {
    const t = this.track();
    return t ? { kind: 'track', data: t } : null;
  });
  readonly isCurrent = computed(() => this.player.track()?.id === this.track()?.id);
  readonly isPlaying = computed(() => this.isCurrent() && this.player.playing());
  readonly linkUrl = computed(() => {
    const t = this.track();
    return t ? musicUrl(`/music/track/${t.id}`) : '';
  });

  constructor() {
    this.route.paramMap
      .pipe(
        tap(() => {
          this.status.set('loading');
          this.similar.set([]);
          // Until the track loads (or when it does not exist) the tab still names the page.
          this.title.setTitle('Track | Stream Fiesta');
        }),
        switchMap((p) => {
          const id = p.get('id') ?? '';
          return this.catalog.track(id).pipe(
            tap((r) => {
              this.track.set(r.track);
              this.album.set(r.album ?? null);
              this.albumList.set(r.albumTracks);
              this.status.set('done');
              this.title.setTitle(`${r.track.title}${r.track.artist ? ' by ' + r.track.artist : ''} | Stream Fiesta`);
              this.meta.updateTag({
                name: 'description',
                content: `Listen to ${r.track.title}${r.track.artist ? ' by ' + r.track.artist : ''}${r.track.album ? ' from ' + r.track.album : ''} in lossless on Stream Fiesta.`,
              });
              if (r.album) this.library.recordActivity({ kind: 'album', data: r.album });
            }),
            switchMap(() =>
              this.discovery.trackMix(id).pipe(
                tap((m) => this.similar.set((m.tracks ?? []).filter((t) => String(t.id) !== id))),
                catchError(() => EMPTY),
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

  play(): void {
    const t = this.track();
    if (!t) return;
    if (this.isCurrent()) {
      this.player.toggle();
      return;
    }
    const list = this.albumTracks().some((x) => x.id === t.id) ? this.albumTracks() : [t];
    void this.player.play(t, list, t.albumId ? { context: { type: 'album', id: t.albumId, label: t.album } } : {});
  }

  radio(): void {
    const t = this.track();
    if (t) void this.player.startRadio({ kind: 'track', id: t.id, label: t.title });
  }

  addToPlaylist(): void {
    const t = this.track();
    if (t) this.ui.openAddToPlaylist([t]);
  }

  async share(): Promise<void> {
    const t = this.track();
    if (!t) return;
    const r = await shareMusicLink({ title: `${t.title} by ${t.artist}`, path: `/music/track/${t.id}` });
    if (r === 'copied') this.toast.show({ message: 'Link copied' });
    else if (r === 'failed') this.toast.show({ message: "Couldn't copy the link", tone: 'warn' });
  }

  async copyLink(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.linkUrl());
      this.toast.show({ message: 'Link copied' });
    } catch {
      this.toast.show({ message: "Couldn't copy the link", tone: 'warn' });
    }
  }

  time(s: number): string {
    return time(s);
  }
}
