import { inject, Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, map, switchMap, catchError, of, shareReplay } from 'rxjs';
import { IMovie } from '../interfaces/movie.interface';
import { environment } from '../../environments/environment';
import { LoggerService } from './logger.service';

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
    return this.cached(`tv_details_${tmdbId}`, environment.production
      ? this.http.get<any>(`/api/tmdb?list=tv_details&id=${tmdbId}`).pipe(
          map(res => res),
          catchError(() => of({ totalSeasons: 0, seasons: [] }))
        )
      : this.http.get<any>(
          `https://api.themoviedb.org/3/tv/${tmdbId}?api_key=${(environment as any).TMDB_API_KEY}&language=en-US`
        ).pipe(
          map(res => ({
            totalSeasons: res.number_of_seasons || 0,
            seasons: (res.seasons || [])
              .filter((s: any) => s.season_number > 0)
              .map((s: any) => ({ number: s.season_number, name: s.name, episodeCount: s.episode_count }))
          })),
          catchError(() => of({ totalSeasons: 0, seasons: [] }))
        )
    );
  }

  getTVSeasonEpisodes(tmdbId: number, season: number): Observable<any[]> {
    return this.cached(`tv_episodes_${tmdbId}_${season}`, environment.production
      ? this.http.get<any>(`/api/tmdb?list=tv_episodes&id=${tmdbId}&season=${season}`).pipe(
          map(res => res.episodes || []),
          catchError(() => of([]))
        )
      : this.http.get<any>(
          `https://api.themoviedb.org/3/tv/${tmdbId}/season/${season}?api_key=${(environment as any).TMDB_API_KEY}&language=en-US`
        ).pipe(
          map(res => (res.episodes || []).map((ep: any) => ({
            number: ep.episode_number,
            title: ep.name || `Episode ${ep.episode_number}`,
            rating: ep.vote_average ? ep.vote_average.toFixed(1) : null,
            airDate: ep.air_date || null,
            still: ep.still_path ? 'https://image.tmdb.org/t/p/w300' + ep.still_path : null,
          }))),
          catchError(() => of([]))
        )
    );
  }

  getPopularTV(page: number = 1): Observable<{movies: IMovie[], totalPages: number}> {
    return this.cached(`popular_tv_${page}`, environment.production
      ? this.http.get<any>(`/api/tmdb?list=popular_tv&page=${page}`).pipe(
          map(res => ({ movies: res.movies || [], totalPages: res.totalPages || 0 })),
          catchError(() => of({ movies: [], totalPages: 0 }))
        )
      : this.http.get<any>(
          `https://api.themoviedb.org/3/tv/popular?api_key=${(environment as any).TMDB_API_KEY}&language=en-US&page=${page}`
        ).pipe(
          map(res => ({
            movies: (res.results || [])
              .filter((item: any) => item.original_language !== 'ru' && item.vote_count > 100)
              .map((item: any) => this.mapMovie(item, 'tv')),
            totalPages: res.total_pages || 0
          })),
          catchError(() => of({ movies: [], totalPages: 0 }))
        )
    );
  }

  getTrailerKey(tmdbId: number, type: string = 'movie'): Observable<string | null> {
    const mediaType = type === 'tv' ? 'tv' : 'movie';
    if (environment.production) {
      return this.http.get<any>(`/api/tmdb?list=videos&id=${tmdbId}&type=${mediaType}`).pipe(
        map(res => res.trailerKey || null),
        catchError(() => of(null))
      );
    }
    return this.http.get<any>(
      `https://api.themoviedb.org/3/${mediaType}/${tmdbId}/videos?api_key=${(environment as any).TMDB_API_KEY}&language=en-US`
    ).pipe(
      map(res => {
        const trailer = (res.results || []).find((v: any) => v.type === 'Trailer' && v.site === 'YouTube');
        return trailer ? trailer.key : null;
      }),
      catchError(() => of(null))
    );
  }

  findTmdbId(imdbId: string): Observable<number | null> {
    return this.findByImdbId(imdbId).pipe(map(r => r?.id ?? null));
  }

  findByImdbId(imdbId: string): Observable<TmdbFindResult | null> {
    if (environment.production) {
      return this.http.get<any>(`/api/tmdb?list=find&id=${imdbId}`).pipe(
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
    return this.http.get<any>(
      `https://api.themoviedb.org/3/find/${imdbId}?api_key=${(environment as any).TMDB_API_KEY}&external_source=imdb_id`
    ).pipe(
      map(res => {
        const match = (res.movie_results || [])[0] || (res.tv_results || [])[0];
        if (!match) return null;
        return {
          id: match.id,
          poster: match.poster_path ? `${TMDB_IMAGE_BASE}${match.poster_path}` : null,
          backdrop: match.backdrop_path ? `${TMDB_BACKDROP_BASE}${match.backdrop_path}` : null,
          overview: match.overview || null,
          rating: match.vote_average || null,
          releaseDate: match.release_date || match.first_air_date || null,
        };
      }),
      catchError(() => of(null))
    );
  }

  getRecommendations(tmdbId: number, type: string = 'movie'): Observable<IMovie[]> {
    const mediaType = type === 'tv' ? 'tv' : 'movie';
    if (environment.production) {
      return this.http.get<any>(`/api/tmdb?list=recommendations&id=${tmdbId}&type=${mediaType}`).pipe(
        map(res => res.movies || []),
        catchError(() => of([]))
      );
    }

    const url = `https://api.themoviedb.org/3/${mediaType}/${tmdbId}/recommendations?api_key=${(environment as any).TMDB_API_KEY}&language=en-US&page=1`;
    return this.http.get<any>(url).pipe(
      map(res => (res.results || [])
        .filter((item: any) => item.vote_count > 50)
        .map((item: any) => this.mapMovie(item, mediaType))),
      catchError(() => of([]))
    );
  }

  getCredits(tmdbId: number, type: string = 'movie'): Observable<{ cast: CastMember[]; directors: CrewMember[] }> {
    const mediaType = type === 'tv' ? 'tv' : 'movie';
    const empty = { cast: [] as CastMember[], directors: [] as CrewMember[] };

    if (environment.production) {
      return this.http.get<any>(`/api/tmdb?list=credits&id=${tmdbId}&type=${mediaType}`).pipe(
        map(res => ({ cast: res.cast || [], directors: res.directors || [] })),
        catchError(() => of(empty))
      );
    }

    const apiKey = (environment as any).TMDB_API_KEY;
    return this.http.get<any>(
      `https://api.themoviedb.org/3/${mediaType}/${tmdbId}/credits?api_key=${apiKey}&language=en-US`
    ).pipe(
      map(res => {
        const mapPerson = (p: any) => ({
          id: p.id,
          name: p.name,
          profilePath: p.profile_path ? `${TMDB_IMAGE_BASE}${p.profile_path}` : null,
        });
        const cast = (res.cast || []).slice(0, 12).map((p: any) => ({ ...mapPerson(p), character: p.character || '' }));
        const directors = (res.crew || []).filter((p: any) => p.job === 'Director').map(mapPerson);
        return { cast, directors };
      }),
      catchError(() => of(empty))
    );
  }

  getPerson(personId: number): Observable<PersonDetails | null> {
    if (environment.production) {
      return this.http.get<any>(`/api/tmdb?list=person&id=${personId}`).pipe(
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

    const apiKey = (environment as any).TMDB_API_KEY;
    return this.http.get<any>(
      `https://api.themoviedb.org/3/person/${personId}?api_key=${apiKey}&language=en-US`
    ).pipe(
      switchMap(person => {
        if (!person || !person.id) return of(null);
        return this.http.get<any>(
          `https://api.themoviedb.org/3/person/${personId}/combined_credits?api_key=${apiKey}&language=en-US`
        ).pipe(
          map(creditsData => {
            // Acting and crew work are listed separately: merging them made a
            // director's page show films they directed next to films they only
            // appeared in, with no way to tell which was which.
            const actingCredits = this.dedupeCredits(creditsData.cast || []);
            const crewCredits = this.dedupeCredits(creditsData.crew || []);
            const seen = new Set<string>();
            const credits: IMovie[] = [...actingCredits, ...crewCredits].filter(c => {
              const key = `${c.mediaType}_${c.tmdbId}`;
              if (seen.has(key)) return false;
              seen.add(key);
              return true;
            });

            const details: PersonDetails = {
              id: person.id,
              name: person.name || '',
              biography: person.biography || '',
              profilePath: person.profile_path ? `${TMDB_IMAGE_BASE}${person.profile_path}` : null,
              birthday: person.birthday || null,
              deathday: person.deathday || null,
              placeOfBirth: person.place_of_birth || null,
              knownForDepartment: person.known_for_department || null,
              credits,
              actingCredits,
              crewCredits,
            };
            return details;
          })
        );
      }),
      catchError(() => of(null))
    );
  }

  /**
   * One credit list: drops entries with no poster, collapses the repeats TMDB
   * returns when someone held several jobs on the same title, newest first.
   */
  private dedupeCredits(entries: any[]): IMovie[] {
    const seen = new Set<string>();
    return entries
      .filter((c: any) => {
        if (!c.poster_path) return false;
        const key = `${c.media_type}_${c.id}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a: any, b: any) =>
        (b.release_date || b.first_air_date || '').localeCompare(a.release_date || a.first_air_date || '')
      )
      .map((c: any) => this.mapMovie(c, c.media_type));
  }

  searchPeople(query: string): Observable<PersonSearchResult[]> {
    const term = query.trim();
    if (term.length < 2) return of([]);

    if (environment.production) {
      return this.http.get<any>(`/api/tmdb?list=search_person&query=${encodeURIComponent(term)}`).pipe(
        map(res => res.people || []),
        catchError(() => of([]))
      );
    }

    const apiKey = (environment as any).TMDB_API_KEY;
    return this.http.get<any>(
      `https://api.themoviedb.org/3/search/person?api_key=${apiKey}&language=en-US&query=${encodeURIComponent(term)}&page=1`
    ).pipe(
      map(res => (res.results || [])
        .filter((p: any) => p.known_for_department === 'Acting' || p.known_for_department === 'Directing')
        .sort((a: any, b: any) => (b.popularity || 0) - (a.popularity || 0))
        .slice(0, 8)
        .map((p: any) => ({
          id: p.id,
          name: p.name,
          profilePath: p.profile_path ? `${TMDB_IMAGE_BASE}${p.profile_path}` : null,
          knownForDepartment: p.known_for_department || null,
        }))),
      catchError(() => of([]))
    );
  }

  getImdbId(tmdbId: number, typeHint?: 'movie' | 'tv'): Observable<string> {
    if (environment.production) {
      const typeParam = typeHint ? `&type=${typeHint}` : '';
      return this.http.get<any>(`/api/tmdb?list=movie&id=${tmdbId}${typeParam}`).pipe(
        map(res => res.imdbID || ''),
        catchError(() => of(''))
      );
    }

    const apiKey = (environment as any).TMDB_API_KEY;

    if (typeHint === 'tv') {
      // TV hint: try TV first, fall back to movie
      return this.http.get<any>(
        `https://api.themoviedb.org/3/tv/${tmdbId}/external_ids?api_key=${apiKey}`
      ).pipe(
        map(res => res.imdb_id || ''),
        switchMap(imdbId => {
          if (imdbId) return of(imdbId);
          return this.http.get<any>(
            `https://api.themoviedb.org/3/movie/${tmdbId}?api_key=${apiKey}`
          ).pipe(
            map(res => res.imdb_id || ''),
            catchError(() => of(''))
          );
        }),
        catchError(() => of(''))
      );
    }

    // Default: try movie first, fall back to TV
    return this.http.get<any>(
      `https://api.themoviedb.org/3/movie/${tmdbId}?api_key=${apiKey}`
    ).pipe(
      map(res => res.imdb_id || ''),
      switchMap(imdbId => {
        if (imdbId) return of(imdbId);
        return this.http.get<any>(
          `https://api.themoviedb.org/3/tv/${tmdbId}/external_ids?api_key=${apiKey}`
        ).pipe(
          map(res => res.imdb_id || ''),
          catchError(() => of(''))
        );
      }),
      catchError(() => of(''))
    );
  }

  private fetchList(list: string): Observable<IMovie[]> {
    if (environment.production) {
      return this.http.get<any>(`/api/tmdb?list=${list}`).pipe(
        map(res => res.movies || []),
        catchError(err => {
          this.logger.error(`Failed to fetch TMDB ${list}:`, err);
          return of([]);
        })
      );
    }

    const endpoints: Record<string, string> = {
      trending: '/trending/movie/week',
      now_playing: '/movie/now_playing',
      popular: '/movie/popular',
      top_rated: '/movie/top_rated',
      trending_tv: '/trending/tv/week',
    };
    const tvLists = ['trending_tv'];
    const mediaType: 'movie' | 'tv' = tvLists.includes(list) ? 'tv' : 'movie';

    const url = `https://api.themoviedb.org/3${endpoints[list]}?api_key=${(environment as any).TMDB_API_KEY}&language=en-US&page=1`;
    return this.http.get<any>(url).pipe(
      map(res => (res.results || [])
        .filter((item: any) => item.original_language !== 'ru' && item.vote_count > 100)
        .map((item: any) => this.mapMovie(item, mediaType))),
      catchError(err => {
        this.logger.error(`Failed to fetch TMDB ${list}:`, err);
        return of([]);
      })
    );
  }

  getGenres(): Observable<{id: number, name: string}[]> {
    return this.cached('genres', environment.production
      ? this.http.get<any>('/api/tmdb?list=genres').pipe(
          map(res => res.genres || []),
          catchError(() => of([]))
        )
      : this.http.get<any>(
          `https://api.themoviedb.org/3/genre/movie/list?api_key=${(environment as any).TMDB_API_KEY}&language=en-US`
        ).pipe(
          map(res => res.genres || []),
          catchError(() => of([]))
        )
    );
  }

  discoverByGenre(genreId: number, page: number = 1): Observable<{movies: IMovie[], totalPages: number}> {
    return this.cached(`genre_${genreId}_${page}`, environment.production
      ? this.http.get<any>(`/api/tmdb?list=discover&genre=${genreId}&page=${page}`).pipe(
          map(res => ({ movies: res.movies || [], totalPages: res.totalPages || 0 })),
          catchError(() => of({ movies: [], totalPages: 0 }))
        )
      : this.http.get<any>(
          `https://api.themoviedb.org/3/discover/movie?api_key=${(environment as any).TMDB_API_KEY}&with_genres=${genreId}&sort_by=popularity.desc&vote_count.gte=100&page=${page}&language=en-US`
        ).pipe(
          map(res => ({
            movies: (res.results || [])
              .filter((item: any) => item.original_language !== 'ru')
              .map((item: any) => this.mapMovie(item)),
            totalPages: res.total_pages || 0
          })),
          catchError(() => of({ movies: [], totalPages: 0 }))
        )
    );
  }

  getUpcoming(page: number = 1): Observable<{movies: IMovie[], totalPages: number}> {
    if (environment.production) {
      return this.http.get<any>(`/api/tmdb?list=upcoming&page=${page}`).pipe(
        map(res => ({ movies: res.movies || [], totalPages: res.totalPages || 0 })),
        catchError(() => of({ movies: [], totalPages: 0 }))
      );
    }
    return this.http.get<any>(
      `https://api.themoviedb.org/3/movie/upcoming?api_key=${(environment as any).TMDB_API_KEY}&language=en-US&page=${page}`
    ).pipe(
      map(res => ({
        movies: (res.results || [])
          .filter((item: any) => item.original_language !== 'ru')
          .map((item: any) => this.mapMovie(item)),
        totalPages: res.total_pages || 0
      })),
      catchError(() => of({ movies: [], totalPages: 0 }))
    );
  }

  getTopRatedPaginated(page: number = 1): Observable<{movies: IMovie[], totalPages: number}> {
    return this.cached(`top_rated_${page}`, environment.production
      ? this.http.get<any>(`/api/tmdb?list=top_rated&page=${page}`).pipe(
          map(res => ({ movies: res.movies || [], totalPages: res.totalPages || 0 })),
          catchError(() => of({ movies: [], totalPages: 0 }))
        )
      : this.http.get<any>(
          `https://api.themoviedb.org/3/movie/top_rated?api_key=${(environment as any).TMDB_API_KEY}&language=en-US&page=${page}`
        ).pipe(
          map(res => ({
            movies: (res.results || [])
              .filter((item: any) => item.original_language !== 'ru' && item.vote_count > 100)
              .map((item: any) => this.mapMovie(item)),
            totalPages: res.total_pages || 0
          })),
          catchError(() => of({ movies: [], totalPages: 0 }))
        )
    );
  }

  private mapMovie(item: any, mediaType?: 'movie' | 'tv'): IMovie {
    return {
      imdbID: '',
      tmdbId: item.id,
      mediaType: mediaType || (item.first_air_date || item.name && !item.title ? 'tv' : 'movie'),
      Title: item.title || item.name || '',
      Poster: item.poster_path ? `${TMDB_IMAGE_BASE}${item.poster_path}` : '',
      Plot: item.overview || '',
      Backdrop: item.backdrop_path ? `${TMDB_BACKDROP_BASE}${item.backdrop_path}` : '',
      Rating: item.vote_average || 0,
      Year: (item.release_date || item.first_air_date || '').substring(0, 4),
    };
  }
}
