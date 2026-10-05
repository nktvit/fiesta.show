import { inject, Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, map, catchError, of, shareReplay } from 'rxjs';
import { IMovie } from '../interfaces/movie.interface';
import { LoggerService } from './logger.service';

// Every call goes through the serverless API (api/tmdb.js). `ng serve` proxies
// /api/* to tools/fiesta-proxy/local-test-server.mjs, so dev runs the same code
// as production and no TMDB key ever reaches the browser.
const API = '/api/tmdb';

// The API returns poster/backdrop as bare TMDB paths for the find lookup.
const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p/w342';
const TMDB_BACKDROP_BASE = 'https://image.tmdb.org/t/p/w1280';

export interface TmdbFindResult {
  id: number;
  poster: string | null;
  backdrop: string | null;
  overview: string | null;
  rating: number | null;
  releaseDate: string | null;
}

export interface CastMember {
  id: number;
  name: string;
  character: string;
  profilePath: string | null;
}

export interface CrewMember {
  id: number;
  name: string;
  profilePath: string | null;
}

export interface PersonSearchResult {
  id: number;
  name: string;
  profilePath: string | null;
  knownForDepartment: string | null;
}

export interface PersonDetails {
  id: number;
  name: string;
  biography: string;
  profilePath: string | null;
  birthday: string | null;
  deathday: string | null;
  placeOfBirth: string | null;
  knownForDepartment: string | null;
  /** Everything, kept for callers that don't care about the split. */
  credits: IMovie[];
  /** Titles the person appeared in. */
  actingCredits: IMovie[];
  /** Titles they worked on behind the camera (directing, writing, producing). */
  crewCredits: IMovie[];
}

@Injectable({ providedIn: 'root' })
export class TmdbService {
  private http = inject(HttpClient);
  private logger = inject(LoggerService);
  private cache = new Map<string, Observable<any>>();

  private cached<T>(key: string, source$: Observable<T>): Observable<T> {
    if (!this.cache.has(key)) {
      this.cache.set(key, source$.pipe(shareReplay(1)));
    }
    return this.cache.get(key) as Observable<T>;
  }

  getTrending(): Observable<IMovie[]> {
    return this.cached('trending', this.fetchList('trending'));
  }

  getNowPlaying(): Observable<IMovie[]> {
    return this.cached('now_playing', this.fetchList('now_playing'));
  }

  getPopular(): Observable<IMovie[]> {
    return this.cached('popular', this.fetchList('popular'));
  }

  getTopRated(): Observable<IMovie[]> {
    return this.cached('top_rated', this.fetchList('top_rated'));
  }

  getTrendingTV(): Observable<IMovie[]> {
    return this.cached('trending_tv', this.fetchList('trending_tv'));
  }

  getTVDetails(tmdbId: number): Observable<{totalSeasons: number, seasons: {number: number, name: string, episodeCount: number}[]}> {
    return this.cached(`tv_details_${tmdbId}`,
      this.http.get<any>(`${API}?list=tv_details&id=${tmdbId}`).pipe(
        map(res => res),
        catchError(() => of({ totalSeasons: 0, seasons: [] }))
      )
    );
  }

  getTVSeasonEpisodes(tmdbId: number, season: number): Observable<any[]> {
    return this.cached(`tv_episodes_${tmdbId}_${season}`,
      this.http.get<any>(`${API}?list=tv_episodes&id=${tmdbId}&season=${season}`).pipe(
        map(res => res.episodes || []),
        catchError(() => of([]))
      )
    );
  }

  getPopularTV(page: number = 1): Observable<{movies: IMovie[], totalPages: number}> {
    return this.cached(`popular_tv_${page}`,
      this.http.get<any>(`${API}?list=popular_tv&page=${page}`).pipe(
        map(res => ({ movies: res.movies || [], totalPages: res.totalPages || 0 })),
        catchError(() => of({ movies: [], totalPages: 0 }))
      )
    );
  }

  getTrailerKey(tmdbId: number, type: string = 'movie'): Observable<string | null> {
    const mediaType = type === 'tv' ? 'tv' : 'movie';
    return this.http.get<any>(`${API}?list=videos&id=${tmdbId}&type=${mediaType}`).pipe(
      map(res => res.trailerKey || null),
      catchError(() => of(null))
    );
  }

  findTmdbId(imdbId: string): Observable<number | null> {
    return this.findByImdbId(imdbId).pipe(map(r => r?.id ?? null));
  }

