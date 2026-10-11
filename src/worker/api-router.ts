import { runHandler } from './node-compat';
import movie from '../../api/movie.js';
import omdb from '../../api/omdb.js';
import tmdb from '../../api/tmdb.js';
import subs from '../../api/subs.js';
import suggestions from '../../api/suggestions.js';
import stream from '../../api/stream.js';
import likes from '../../api/likes.js';
import comments from '../../api/comments.js';
import music from '../../api/music.js';

const API: Record<string, (req: any, res: any) => unknown> = {
  movie, omdb, tmdb, subs, suggestions, stream, likes, comments, music,
};

/** GETs whose handler sets a long s-maxage and whose upstream (OMDB) can be very slow: cache at the edge. */
const EDGE_CACHED = new Set(['movie']);

/**
 * Call an /api/<name> handler in-process (no subrequest to ourselves). Workers do not honour a
 * handler's `s-maxage` by themselves, so EDGE_CACHED responses are stored in the Cache API for it.
 */
export async function callApi(request: Request, ctx?: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const name = url.pathname.replace(/^\/api\//, '').replace(/\/$/, '');
  const handler = Object.prototype.hasOwnProperty.call(API, name) ? API[name] : null;
  if (!handler) {
    return new Response(JSON.stringify({ error: 'not_found' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  }
  const cache = request.method === 'GET' && EDGE_CACHED.has(name) ? ((globalThis as any).caches?.default as Cache | undefined) : undefined;
  const key = cache ? new Request(url.origin + '/__apicache' + url.pathname + url.search) : null;
  if (cache && key) {
    try {
      const hit = await cache.match(key);
      if (hit) return hit;
    } catch {
      /* best-effort */
    }
  }
  const res = await runHandler(handler, request);
  if (cache && key && res.status === 200) {
    const ttl = Number(/s-maxage=(\d+)/.exec(res.headers.get('cache-control') || '')?.[1] || 0);
    if (ttl > 0) {
      const copy = new Response(res.clone().body, res);
      copy.headers.set('cache-control', `public, max-age=${ttl}`);
      const put = cache.put(key, copy).catch(() => {});
      if (ctx) ctx.waitUntil(put);
      else await put;
    }
  }
  return res;
}
