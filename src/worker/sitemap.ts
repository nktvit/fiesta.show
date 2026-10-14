// /sitemap.xml, built on request: the static pages plus the films currently in TMDB's lists, so
// it follows what the site actually features. Cached for an hour; TMDB being down only drops the
// film entries.
const ORIGIN = 'https://fiesta.show';
const STATIC_PAGES = ['/', '/top-rated', '/tv', '/music', '/about', '/terms'];
const LISTS = ['/trending/movie/week', '/movie/popular', '/movie/top_rated', '/movie/now_playing', '/movie/upcoming'];
const TTL_SECONDS = 3600;

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function movieIds(tmdbKey: string | undefined): Promise<number[]> {
  if (!tmdbKey) return [];
  const pages = await Promise.all(
    LISTS.flatMap((l) => [1, 2].map((page) =>
      fetch(`https://api.themoviedb.org/3${l}?api_key=${tmdbKey}&language=en-US&page=${page}`, { signal: AbortSignal.timeout(4000) })
        .then((r) => (r.ok ? r.json() : { results: [] }))
        .catch(() => ({ results: [] })) as Promise<{ results?: { id: number }[] }>,
    )),
  );
  return [...new Set(pages.flatMap((p) => (p.results ?? []).map((m) => m.id)))];
}

export async function sitemapResponse(request: Request, env: { TMDB_API_KEY?: unknown }, ctx: ExecutionContext): Promise<Response> {
  const cache = (globalThis as any).caches?.default as Cache | undefined;
  const key = new Request(new URL(request.url).origin + '/__sitemap');
  try {
    const hit = await cache?.match(key);
    if (hit) return hit;
  } catch {
    /* best-effort */
  }
  const ids = await movieIds(env.TMDB_API_KEY as string | undefined);
  const urls = [...STATIC_PAGES.map((p) => ORIGIN + p), ...ids.map((id) => `${ORIGIN}/movie/${id}`)];
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    urls.map((u) => `  <url><loc>${esc(u)}</loc></url>`).join('\n') + `\n</urlset>\n`;
  const res = new Response(xml, {
    headers: { 'content-type': 'application/xml; charset=utf-8', 'cache-control': `public, max-age=${TTL_SECONDS}` },
  });
  // Do not pin a degraded (static-only) answer for an hour.
  if (cache && ids.length) ctx.waitUntil(cache.put(key, res.clone()).catch(() => {}));
  return res;
}
