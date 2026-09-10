import { inject, Injectable } from '@angular/core';
import { forkJoin, map, Observable, of, shareReplay, switchMap } from 'rxjs';
import { IMovie } from '../interfaces/movie.interface';
import { CastMember, TmdbService } from './tmdb.service';

export interface MovieSummary {
  tmdbId: number | null;
  type: 'movie' | 'tv';
  backdrop: string | null;
  overview: string | null;
  rating: number | null;
  releaseDate: string | null;
  trailerKey: string | null;
  cast: CastMember[];
}

/**
 * Everything the in-grid expansion panel shows, in one call.
 *
 * The panel can be opened and closed repeatedly while browsing, so results are
 * memoised per card here on top of whatever caching TmdbService and the HTTP
 * cache interceptor already do — reopening a card must not refetch.
 */
@Injectable({ providedIn: 'root' })
export class MovieSummaryService {
  private tmdb = inject(TmdbService);
  private cache = new Map<string, Observable<MovieSummary>>();

  summaryFor(movie: IMovie): Observable<MovieSummary> {
    const key = String(movie.tmdbId ?? movie.imdbID ?? movie.Title);
    const existing = this.cache.get(key);
    if (existing) return existing;

    const summary$ = this.build(movie).pipe(shareReplay(1));
    this.cache.set(key, summary$);
    return summary$;
  }

  private build(movie: IMovie): Observable<MovieSummary> {
    const type: 'movie' | 'tv' = movie.mediaType === 'tv' ? 'tv' : 'movie';

    // Prefer the tmdb id we already have; otherwise resolve it from the imdb
    // id, the same ladder the movie page uses.
    const found$ = movie.imdbID ? this.tmdb.findByImdbId(movie.imdbID) : of(null);

    return found$.pipe(
      switchMap(found => {
        const tmdbId = movie.tmdbId ?? found?.id ?? null;

        const base = {
          tmdbId,
          type,
          backdrop: movie.Backdrop ?? found?.backdrop ?? null,
          overview: found?.overview ?? movie.Plot ?? null,
          rating: movie.Rating ?? found?.rating ?? null,
          releaseDate: found?.releaseDate ?? (movie.Year ? String(movie.Year) : null),
        };

        if (!tmdbId) {
          return of({ ...base, trailerKey: null, cast: [] as CastMember[] });
        }

        return forkJoin({
          trailerKey: this.tmdb.getTrailerKey(tmdbId, type),
          credits: this.tmdb.getCredits(tmdbId, type),
        }).pipe(
          map(({ trailerKey, credits }) => ({
            ...base,
            trailerKey,
            cast: credits.cast.slice(0, 8),
          }))
        );
      })
    );
  }
}
