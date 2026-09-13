import { TestBed } from '@angular/core/testing';
import { HttpClientTestingModule, HttpTestingController } from '@angular/common/http/testing';

import { MovieService } from './movie.service';
import { LoggerService } from './logger.service';

describe('MovieService', () => {
  let service: MovieService;
  let httpMock: HttpTestingController;
  let logger: jasmine.SpyObj<LoggerService>;

  beforeEach(() => {
    logger = jasmine.createSpyObj<LoggerService>('LoggerService', ['log', 'error']);

    TestBed.configureTestingModule({
      imports: [HttpClientTestingModule],
      providers: [
        MovieService,
        { provide: LoggerService, useValue: logger }
      ]
    });

    service = TestBed.inject(MovieService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    httpMock.verify();
  });

  it('updates search state from a successful search response', () => {
    let responseBody: any;

    service.searchMovies('matrix', 3).subscribe(response => {
      responseBody = response;
    });

    const req = httpMock.expectOne('https://www.omdbapi.com/?apikey=a1128251&s=matrix&page=3');
    expect(req.request.method).toBe('GET');

    req.flush({
      Search: [{ imdbID: 'tt0133093', Title: 'The Matrix' }],
      totalResults: '42',
      Response: 'True'
    });

    expect(responseBody.Search.length).toBe(1);
    expect(service.currentQuery).toBe('matrix');
    expect(service['searchResults'].value).toEqual([{ imdbID: 'tt0133093', Title: 'The Matrix' }]);
    expect(service['currentPageSource'].value).toBe(3);
    expect(service['totalResultsSource'].value).toBe(42);
  });

  it('clears search state when the API response has no results', () => {
    service['searchResults'].next([{ imdbID: 'existing' }]);
    service['totalResultsSource'].next(10);

    service.searchMovies('missing').subscribe();

    const req = httpMock.expectOne('https://www.omdbapi.com/?apikey=a1128251&s=missing&page=1');
    req.flush({ Response: 'False', Error: 'Movie not found!' });

    expect(service['searchResults'].value).toEqual([]);
    expect(service['totalResultsSource'].value).toBe(0);
  });

  it('returns null and clears search results when search fails', () => {
    let responseBody: any = 'unset';

    service['searchResults'].next([{ imdbID: 'existing' }]);

    service.searchMovies('broken').subscribe(response => {
      responseBody = response;
    });

    const req = httpMock.expectOne('https://www.omdbapi.com/?apikey=a1128251&s=broken&page=1');
    req.flush('network error', { status: 500, statusText: 'Server Error' });

    expect(responseBody).toBeNull();
    expect(service['searchResults'].value).toEqual([]);
    expect(logger.error).toHaveBeenCalled();
  });

  it('publishes movie details exactly once for a valid details response', () => {
    const nextSpy = spyOn(service['movieDetailsSubject'], 'next').and.callThrough();
    let responseBody: any;

    service.getMovieDetails('tt0133093').subscribe(response => {
      responseBody = response;
    });

    const req = httpMock.expectOne('https://www.omdbapi.com/?apikey=a1128251&i=tt0133093&plot=full');
    expect(req.request.method).toBe('GET');
    req.flush(
      { imdbID: 'tt0133093', Title: 'The Matrix', Type: 'movie' },
      { status: 200, statusText: 'OK' }
    );

    expect(responseBody).toEqual({ imdbID: 'tt0133093', Title: 'The Matrix', Type: 'movie' });
    expect(service['movieDetailsSubject'].value).toEqual({
      imdbID: 'tt0133093',
      Title: 'The Matrix',
      Type: 'movie'
    });
    expect(nextSpy.calls.allArgs()).toEqual([
      [{ imdbID: 'tt0133093', Title: 'The Matrix', Type: 'movie' }]
    ]);
  });

  it('returns null and resets details when the details response is invalid', () => {
    let responseBody: any = 'unset';

    service['movieDetailsSubject'].next({ imdbID: 'existing' });

    service.getMovieDetails('tt0133093').subscribe(response => {
      responseBody = response;
    });

    const req = httpMock.expectOne('https://www.omdbapi.com/?apikey=a1128251&i=tt0133093&plot=full');
    req.flush({ Title: 'Missing imdbID' }, { status: 200, statusText: 'OK' });

    expect(responseBody).toBeNull();
    expect(service['movieDetailsSubject'].value).toEqual({});
    expect(logger.error).toHaveBeenCalled();
  });

  it('maps helpers for media type and formatted details consistently', () => {
    expect(service.getImdbId({ imdbID: 'tt0133093' })).toBe('tt0133093');
    expect(service.getImdbId({})).toBe('');

    expect(service.getMediaType({ Type: 'movie' })).toBe('movie');
    expect(service.getMediaType({ Type: 'series' })).toBe('tv');
    expect(service.getMediaType({ Type: 'game' })).toBe('movie');

    expect(
      service.formatMovieDetailsArray({
        Director: 'Lana Wachowski, Lilly Wachowski',
        Released: '31 Mar 1999',
        Production: 'N/A',
        Country: 'USA',
        Language: 'English',
        Writer: 'The Wachowskis',
        Actors: 'Keanu Reeves',
        Awards: '4 Oscars',
        BoxOffice: '$172,076,928'
      })
      // Director and Stars are intentionally NOT in this list — the Cast & Crew
      // section renders both from TMDB, so repeating them here was duplication.
    ).toEqual([
      { label: 'Released', value: '31 Mar 1999', show: true },
      { label: 'Production', value: 'N/A', show: false },
      { label: 'Country', value: 'USA', show: true },
      { label: 'Language', value: 'English', show: true },
      { label: 'Writers', value: 'The Wachowskis', show: true },
      { label: 'Awards', value: '4 Oscars', show: true },
      { label: 'Box Office', value: '$172,076,928', show: true }
    ]);
  });
});
