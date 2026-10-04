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

  describe('getTVDetails', () => {
    function load(tmdbId: number, body: object) {
      let result: any;
      service.getTVDetails(tmdbId).subscribe(r => (result = r));
      httpMock
        .expectOne(r => r.urlWithParams.startsWith(`https://api.themoviedb.org/3/tv/${tmdbId}?`))
        .flush(body);
      return result;
    }

    it('skips announced seasons that have no episodes yet (Rick and Morty season 10)', () => {
      const result = load(60625, {
        number_of_seasons: 10,
        seasons: [
          { season_number: 0, name: 'Specials', episode_count: 5 },
          { season_number: 8, name: 'Season 8', episode_count: 10 },
          { season_number: 9, name: 'Season 9', episode_count: 10 },
          { season_number: 10, name: 'Season 10', episode_count: 0 },
        ],
      });

      expect(result.seasons.map((s: any) => s.number)).toEqual([8, 9]);
      expect(result.totalSeasons).toBe(9);
    });

    it('keeps every season when TMDB has no episode counts at all (brand-new show)', () => {
      const result = load(1, {
        number_of_seasons: 1,
        seasons: [{ season_number: 1, name: 'Season 1', episode_count: 0 }],
      });

      expect(result.seasons.map((s: any) => s.number)).toEqual([1]);
      expect(result.totalSeasons).toBe(1);
    });
  });
});
