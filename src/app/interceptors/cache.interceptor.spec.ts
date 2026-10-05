import { TestBed } from '@angular/core/testing';
import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { CACHE_MAX_ENTRIES, cacheInterceptor, clearHttpCache } from './cache.interceptor';

describe('cacheInterceptor', () => {
  let http: HttpClient;
  let ctrl: HttpTestingController;

  beforeEach(() => {
    clearHttpCache();
    TestBed.configureTestingModule({
      providers: [provideHttpClient(withInterceptors([cacheInterceptor])), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpClient);
    ctrl = TestBed.inject(HttpTestingController);
  });

  it('serves a repeat GET from memory', () => {
    http.get('/api/tmdb?list=trending').subscribe();
    ctrl.expectOne('/api/tmdb?list=trending').flush({ movies: [{ Title: 'A' }] });
    let body: any;
    http.get('/api/tmdb?list=trending').subscribe(b => (body = b));
    ctrl.expectNone('/api/tmdb?list=trending');
    expect(body.movies.length).toBe(1);
  });

  it('collapses concurrent identical requests into one', () => {
    const seen: unknown[] = [];
    http.get('/api/movie?id=tt1').subscribe(b => seen.push(b));
    http.get('/api/movie?id=tt1').subscribe(b => seen.push(b));
    ctrl.expectOne('/api/movie?id=tt1').flush({ Title: 'A' });
    expect(seen.length).toBe(2);
  });

  it('does not cache empty lists or error bodies', () => {
    http.get('/api/tmdb?list=popular').subscribe();
    ctrl.expectOne('/api/tmdb?list=popular').flush({ movies: [] });
    http.get('/api/tmdb?list=popular').subscribe();
    ctrl.expectOne('/api/tmdb?list=popular').flush({ movies: [{ Title: 'A' }] });

    http.get('/api/movie?id=tt2').subscribe();
    ctrl.expectOne('/api/movie?id=tt2').flush({ Response: 'False', error: 'x' });
    http.get('/api/movie?id=tt2').subscribe();
    ctrl.expectOne('/api/movie?id=tt2').flush({ Title: 'B' });
  });

  it('does not cache failed requests', () => {
    http.get('/api/movie?id=tt3').subscribe({ error: () => {} });
    ctrl.expectOne('/api/movie?id=tt3').flush('boom', { status: 500, statusText: 'err' });
    http.get('/api/movie?id=tt3').subscribe();
    ctrl.expectOne('/api/movie?id=tt3').flush({ Title: 'C' });
  });

  it('is bounded and evicts the least recently used entry', () => {
    for (let i = 0; i <= CACHE_MAX_ENTRIES; i++) {
      http.get(`/api/movie?id=${i}`).subscribe();
      ctrl.expectOne(`/api/movie?id=${i}`).flush({ Title: String(i) });
    }
    http.get('/api/movie?id=0').subscribe(); // evicted -> refetched
    ctrl.expectOne('/api/movie?id=0').flush({ Title: '0' });
    http.get(`/api/movie?id=${CACHE_MAX_ENTRIES}`).subscribe(); // newest -> cached
    ctrl.expectNone(`/api/movie?id=${CACHE_MAX_ENTRIES}`);
    ctrl.verify();
  });
});
