import { TestBed } from '@angular/core/testing';
import { HttpClientTestingModule, HttpTestingController } from '@angular/common/http/testing';
import { Observable } from 'rxjs';

import { TmdbService } from './tmdb.service';
import { LoggerService } from './logger.service';

/**
 * TmdbService is a thin client over api/tmdb.js: every call is one /api/tmdb
 * request (dev reaches it through the proxy to the local API harness, see
 * README), so these specs pin the exact request URLs and the response mapping.
 */
describe('TmdbService', () => {
  let service: TmdbService;
  let httpMock: HttpTestingController;
  let logger: jasmine.SpyObj<LoggerService>;

  beforeEach(() => {
    logger = jasmine.createSpyObj<LoggerService>('LoggerService', ['log', 'error']);

    TestBed.configureTestingModule({
      imports: [HttpClientTestingModule],
      providers: [
        TmdbService,
        { provide: LoggerService, useValue: logger }
      ]
    });

    service = TestBed.inject(TmdbService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    httpMock.verify();
  });

  /** Subscribes, asserts the single request URL, answers it, returns the emitted value. */
  function call<T>(source: Observable<T>, url: string, body: any): T {
    let result!: T;
    source.subscribe(r => (result = r));
    const req = httpMock.expectOne(url);
    expect(req.request.method).toBe('GET');
    req.flush(body);
    return result;
  }

  it('fetches the home lists through /api/tmdb and unwraps `movies`', () => {
    const movies = [{ tmdbId: 1, Title: 'A' }];
    expect(call(service.getTrending(), '/api/tmdb?list=trending', { movies })).toEqual(movies as any);
    expect(call(service.getNowPlaying(), '/api/tmdb?list=now_playing', { movies })).toEqual(movies as any);
    expect(call(service.getPopular(), '/api/tmdb?list=popular', { movies })).toEqual(movies as any);
    expect(call(service.getTopRated(), '/api/tmdb?list=top_rated', { movies })).toEqual(movies as any);
    expect(call(service.getTrendingTV(), '/api/tmdb?list=trending_tv', { movies })).toEqual(movies as any);
  });

  it('shares one request per list (shareReplay cache)', () => {
    let first: any, second: any;
    service.getTrending().subscribe(r => (first = r));
    service.getTrending().subscribe(r => (second = r));
    httpMock.expectOne('/api/tmdb?list=trending').flush({ movies: [{ tmdbId: 7 }] });
    expect(first).toEqual([{ tmdbId: 7 }] as any);
    expect(second).toEqual(first);
  });

  it('returns an empty list and logs when a list request fails', () => {
    let result: any = 'unset';
    service.getPopular().subscribe(r => (result = r));
    httpMock.expectOne('/api/tmdb?list=popular').flush('boom', { status: 500, statusText: 'Server Error' });
    expect(result).toEqual([]);
    expect(logger.error).toHaveBeenCalled();
  });

  it('requests TV recommendations with the TV media type (poster links keep the hint)', () => {
    const movies = [{ tmdbId: 66732, mediaType: 'tv', Title: 'Stranger Things' }];
    const result = call(service.getRecommendations(1399, 'tv'), '/api/tmdb?list=recommendations&id=1399&type=tv', { movies });
    expect(result).toEqual(movies as any);
    // anything but 'tv' is a movie
    call(service.getRecommendations(603), '/api/tmdb?list=recommendations&id=603&type=movie', { movies: [] });
  });

  it('resolves a TMDB id to an IMDB id, forwarding the type hint when given', () => {
    expect(call(service.getImdbId(1399, 'tv'), '/api/tmdb?list=movie&id=1399&type=tv', { imdbID: 'tt0944947' })).toBe('tt0944947');
    expect(call(service.getImdbId(603), '/api/tmdb?list=movie&id=603', { imdbID: 'tt0133093' })).toBe('tt0133093');
    expect(call(service.getImdbId(5), '/api/tmdb?list=movie&id=5', {})).toBe('');
  });

  it('maps the find lookup to absolute poster and backdrop URLs', () => {
    const result = call(service.findByImdbId('tt0133093'), '/api/tmdb?list=find&id=tt0133093', {
      tmdbId: 603, poster: '/p.jpg', backdrop: '/b.jpg', overview: 'o', rating: 8.2, releaseDate: '1999-03-30',
    });
    expect(result).toEqual({
      id: 603,
      poster: 'https://image.tmdb.org/t/p/w342/p.jpg',
      backdrop: 'https://image.tmdb.org/t/p/w1280/b.jpg',
      overview: 'o', rating: 8.2, releaseDate: '1999-03-30',
    });
    expect(call(service.findByImdbId('tt0'), '/api/tmdb?list=find&id=tt0', { tmdbId: null })).toBeNull();
    expect(call(service.findTmdbId('tt1'), '/api/tmdb?list=find&id=tt1', { tmdbId: 9 })).toBe(9);
  });

  it('passes TV details and episodes through (season filtering is server-side)', () => {
    const details = { totalSeasons: 9, seasons: [{ number: 8, name: 'Season 8', episodeCount: 10 }] };
    expect(call(service.getTVDetails(60625), '/api/tmdb?list=tv_details&id=60625', details)).toEqual(details);
    expect(call(service.getTVSeasonEpisodes(60625, 2), '/api/tmdb?list=tv_episodes&id=60625&season=2', { episodes: [{ number: 1 }] }))
      .toEqual([{ number: 1 }]);
  });

  it('falls back to empty TV details when the request fails', () => {
    let result: any;
    service.getTVDetails(1).subscribe(r => (result = r));
    httpMock.expectOne('/api/tmdb?list=tv_details&id=1').error(new ProgressEvent('error'));
    expect(result).toEqual({ totalSeasons: 0, seasons: [] });
  });

  it('requests trailers, credits and genres', () => {
    expect(call(service.getTrailerKey(603), '/api/tmdb?list=videos&id=603&type=movie', { trailerKey: 'abc' })).toBe('abc');
    expect(call(service.getTrailerKey(1399, 'tv'), '/api/tmdb?list=videos&id=1399&type=tv', { trailerKey: null })).toBeNull();
    expect(call(service.getCredits(603), '/api/tmdb?list=credits&id=603&type=movie', { cast: [{ id: 1 }], directors: [{ id: 2 }] }))
      .toEqual({ cast: [{ id: 1 }], directors: [{ id: 2 }] } as any);
    expect(call(service.getCredits(603, 'tv'), '/api/tmdb?list=credits&id=603&type=tv', {})).toEqual({ cast: [], directors: [] });
    expect(call(service.getGenres(), '/api/tmdb?list=genres', { genres: [{ id: 28, name: 'Action' }] })).toEqual([{ id: 28, name: 'Action' }]);
  });

  it('pages through discover, upcoming, popular TV and top rated', () => {
    const body = { movies: [{ tmdbId: 1 }], totalPages: 5 };
    const expected = { movies: [{ tmdbId: 1 }], totalPages: 5 } as any;
    expect(call(service.discoverByGenre(28, 3), '/api/tmdb?list=discover&genre=28&page=3', body)).toEqual(expected);
    expect(call(service.getUpcoming(2), '/api/tmdb?list=upcoming&page=2', body)).toEqual(expected);
    expect(call(service.getPopularTV(4), '/api/tmdb?list=popular_tv&page=4', body)).toEqual(expected);
    expect(call(service.getTopRatedPaginated(6), '/api/tmdb?list=top_rated&page=6', body)).toEqual(expected);
    expect(call(service.getUpcoming(), '/api/tmdb?list=upcoming&page=1', {})).toEqual({ movies: [], totalPages: 0 });
  });

  it('searches people only for terms of 2+ characters and encodes the query', () => {
    let skipped: any;
    service.searchPeople(' a ').subscribe(r => (skipped = r));
    expect(skipped).toEqual([]);
    const people = [{ id: 1, name: 'Keanu Reeves' }];
    expect(call(service.searchPeople(' keanu r '), '/api/tmdb?list=search_person&query=keanu%20r', { people })).toEqual(people as any);
  });

  it('fills defaults on a person response from an older API and maps a miss to null', () => {
    const person = call(service.getPerson(6384), '/api/tmdb?list=person&id=6384', {
      id: 6384, name: 'Keanu Reeves', credits: [{ tmdbId: 1 }],
    });
    expect(person).toEqual(jasmine.objectContaining({
      id: 6384,
      credits: [{ tmdbId: 1 }],
      actingCredits: [{ tmdbId: 1 }],
      crewCredits: [],
    }));
    expect(call(service.getPerson(1), '/api/tmdb?list=person&id=1', { error: 'Person not found' })).toBeNull();
  });
});
