import { HttpInterceptorFn, HttpRequest, HttpResponse } from '@angular/common/http';
import { of, tap } from 'rxjs';

const cache = new Map<string, { response: HttpResponse<unknown>; timestamp: number }>();

/** Drops cached responses (all, or those whose URL contains `match`). Used by Music Settings → System. */
export function clearHttpCache(match?: string): number {
  let n = 0;
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
  if (url.includes('/api/movie')) return Infinity;
  if (url.includes('/api/omdb')) return Infinity;
  if (url.includes('omdbapi.com')) return Infinity;
  if (url.includes('/api/tmdb') || url.includes('api.themoviedb.org')) return 600000;
  if (url.includes('/api/suggestions')) return 300000;
  return 0; // don't cache
}

export const cacheInterceptor: HttpInterceptorFn = (req, next) => {
  if (req.method !== 'GET') return next(req);

  const duration = getCacheDuration(req);
  if (duration === 0) return next(req);

  const cached = cache.get(req.urlWithParams);
  if (cached) {
    const age = Date.now() - cached.timestamp;
    if (duration === Infinity || age < duration) {
      return of(cached.response.clone());
    }
    cache.delete(req.urlWithParams);
  }

  return next(req).pipe(
    tap(event => {
      if (event instanceof HttpResponse) {
        cache.set(req.urlWithParams, { response: event.clone(), timestamp: Date.now() });
      }
    })
  );
};
