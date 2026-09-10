import {inject, Injectable} from '@angular/core';
import {BehaviorSubject, catchError, map, Observable, of, tap} from 'rxjs';
import {HttpClient} from '@angular/common/http';
import {environment} from '../../environments/environment';
import {LoggerService} from "./logger.service";

@Injectable({providedIn: 'root'})


export class MovieService {
  private readonly API_KEY = environment.OMDB_API_KEY;

  currentQuery: string = '';

  private searchResults = new BehaviorSubject<any>([]);
  public searchResults$ = this.searchResults.asObservable();

  private movieDetailsSubject = new BehaviorSubject<any>({})
  public movieDetails$ = this.movieDetailsSubject.asObservable()

  // page states
  private currentPageSource = new BehaviorSubject<number>(1);
  private totalResultsSource = new BehaviorSubject<number>(0);

  currentPage$ = this.currentPageSource.asObservable();
  totalResults$ = this.totalResultsSource.asObservable();

  private http = inject(HttpClient);
  private logger = inject(LoggerService);


  searchMovies(searchTerm: string, page: number = 1): Observable<any> {
    this.currentQuery = searchTerm;
    const url = this.buildSearchUrl(searchTerm, page);

    return this.http.get<any>(url).pipe(
      tap(response => {
        if (response && response.Search) {
          this.searchResults.next(response.Search);
          this.currentPageSource.next(page);
          this.totalResultsSource.next(Number(response.totalResults) || 0);
        } else {
          this.resetSearchState();
        }
      }),
      catchError(error => {
        this.logger.error('Error fetching data: ', error);
        this.resetSearchState();
        return of(null);
      })
    );
  }

  getMovieDetails(movieId: string): Observable<any> {
    return this.fetchMovieDetails(movieId).pipe(
      tap((response) => this.movieDetailsSubject.next(response)),
      catchError((error) => {
        this.logger.error('Error fetching data: ', error);
        this.resetMovieDetails();
        return of(null);
      })
    );
  }

  /**
   * Details for a title without publishing them.
   *
   * `getMovieDetails` pushes into `movieDetailsSubject`, which the movie page
   * is bound to — calling it from anywhere else (the in-grid expansion panel,
   * say) would overwrite whatever that page is showing.
   */
  getDetailsSnapshot(id: string): Observable<any | null> {
    return this.fetchMovieDetails(id).pipe(catchError(() => of(null)));
  }

  private fetchMovieDetails(id: string): Observable<any> {
    const url = this.buildDetailsUrl(id);
    return this.http.get<any>(url, {observe: 'response'}).pipe(
      map((response) => this.extractMovieDetails(response.body, response.ok))
    );
  }

  getSeasonEpisodes(imdbId: string, season: number): Observable<any[]> {
    const url = environment.production
      ? `/api/omdb?action=episodes&id=${encodeURIComponent(imdbId)}&season=${season}`
      : `https://www.omdbapi.com/?apikey=${this.API_KEY}&i=${encodeURIComponent(imdbId)}&Season=${season}`;
    return this.http.get<any>(url).pipe(
      map(response => response.Response === 'True' ? response.Episodes : []),
      catchError(() => of([]))
    );
  }

  getImdbId(movieDetails: any): string {
    if (movieDetails && movieDetails.imdbID) {
      return movieDetails.imdbID;
    }
    return '';
  }
  getMediaType(movieDetails: any): string {
    if (movieDetails.Type === 'movie') return 'movie'
    else if (movieDetails.Type === 'series') return 'tv'
    else {
      return 'movie'
    }
  }
  formatMovieDetailsArray(details: any) {
    return [
      { label: 'Director', value: details.Director, show: this.hasValue(details.Director) },
      { label: 'Released', value: details.Released, show: this.hasValue(details.Released) },
      { label: 'Production', value: details.Production, show: this.hasValue(details.Production) },
      { label: 'Country', value: details.Country, show: this.hasValue(details.Country) },
      { label: 'Language', value: details.Language, show: this.hasValue(details.Language) },
      { label: 'Writers', value: details.Writer, show: this.hasValue(details.Writer) },
      { label: 'Stars', value: details.Actors, show: true },
      { label: 'Awards', value: details.Awards, show: this.hasValue(details.Awards) },
      { label: 'Box Office', value: details.BoxOffice, show: this.hasValue(details.BoxOffice) },
    ];
  }

  private buildSearchUrl(searchTerm: string, page: number): string {
    return environment.production
      ? `/api/omdb?action=search&q=${encodeURIComponent(searchTerm)}&page=${page}`
      : `https://www.omdbapi.com/?apikey=${this.API_KEY}&s=${encodeURIComponent(searchTerm)}&page=${page}`;
  }

  private buildDetailsUrl(id: string): string {
    return environment.production
      ? `/api/movie?id=${encodeURIComponent(id)}`
      : `https://www.omdbapi.com/?apikey=${this.API_KEY}&i=${encodeURIComponent(id)}&plot=full`;
  }

  private extractMovieDetails(body: any, isOk: boolean): any {
    if (isOk && body && body.imdbID) {
      return body;
    }

    throw new Error('Invalid API response');
  }

  private resetSearchState(): void {
    this.searchResults.next([]);
    this.totalResultsSource.next(0);
  }

  private resetMovieDetails(): void {
    this.movieDetailsSubject.next({});
  }

  private hasValue(value: string | null | undefined): boolean {
    return !!value && value !== 'N/A';
  }

}
