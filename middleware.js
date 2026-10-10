// Vercel Routing Middleware — runs before the CDN cache/static-file layer,
// unlike a declarative vercel.json `has`-conditioned rewrite (which loses to
// a literal static file match, e.g. "/" resolving straight to the built
// index.html before rewrites are ever consulted). This is what actually lets
// old-TV routing apply to the root path too.
import { rewrite, next } from '@vercel/functions';
import { renderPageMeta, fetchMovieMeta, fetchPersonMeta, fetchMusicMeta, isBotUserAgent } from './lib/page-meta.mjs';

export default async function middleware(request) {
  const ua = request.headers.get('user-agent') || '';
  const url = new URL(request.url);
  const ctx = {
    api: (path) => fetch(new URL(path, url.origin)),
    tmdbKey: process.env.TMDB_API_KEY,
    getIndexHtml: async () => {
      const r = await fetch(new URL('/index.html', url.origin));
      return r.ok ? r.text() : null;
    },
  };
  const htmlResponse = (html) =>
    new Response(html, {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 's-maxage=3600, stale-while-revalidate=86400',
      },
    });

  // Tizen catches known Samsung TV UAs directly. But any OTHER engine old
  // enough to lack Proxy (added in Chrome 49) hits the same wall — Zone.js
  // needs it — regardless of what brand string the device reports (old
  // Android TV boxes, other smart-TV browsers, etc. often carry a bare old
  // Chrome/Chromium version with no TV-specific token at all). Route both
  // to the same downleveled /lite bundle, which is explicitly built for
  // Chrome 47+ (see tv/babel.config.js) so anything at or above that floor
  // already works there.
  const chromeMatch = ua.match(/Chrome\/(\d+)/);
  const isLegacyChrome = chromeMatch && parseInt(chromeMatch[1], 10) < 49;
  if (ua.indexOf('Tizen') !== -1 || isLegacyChrome) {
    url.pathname = '/lite/index.html';
    return rewrite(url);
  }

  // Angular is CSR-only, so link-preview crawlers (iMessage, Slack, Discord,
  // Facebook, ...) never run the JS that fills in the real title/poster via
  // Title/Meta — they only ever see index.html's static generic tags. This
  // only fires on a fresh server hit to a movie/show/person page (SPA in-app
  // navigation never re-requests index.html), so it doesn't touch normal
  // client-side routing.
  if (request.method === 'GET') {
    const movieMatch = url.pathname.match(/^\/movie\/([^/]+)\/?$/);
    if (movieMatch) {
      const rendered = await renderPageMeta(ctx, url, () => fetchMovieMeta(ctx, url, movieMatch[1]));
      if (rendered) return htmlResponse(rendered);
    }

    const personMatch = url.pathname.match(/^\/person\/([^/]+)\/?$/);
    if (personMatch) {
      const rendered = await renderPageMeta(ctx, url, () => fetchPersonMeta(ctx, personMatch[1]));
      if (rendered) return htmlResponse(rendered);
    }

    // Music pages (/music/album|artist|track|playlist|mix/:id): bots only, since
    // real visitors get the Angular page and set their own title client-side.
    const musicMatch = url.pathname.match(/^\/music\/(album|artist|track|playlist|mix)\/([^/]+)\/?$/);
    if (musicMatch && isBotUserAgent(ua)) {
      const rendered = await renderPageMeta(ctx, url, () => fetchMusicMeta(ctx, musicMatch[1], musicMatch[2]));
      if (rendered) return htmlResponse(rendered);
    }
  }

  return next();
}

export const config = {
  // Edge is deprecated for Routing Middleware in favor of Fluid Compute; the
  // handful of fetch()/env var calls here run just as well on Node.js.
  runtime: 'nodejs',
  // Everything except the lite app's own assets and the /api/* functions —
  // both already serve the right thing regardless of User-Agent.
  matcher: ['/((?!lite/|api/).*)'],
};
