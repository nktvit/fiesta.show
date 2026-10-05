import { Component, computed, DestroyRef, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Meta, Title } from '@angular/platform-browser';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { catchError, EMPTY, switchMap, tap } from 'rxjs';
import { MusicLikeButtonComponent } from '../../components/music-like-button/music-like-button.component';
import { MusicSubnavComponent } from '../../components/music-subnav/music-subnav.component';
import { MusicTrackRowComponent } from '../../components/music-track-row/music-track-row.component';
import { NavbarComponent } from '../../components/navbar/navbar.component';
import { MusicDiscoveryService } from '../../services/music-discovery.service';
import { MusicLibraryService } from '../../services/music-library.service';
import { MusicPlayerService } from '../../services/music-player.service';
import { MusicToastService } from '../../services/music-toast.service';
import { MusicUiService } from '../../services/music-ui.service';
import { MusicLibraryItem, MusicMix, MusicTrack } from '../../services/music.service';
import { longDuration } from '../../utils/music-format';
import { shareMusicLink } from '../../utils/music-links';

/** Route /music/mix/:id (a TIDAL mix: My Mix, track radio, artist radio). */
@Component({
  selector: 'app-music-mix',
  imports: [NavbarComponent, RouterLink, MusicSubnavComponent, MusicTrackRowComponent, MusicLikeButtonComponent],
  templateUrl: './music-mix.component.html',
})
export class MusicMixComponent {
  private route = inject(ActivatedRoute);
  private discovery = inject(MusicDiscoveryService);
  private title = inject(Title);
  private meta = inject(Meta);
  private library = inject(MusicLibraryService);
  private toast = inject(MusicToastService);
  private ui = inject(MusicUiService);
  protected readonly player = inject(MusicPlayerService);

  readonly mix = signal<MusicMix | null>(null);
  private readonly allTracks = signal<MusicTrack[]>([]);
  readonly status = signal<'loading' | 'done' | 'empty' | 'error' | 'missing'>('loading');

  readonly tracks = computed(() => this.allTracks().filter((t) => !this.library.isBlocked(t)));
  readonly totalSeconds = computed(() => this.tracks().reduce((n, t) => n + (t.duration || 0), 0));
  readonly item = computed<MusicLibraryItem | null>(() => {
    const m = this.mix();
    return m ? { kind: 'mix', data: m } : null;
  });

  constructor() {
    this.title.setTitle('Mix | Stream Fiesta');
    this.route.paramMap
      .pipe(
        tap(() => {
          this.status.set('loading');
          this.mix.set(null);
          this.allTracks.set([]);
        }),
        switchMap((p) =>
          this.discovery.mix(p.get('id') ?? '').pipe(
            tap((r) => {
              const mix = r.mix;
              this.mix.set(mix);
              this.allTracks.set(r.tracks);
              this.status.set(r.tracks.length ? 'done' : 'empty');
              this.setMeta(mix);
              if (r.tracks.length && mix.title) this.library.recordActivity({ kind: 'mix', data: mix });
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

  private setMeta(m: MusicMix): void {
    const name = m.title || 'Mix';
    this.title.setTitle(`${name} | Stream Fiesta`);
    this.meta.updateTag({ name: 'description', content: `${name}${m.subTitle ? ' by ' + m.subTitle : ''}: a mix made for you on Stream Fiesta.` });
  }

  playAll(): void {
    const m = this.mix();
    const t = this.tracks();
    if (m && t.length) void this.player.play(t[0], t, { context: { type: 'mix', id: m.id, label: m.title } });
  }

  shuffleAll(): void {
    const m = this.mix();
    const t = this.tracks();
    if (!m || !t.length) return;
    void this.player.play(t[Math.floor(Math.random() * t.length)], t, { shuffle: true, context: { type: 'mix', id: m.id, label: m.title } });
  }

  addToPlaylist(): void {
    const t = this.tracks();
    if (t.length) this.ui.openAddToPlaylist(t);
  }

  async share(): Promise<void> {
    const m = this.mix();
    if (!m) return;
    const r = await shareMusicLink({ title: m.title, path: `/music/mix/${m.id}` });
    if (r === 'copied') this.toast.show({ message: 'Link copied' });
    else if (r === 'failed') this.toast.show({ message: "Couldn't copy the link", tone: 'warn' });
  }

  protected duration(s: number): string {
    return longDuration(s);
  }
}
