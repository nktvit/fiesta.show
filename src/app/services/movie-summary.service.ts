import { inject, Injectable } from '@angular/core';
import { forkJoin, map, Observable, of, shareReplay, switchMap } from 'rxjs';
import { IMovie } from '../interfaces/movie.interface';
import { CastMember, CrewMember, TmdbService } from './tmdb.service';
import { MovieService } from './movie.service';

export interface MovieSummary {
  tmdbId: number | null;
  type: 'movie' | 'tv';
  backdrop: string | null;
  overview: string | null;
  rating: number | null;
  releaseDate: string | null;
  trailerKey: string | null;
  cast: CastMember[];
  /** Crew credited as director, linkable to their person pages. */
  directors: CrewMember[];
  runtime: string | null;
  genres: string[];
  /** Age certificate, e.g. "PG-13". */
  rated: string | null;
  writers: string | null;
  awards: string | null;
  country: string | null;
  boxOffice: string | null;
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
  private movies = inject(MovieService);
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
    // Runtime, genres, certificate and awards only come from the OMDB-backed
    // details endpoint; TMDB's /find returns none of them.
    const details$ = movie.imdbID ? this.movies.getDetailsSnapshot(movie.imdbID) : of(null);

    return forkJoin({ found: found$, details: details$ }).pipe(
      switchMap(({ found, details }) => {
        const tmdbId = movie.tmdbId ?? found?.id ?? null;

        const value = (raw: unknown): string | null => {
          const text = typeof raw === 'string' ? raw.trim() : '';
          // OMDB fills unknown fields with the literal string "N/A".
          return text && text !== 'N/A' ? text : null;
        };

        const base = {
          tmdbId,
          type,
          backdrop: movie.Backdrop ?? found?.backdrop ?? null,
          overview: found?.overview ?? movie.Plot ?? null,
          rating: movie.Rating ?? found?.rating ?? null,
          releaseDate: found?.releaseDate ?? (movie.Year ? String(movie.Year) : null),
          runtime: value(details?.Runtime),
          genres: value(details?.Genre)?.split(',').map((g: string) => g.trim()).filter(Boolean) ?? [],
          rated: value(details?.Rated),
          writers: value(details?.Writer),
          awards: value(details?.Awards),
          country: value(details?.Country),
          boxOffice: value(details?.BoxOffice),
        };

        if (!tmdbId) {
          return of({ ...base, trailerKey: null, cast: [] as CastMember[], directors: [] as CrewMember[] });
        }

        return forkJoin({
          trailerKey: this.tmdb.getTrailerKey(tmdbId, type),
          credits: this.tmdb.getCredits(tmdbId, type),
        }).pipe(
          map(({ trailerKey, credits }) => ({
            ...base,
            trailerKey,
            cast: credits.cast.slice(0, 8),
            directors: credits.directors.slice(0, 3),
          }))
        );
      })
    );
  }
}
