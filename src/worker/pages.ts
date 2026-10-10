// Port of middleware.js: old-TV routing and link-preview meta injection.
import {
  renderPageMeta,
  fetchMovieMeta,
  fetchPersonMeta,
  fetchMusicMeta,
  isBotUserAgent,
} from '../../lib/page-meta.mjs';
import { callApi } from './api-router';
import type { Env } from './index';

const META_TTL_SECONDS = 3600;

export async function handleSitePage(request: Request, env: Env, ctx: ExecutionContext): Promise<Response | null> {
  const ua = request.headers.get('user-agent') || '';
  const url = new URL(request.url);

  // Old TVs: Tizen, or engines without Proxy (Chrome < 49) -> downleveled /lite bundle.
  const chromeMatch = ua.match(/Chrome\/(\d+)/);
  const isLegacyChrome = chromeMatch && parseInt(chromeMatch[1], 10) < 49;
  if (ua.indexOf('Tizen') !== -1 || isLegacyChrome) {
    const lite = new URL('/lite/index.html', url.origin);
    return env.ASSETS.fetch(new Request(lite, { method: 'GET', headers: request.headers }));
  }

  if (request.method !== 'GET') return null;

  let fetchMeta: ((c: any) => Promise<any>) | null = null;
  const bot = isBotUserAgent(ua);

  const movieMatch = url.pathname.match(/^\/movie\/([^/]+)\/?$/);
  const personMatch = url.pathname.match(/^\/person\/([^/]+)\/?$/);
  const musicMatch = url.pathname.match(/^\/music\/(album|artist|track|playlist|mix)\/([^/]+)\/?$/);
  if (movieMatch) fetchMeta = (c) => fetchMovieMeta(c, url, movieMatch[1]);
  else if (personMatch) fetchMeta = (c) => fetchPersonMeta(c, personMatch[1]);
  else if (musicMatch && bot) fetchMeta = (c) => fetchMusicMeta(c, musicMatch[1], musicMatch[2]);
  if (!fetchMeta) return null;

  // Cache the generated HTML per URL + bot flag so crawlers do not re-hit upstreams.
  const cache = (globalThis as any).caches?.default as Cache | undefined;
  const cacheKey = new Request(url.origin + url.pathname + url.search + (url.search ? '&' : '?') + '__meta=' + (bot ? 'bot' : 'user'));
  try {
    const hit = await cache?.match(cacheKey);
    if (hit) return hit;
  } catch {
    /* cache is best-effort */
  }

  const mctx = {
    api: (path: string) => callApi(new Request(new URL(path, url.origin), { headers: request.headers })),
    tmdbKey: (env as any).TMDB_API_KEY as string | undefined,
    getIndexHtml: async () => {
      const r = await env.ASSETS.fetch(new Request(new URL('/index.html', url.origin)));
      return r.ok ? r.text() : null;
    },
  };

  const html = await renderPageMeta(mctx, url, () => fetchMeta!(mctx));
  if (!html) return null;

  const response = new Response(html, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': `public, s-maxage=${META_TTL_SECONDS}, stale-while-revalidate=86400`,
    },
  });
  if (cache) ctx.waitUntil(cache.put(cacheKey, response.clone()).catch(() => {}));
  return response;
}
