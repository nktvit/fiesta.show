import { Component, DestroyRef, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Title } from '@angular/platform-browser';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { catchError, of, switchMap, tap } from 'rxjs';
import { MusicTrackRowComponent } from '../../components/music-track-row/music-track-row.component';
import { NavbarComponent } from '../../components/navbar/navbar.component';
import { MusicPlayerService } from '../../services/music-player.service';
import { MusicAlbum, MusicArtist, MusicService, MusicTrack } from '../../services/music.service';

@Component({
  selector: 'app-music-artist',
  imports: [NavbarComponent, RouterLink, MusicTrackRowComponent],
  templateUrl: './music-artist.component.html',
})
export class MusicArtistComponent {
  private route = inject(ActivatedRoute);
  private music = inject(MusicService);
  private title = inject(Title);
  protected readonly player = inject(MusicPlayerService);

  readonly artist = signal<MusicArtist | null>(null);
  readonly topTracks = signal<MusicTrack[]>([]);
  readonly albums = signal<MusicAlbum[]>([]);
  readonly status = signal<'loading' | 'done' | 'error'>('loading');

  constructor() {
    this.route.paramMap
      .pipe(
        tap(() => this.status.set('loading')),
        switchMap((p) =>
          this.music.artist(p.get('id') ?? '').pipe(
            tap((r) => {
              this.artist.set(r.artist);
              this.topTracks.set(r.topTracks);
              this.albums.set(r.albums);
              this.status.set('done');
              this.title.setTitle(`${r.artist.name} | Stream Fiesta`);
            }),
            catchError(() => { this.status.set('error'); return of(null); }),
          ),
        ),
        takeUntilDestroyed(inject(DestroyRef)),
      )
      .subscribe();
  }

  playTop(): void {
    const t = this.topTracks();
    if (t.length) void this.player.play(t[0], t);
  }
}
