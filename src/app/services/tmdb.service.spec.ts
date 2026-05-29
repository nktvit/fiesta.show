import { TestBed } from '@angular/core/testing';
import { HttpClientTestingModule, HttpTestingController } from '@angular/common/http/testing';

import { TmdbService } from './tmdb.service';
import { LoggerService } from './logger.service';

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

  it('marks TV recommendations as TV so poster links keep the type hint', () => {
    let recommendations: any[] = [];

    service.getRecommendations(1399, 'tv').subscribe(result => {
      recommendations = result;
    });

    const req = httpMock.expectOne(request =>
      request.urlWithParams.startsWith('https://api.themoviedb.org/3/tv/1399/recommendations?')
    );
    expect(req.request.method).toBe('GET');

    req.flush({
      results: [{
        id: 66732,
        name: 'Stranger Things',
        first_air_date: '2016-07-15',
        poster_path: '/poster.jpg',
        backdrop_path: '/backdrop.jpg',
        overview: 'A mystery series.',
        vote_average: 8.6,
        vote_count: 1000
      }]
    });

    expect(recommendations[0]).toEqual(jasmine.objectContaining({
      tmdbId: 66732,
      mediaType: 'tv',
      Title: 'Stranger Things'
    }));
  });

  it('resolves TV TMDB IDs through TV external IDs before movie IDs', () => {
    let imdbId = '';

    service.getImdbId(1399, 'tv').subscribe(result => {
      imdbId = result;
    });

    const req = httpMock.expectOne(request =>
      request.urlWithParams.startsWith('https://api.themoviedb.org/3/tv/1399/external_ids?')
    );
    expect(req.request.method).toBe('GET');
    req.flush({ imdb_id: 'tt0944947' });

    expect(imdbId).toBe('tt0944947');
  });
});
