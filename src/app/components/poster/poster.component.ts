import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  inject,
  input,
  output,
  SimpleChanges,
} from '@angular/core';
import { Router, RouterLink } from "@angular/router";
import { IMovie } from "../../interfaces/movie.interface";
import { NgOptimizedImage } from "@angular/common";
import { TmdbService } from "../../services/tmdb.service";

@Component({
  selector: 'app-poster',
  imports: [RouterLink, NgOptimizedImage],
  templateUrl: './poster.component.html',
  styleUrl: './poster.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PosterComponent {
  readonly movie = input.required<IMovie>();
  readonly size = input<'small' | 'medium' | 'large'>();
  readonly displayTitle = input<boolean>(false);
  readonly priority = input<boolean>(false);
  /**
   * When true the card body expands in place (the host collection handles it)
   * instead of navigating. The play button and the title stay real links to
   * /movie/:id either way.
   */
  readonly expandable = input<boolean>(false);
  readonly expanded = input<boolean>(false);

  /** Emitted on a card-body activation when `expandable` is on. */
  readonly select = output<void>();

  imageUrl = '';
  loading = true;

  private cdr = inject(ChangeDetectorRef);
  private tmdb = inject(TmdbService);
  private router = inject(Router);
  private tmdbFetchAttempted = false;

  ngOnInit() {
    this.updateImageUrl();
  }

  ngOnChanges(changes: SimpleChanges) {
    if (changes['movie']) {
      this.tmdbFetchAttempted = false;
      this.updateImageUrl();
    }
  }

  get movieLink(): (string | number)[] {
    const movie = this.movie();
    return ['/movie', movie.imdbID || movie.tmdbId || ''];
  }

  get movieQueryParams(): Record<string, string> {
    return this.movie().mediaType === 'tv' ? { type: 'tv' } : {};
  }

  /** Play goes to the movie page *and* starts the stream there. */
  get playQueryParams(): Record<string, string> {
    return { ...this.movieQueryParams, play: '1' };
  }

  onCardActivate() {
    if (this.expandable()) {
      this.select.emit();
      return;
    }
    this.router.navigate(this.movieLink, { queryParams: this.playQueryParams });
  }

  onCardKeydown(event: KeyboardEvent) {
    if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'Spacebar') return;
    // Only the card body itself — let Enter on the nested play/title links do
    // their own thing.
    if (event.target !== event.currentTarget) return;
    event.preventDefault();
    this.onCardActivate();
  }

  updateImageUrl() {
    const movie = this.movie();
    if (movie && movie.Poster && movie.Poster !== 'N/A') {
      this.imageUrl = movie.Poster;
    } else if (!this.tmdbFetchAttempted && movie?.imdbID) {
      this.tmdbFetchAttempted = true;
      this.tmdb.findByImdbId(movie.imdbID).subscribe(result => {
        if (result?.poster) {
          this.imageUrl = result.poster;
        } else {
          this.loading = false;
        }
        this.cdr.markForCheck();
      });
    } else {
      this.loading = false;
    }
    // markForCheck, not detectChanges: this runs from ngOnChanges, i.e. inside
    // the parent's change-detection pass. Forcing a nested pass on a view that
    // is still being created throws once views are inserted mid-@for, which is
    // exactly what the expanding panel does.
    this.cdr.markForCheck();
  }

  get sizeClasses(): string {
    switch (this.size()) {
      case 'small':
        return 'max-w-[150px]';
      case 'large':
        return 'max-w-[300px]';
      case 'medium':
        return 'max-w-[200px]';
      default:
        return '';
    }
  }

  onImageLoad() {
    this.loading = false;
    this.cdr.markForCheck();
  }

  onImageError() {
    this.imageUrl = '';
    this.loading = false;
    this.cdr.markForCheck();
  }
}
