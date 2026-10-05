import { HttpInterceptorFn, HttpRequest, HttpResponse } from '@angular/common/http';
import { Observable, finalize, of, shareReplay, tap } from 'rxjs';

/** Upper bound on entries kept in memory (least recently used is evicted first). */
export const CACHE_MAX_ENTRIES = 300;
/** Longest an entry may live, even for endpoints whose data effectively never changes. */
const MAX_AGE_MS = 60 * 60 * 1000;

const cache = new Map<string, { response: HttpResponse<unknown>; expires: number }>();
const inflight = new Map<string, Observable<unknown>>();

/** Drops cached responses (all, or those whose URL contains `match`). Used by Music Settings → System. */
export function clearHttpCache(match?: string): number {
  let n = 0;
  if (!match) inflight.clear();
  for (const key of [...cache.keys()]) {
    if (!match || key.includes(match)) {
      cache.delete(key);
      n++;
    }
  }
  return n;
}

// /api/music: streams and personal calls are never cached; search-ish results
// briefly; catalogue pages for half an hour.
function musicCacheDuration(action: string | null): number {
  switch (action) {
    case 'manifest':
    case 'seg':
    case 'img':
    case 'lastfm':
      return 0;
    case 'search':
    case 'suggest':
    case 'search-type':
      return 300000;
    default:
      return 1800000;
  }
}

function getCacheDuration(req: HttpRequest<unknown>): number {
  const url = req.url;
  if (url.includes('/api/music')) return musicCacheDuration(req.params.get('action'));
  if (url.includes('/api/movie')) return MAX_AGE_MS;
  if (url.includes('/api/omdb')) return MAX_AGE_MS;
  if (url.includes('omdbapi.com')) return MAX_AGE_MS;
  if (url.includes('/api/tmdb') || url.includes('api.themoviedb.org')) return 600000;
  if (url.includes('/api/suggestions')) return 300000;
  return 0; // don't cache
}

/** Keep an error body or an empty result from sticking for the whole TTL. */
function isCacheable(res: HttpResponse<unknown>): boolean {
  if (res.status !== 200 || res.body == null) return false;
  if (typeof res.body !== 'object') return true;
  if (Array.isArray(res.body)) return res.body.length > 0;
  const body = res.body as Record<string, unknown>;
  if (body['error'] || body['Response'] === 'False') return false;
  // list endpoints: { movies: [] }, { Search: [] }, { results: [] } ...
  const lists = Object.values(body).filter(Array.isArray) as unknown[][];
  return lists.length === 0 || lists.some((l) => l.length > 0);
}

function store(key: string, response: HttpResponse<unknown>, ttl: number) {
  cache.delete(key); // re-insert so Map order == recency
  cache.set(key, { response, expires: Date.now() + ttl });
  while (cache.size > CACHE_MAX_ENTRIES) {
    cache.delete(cache.keys().next().value as string);
  }
}

export const cacheInterceptor: HttpInterceptorFn = (req, next) => {
  if (req.method !== 'GET') return next(req);

  const ttl = getCacheDuration(req);
  if (ttl === 0) return next(req);

  const key = req.urlWithParams;
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    if (hit.expires > Date.now()) {
      cache.set(key, hit); // LRU touch
      return of(hit.response.clone());
    }
  }

  // Collapse concurrent identical requests (e.g. many cards asking for the same title).
  const pending = inflight.get(key);
  if (pending) return pending as Observable<never>;

  const shared = next(req).pipe(
    tap((event) => {
      if (event instanceof HttpResponse && isCacheable(event)) store(key, event.clone(), ttl);
    }),
    finalize(() => inflight.delete(key)),
    shareReplay({ bufferSize: 1, refCount: false }),
  );
  inflight.set(key, shared);
  return shared;
};
