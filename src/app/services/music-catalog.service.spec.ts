import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { MusicCatalogService } from './music-catalog.service';

describe('MusicCatalogService', () => {
  let svc: MusicCatalogService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    svc = TestBed.inject(MusicCatalogService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  const expectGet = (action: string, params: Record<string, string>) => {
    const req = http.expectOne((r) => r.url === '/api/music' && r.params.get('action') === action);
    for (const [k, v] of Object.entries(params)) expect(req.request.params.get(k)).toBe(v);
    return req;
  };

  it('suggest sends the query', () => {
    svc.suggest('daft').subscribe((r) => expect(r.terms).toEqual(['Daft Punk']));
    expectGet('suggest', { q: 'daft' }).flush({ terms: ['Daft Punk'], tracks: [], albums: [], artists: [] });
  });

  it('a newer suggest request can cancel the older one', () => {
    const sub = svc.suggest('da').subscribe();
    const req = http.expectOne((r) => r.params.get('q') === 'da');
    sub.unsubscribe();
    expect(req.cancelled).toBeTrue();
  });

  it('searchType pages with offset and limit', () => {
    svc.searchType('x', 'albums', 20, 20).subscribe();
    expectGet('search-type', { q: 'x', type: 'albums', offset: '20', limit: '20' }).flush({ items: [], total: 0 });
  });

  it('joins ids for the batch track lookup', () => {
    svc.tracks([1, 2, 3]).subscribe();
    expectGet('tracks', { ids: '1,2,3' }).flush([]);
  });

  it('artistAlbums passes the filter', () => {
    svc.artistAlbums(8847, 'EPSANDSINGLES', 30, 30).subscribe();
    expectGet('artist-albums', { id: '8847', filter: 'EPSANDSINGLES', offset: '30', limit: '30' }).flush({ items: [], total: 0 });
  });

  it('aoty passes title and artist and tolerates null', () => {
    let got: unknown = 'unset';
    svc.aoty('Discovery', 'Daft Punk').subscribe((r) => (got = r));
    expectGet('aoty', { title: 'Discovery', artist: 'Daft Punk' }).flush(null);
    expect(got).toBeNull();
  });
});
