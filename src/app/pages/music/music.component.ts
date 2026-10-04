import { Component, DestroyRef, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Meta, Title } from '@angular/platform-browser';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { catchError, map, of, switchMap, tap } from 'rxjs';
import { MusicTrackRowComponent } from '../../components/music-track-row/music-track-row.component';
import { NavbarComponent } from '../../components/navbar/navbar.component';
import { MusicSearchResult, MusicService } from '../../services/music.service';

type Tab = 'songs' | 'albums' | 'artists';

@Component({
  selector: 'app-music',
  imports: [NavbarComponent, RouterLink, MusicTrackRowComponent],
  templateUrl: './music.component.html',
})
export class MusicComponent {
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private music = inject(MusicService);
  private title = inject(Title);
  private meta = inject(Meta);

  readonly suggestions = ['Daft Punk', 'Radiohead', 'Kendrick Lamar', 'Billie Eilish', 'Fleetwood Mac', 'Tame Impala'];

  readonly text = signal('');
  readonly tab = signal<Tab>('songs');
  readonly status = signal<'idle' | 'loading' | 'done' | 'error'>('idle');
  readonly result = signal<MusicSearchResult | null>(null);

  constructor() {
    this.title.setTitle('Music | Stream Fiesta');
    this.meta.updateTag({ name: 'description', content: 'Search and play lossless music.' });

    // One-time owner link: /music?unlock=<key> remembers the key in this browser
    // (full-length playback, see api/music.js) and then drops it from the URL.
    const unlock = this.route.snapshot.queryParamMap.get('unlock');
    if (unlock) {
      this.music.unlock(unlock);
      void this.router.navigate([], { queryParams: { unlock: null }, queryParamsHandling: 'merge', replaceUrl: true });
    }

    // The query lives in the URL (?q=), so back/forward and shared links work.
    this.route.queryParamMap
      .pipe(
        map((p) => (p.get('q') ?? '').trim()),
        tap((q) => this.text.set(q)),
        switchMap((q) => {
          if (!q) {
            this.status.set('idle');
            this.result.set(null);
            return of(null);
          }
          this.status.set('loading');
          return this.music.search(q).pipe(
            tap((r) => { this.result.set(r); this.status.set('done'); }),
            catchError(() => { this.status.set('error'); return of(null); }),
          );
        }),
        takeUntilDestroyed(inject(DestroyRef)),
      )
      .subscribe();
  }

  submit(event: Event): void {
    event.preventDefault();
    const q = this.text().trim();
    void this.router.navigate([], { queryParams: { q: q || null }, queryParamsHandling: 'merge' });
  }

  search(q: string): void {
    this.text.set(q);
    void this.router.navigate([], { queryParams: { q } });
  }

  onInput(event: Event): void {
    this.text.set((event.target as HTMLInputElement).value);
  }
}
