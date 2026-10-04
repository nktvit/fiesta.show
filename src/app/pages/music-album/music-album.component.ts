import { Component, DestroyRef, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Title } from '@angular/platform-browser';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { catchError, of, switchMap, tap } from 'rxjs';
import { MusicTrackRowComponent } from '../../components/music-track-row/music-track-row.component';
import { NavbarComponent } from '../../components/navbar/navbar.component';
import { MusicPlayerService } from '../../services/music-player.service';
import { MusicAlbum, MusicService, MusicTrack } from '../../services/music.service';

@Component({
  selector: 'app-music-album',
  imports: [NavbarComponent, RouterLink, MusicTrackRowComponent],
  templateUrl: './music-album.component.html',
})
export class MusicAlbumComponent {
  private route = inject(ActivatedRoute);
  private music = inject(MusicService);
  private title = inject(Title);
  protected readonly player = inject(MusicPlayerService);

  readonly album = signal<MusicAlbum | null>(null);
  readonly tracks = signal<MusicTrack[]>([]);
  readonly status = signal<'loading' | 'done' | 'error'>('loading');

  constructor() {
    this.route.paramMap
      .pipe(
        tap(() => this.status.set('loading')),
        switchMap((p) =>
          this.music.album(p.get('id') ?? '').pipe(
            tap((r) => {
              this.album.set(r.album);
              this.tracks.set(r.tracks);
              this.status.set('done');
              this.title.setTitle(`${r.album.title} - ${r.album.artist} | Stream Fiesta`);
            }),
            catchError(() => { this.status.set('error'); return of(null); }),
          ),
        ),
        takeUntilDestroyed(inject(DestroyRef)),
      )
      .subscribe();
  }

  playAll(): void {
    const t = this.tracks();
    if (t.length) void this.player.play(t[0], t);
  }

  minutes(seconds: number): string {
    const m = Math.round(seconds / 60);
    return m >= 60 ? `${Math.floor(m / 60)} hr ${m % 60} min` : `${m} min`;
  }
}
