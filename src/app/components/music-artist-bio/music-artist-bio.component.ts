import { Component, computed, DestroyRef, inject, input, signal } from '@angular/core';
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { catchError, of, switchMap, tap } from 'rxjs';
import { MusicArtistBio, MusicArtistLink, MusicCatalogService } from '../../services/music-catalog.service';
import { artistLinkViews } from '../../utils/music-artist-links';
import { MusicDialogComponent } from '../music-dialog/music-dialog.component';

const EXCERPT_CHARS = 320;

/** Artist bio excerpt with a Read-more dialog, plus external links (MusicBrainz et al). */
@Component({
  selector: 'app-music-artist-bio',
  imports: [MusicDialogComponent, RouterLink],
  templateUrl: './music-artist-bio.component.html',
  host: { class: 'block' },
})
export class MusicArtistBioComponent {
  readonly artistId = input.required<number | string>();
  readonly name = input('');

  private catalog = inject(MusicCatalogService);

  readonly bio = signal<MusicArtistBio | null>(null);
  readonly links = signal<MusicArtistLink[]>([]);
  readonly dialogOpen = signal(false);

  readonly text = computed(() => this.bio()?.text ?? '');
  readonly truncated = computed(() => this.text().length > EXCERPT_CHARS);
  readonly excerpt = computed(() => {
    const t = this.text();
    if (t.length <= EXCERPT_CHARS) return t;
    const cut = t.slice(0, EXCERPT_CHARS);
    const sentence = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('\n'));
    return (sentence > EXCERPT_CHARS * 0.5 ? cut.slice(0, sentence + 1) : cut.replace(/\s+\S*$/, '') + '...').trim();
  });
  readonly paragraphs = computed(() => this.text().split(/\n{2,}/).map((p) => p.trim()).filter(Boolean));
  readonly mentioned = computed(() => this.bio()?.links ?? []);
  readonly linkViews = computed(() => artistLinkViews(this.links()));

  constructor() {
    toObservable(this.artistId)
      .pipe(
        tap(() => {
          this.bio.set(null);
          this.links.set([]);
          this.dialogOpen.set(false);
        }),
        switchMap((id) => this.catalog.artistBio(id).pipe(catchError(() => of(null)))),
        takeUntilDestroyed(inject(DestroyRef)),
      )
      .subscribe((b) => this.bio.set(b && b.text ? b : null));

    toObservable(this.artistId)
      .pipe(
        switchMap((id) => this.catalog.artistLinks(id).pipe(catchError(() => of([] as MusicArtistLink[])))),
        takeUntilDestroyed(inject(DestroyRef)),
      )
      .subscribe((l) => this.links.set((Array.isArray(l) ? l : []).filter((x) => /^https?:\/\//i.test(x.url))));
  }

  protected openDialog(): void {
    this.dialogOpen.set(true);
  }
}