  findByImdbId(imdbId: string): Observable<TmdbFindResult | null> {
    return this.http.get<any>(`${API}?list=find&id=${imdbId}`).pipe(
      map(res => res.tmdbId ? {
        id: res.tmdbId,
        poster: res.poster ? `${TMDB_IMAGE_BASE}${res.poster}` : null,
        backdrop: res.backdrop ? `${TMDB_BACKDROP_BASE}${res.backdrop}` : null,
        overview: res.overview || null,
        rating: res.rating || null,
        releaseDate: res.releaseDate || null,
      } : null),
      catchError(() => of(null))
    );
  }

  getRecommendations(tmdbId: number, type: string = 'movie'): Observable<IMovie[]> {
    const mediaType = type === 'tv' ? 'tv' : 'movie';
    return this.http.get<any>(`${API}?list=recommendations&id=${tmdbId}&type=${mediaType}`).pipe(
      map(res => res.movies || []),
      catchError(() => of([]))
    );
  }

  getCredits(tmdbId: number, type: string = 'movie'): Observable<{ cast: CastMember[]; directors: CrewMember[] }> {
    const mediaType = type === 'tv' ? 'tv' : 'movie';
    const empty = { cast: [] as CastMember[], directors: [] as CrewMember[] };

    return this.http.get<any>(`${API}?list=credits&id=${tmdbId}&type=${mediaType}`).pipe(
      map(res => ({ cast: res.cast || [], directors: res.directors || [] })),
      catchError(() => of(empty))
    );
  }

  getPerson(personId: number): Observable<PersonDetails | null> {
    return this.http.get<any>(`${API}?list=person&id=${personId}`).pipe(
      // Tolerate an API deployment that predates the acting/crew split.
      map(res => (res && res.id
        ? {
            ...res,
            credits: res.credits || [],
            actingCredits: res.actingCredits || res.credits || [],
            crewCredits: res.crewCredits || [],
          } as PersonDetails
        : null)),
      catchError(() => of(null))
    );
  }

  searchPeople(query: string): Observable<PersonSearchResult[]> {
    const term = query.trim();
    if (term.length < 2) return of([]);

    return this.http.get<any>(`${API}?list=search_person&query=${encodeURIComponent(term)}`).pipe(
      map(res => res.people || []),
      catchError(() => of([]))
    );
  }

  getImdbId(tmdbId: number, typeHint?: 'movie' | 'tv'): Observable<string> {
    const typeParam = typeHint ? `&type=${typeHint}` : '';
    return this.http.get<any>(`${API}?list=movie&id=${tmdbId}${typeParam}`).pipe(
      map(res => res.imdbID || ''),
      catchError(() => of(''))
    );
  }

  private fetchList(list: string): Observable<IMovie[]> {
    return this.http.get<any>(`${API}?list=${list}`).pipe(
      map(res => res.movies || []),
      catchError(err => {
        this.logger.error(`Failed to fetch TMDB ${list}:`, err);
        return of([]);
      })
    );
  }

  getGenres(): Observable<{id: number, name: string}[]> {
    return this.cached('genres',
      this.http.get<any>(`${API}?list=genres`).pipe(
        map(res => res.genres || []),
        catchError(() => of([]))
      )
    );
  }

  discoverByGenre(genreId: number, page: number = 1): Observable<{movies: IMovie[], totalPages: number}> {
    return this.cached(`genre_${genreId}_${page}`,
      this.http.get<any>(`${API}?list=discover&genre=${genreId}&page=${page}`).pipe(
        map(res => ({ movies: res.movies || [], totalPages: res.totalPages || 0 })),
        catchError(() => of({ movies: [], totalPages: 0 }))
      )
    );
  }

  getUpcoming(page: number = 1): Observable<{movies: IMovie[], totalPages: number}> {
    return this.http.get<any>(`${API}?list=upcoming&page=${page}`).pipe(
      map(res => ({ movies: res.movies || [], totalPages: res.totalPages || 0 })),
      catchError(() => of({ movies: [], totalPages: 0 }))
    );
  }

  getTopRatedPaginated(page: number = 1): Observable<{movies: IMovie[], totalPages: number}> {
    return this.cached(`top_rated_${page}`,
      this.http.get<any>(`${API}?list=top_rated&page=${page}`).pipe(
        map(res => ({ movies: res.movies || [], totalPages: res.totalPages || 0 })),
        catchError(() => of({ movies: [], totalPages: 0 }))
      )
    );
  }
}
