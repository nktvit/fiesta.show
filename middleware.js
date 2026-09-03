// Vercel Routing Middleware — runs before the CDN cache/static-file layer,
// unlike a declarative vercel.json `has`-conditioned rewrite (which loses to
// a literal static file match, e.g. "/" resolving straight to the built
// index.html before rewrites are ever consulted). This is what actually lets
// old-TV routing apply to the root path too.
import { rewrite, next } from '@vercel/functions';

export default async function middleware(request) {
  const ua = request.headers.get('user-agent') || '';
  const url = new URL(request.url);

  if (ua.indexOf('Tizen') !== -1) {
    url.pathname = '/lite/index.html';
    return rewrite(url);
  }

  // Angular is CSR-only, so link-preview crawlers (iMessage, Slack, Discord,
  // Facebook, ...) never run the JS that fills in the real title/poster via
  // Title/Meta — they only ever see index.html's static generic tags. This
  // only fires on a fresh server hit to a movie/show page (SPA in-app
  // navigation never re-requests index.html), so it doesn't touch normal
  // client-side routing.
  if (request.method === 'GET') {
    const movieMatch = url.pathname.match(/^\/movie\/([^/]+)\/?$/);
    if (movieMatch) {
      const rendered = await renderMovieMeta(url, movieMatch[1]);
      if (rendered) return rendered;
    }
  }

  return next();
}

async function renderMovieMeta(url, rawId) {
  try {
    const meta = await fetchMovieMeta(url, rawId);
    if (!meta) return null;

    const htmlRes = await fetch(new URL('/index.html', url.origin));
    if (!htmlRes.ok) return null;

    const html = injectMeta(await htmlRes.text(), meta, url);

    return new Response(html, {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 's-maxage=3600, stale-while-revalidate=86400',
      },
    });
  } catch {
    return null;
  }
}

async function fetchMovieMeta(url, rawId) {
  if (/^tt\d+$/.test(rawId)) {
    const res = await fetch(new URL('/api/movie?id=' + rawId, url.origin));
    if (!res.ok) return null;
    const data = await res.json();
    if (data.Response === 'False' || !data.Title || data.Title === 'N/A') return null;

    return {
      title: data.Title,
      year: data.Year && data.Year !== 'N/A' ? data.Year : null,
      plot: data.Plot && data.Plot !== 'N/A' ? data.Plot : null,
      image: data._backdrop || (data.Poster && data.Poster !== 'N/A' ? data.Poster : null),
    };
  }

  if (/^\d+$/.test(rawId)) {
    return fetchTmdbMeta(rawId, url.searchParams.get('type'));
  }

  return null;
}

async function fetchTmdbMeta(tmdbId, typeHint) {
  const apiKey = process.env.TMDB_API_KEY;
  if (!apiKey) return null;

  const order = typeHint === 'tv' ? ['tv', 'movie'] : ['movie', 'tv'];
  for (const kind of order) {
    const res = await fetch(`https://api.themoviedb.org/3/${kind}/${tmdbId}?api_key=${apiKey}&language=en-US`);
    if (!res.ok) continue;
    const data = await res.json();
    const title = data.title || data.name;
    if (!title) continue;

    return {
      title,
      year: (data.release_date || data.first_air_date || '').substring(0, 4) || null,
      plot: data.overview || null,
      image: data.backdrop_path
        ? 'https://image.tmdb.org/t/p/w1280' + data.backdrop_path
        : (data.poster_path ? 'https://image.tmdb.org/t/p/w500' + data.poster_path : null),
    };
  }

  return null;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function injectMeta(html, meta, url) {
  const yearSuffix = meta.year ? ` (${meta.year})` : '';
  const pageTitle = `${meta.title}${yearSuffix} — Stream Free | Stream Fiesta`;
  const rawDesc = meta.plot
    ? `Watch ${meta.title}${yearSuffix} online for free. ${meta.plot.substring(0, 120)}...`
    : `Watch ${meta.title}${yearSuffix} online for free on Stream Fiesta. No subscription, no sign-up.`;
  const image = meta.image || 'https://fiesta.show/assets/og-image.png';
  const pageUrl = url.origin + url.pathname;

  const t = escapeHtml(pageTitle);
  const d = escapeHtml(rawDesc);
  const img = escapeHtml(image);
  const u = escapeHtml(pageUrl);

  html = html.replace(/<title>[^<]*<\/title>/, `<title>${t}</title>`);
  html = html.replace(/<meta name="description" content="[^"]*">/, `<meta name="description" content="${d}">`);
  html = html.replace(/<meta property="og:title" content="[^"]*">/, `<meta property="og:title" content="${t}">`);
  html = html.replace(/<meta property="og:description" content="[^"]*">/, `<meta property="og:description" content="${d}">`);
  html = html.replace(/<meta property="og:url" content="[^"]*">/, `<meta property="og:url" content="${u}">`);
  html = html.replace(/<meta property="og:image" content="[^"]*">/, `<meta property="og:image" content="${img}">`);
  // Declared dimensions on the generic fallback image don't hold for a
  // per-title poster/backdrop — drop them so crawlers measure the real image.
  html = html.replace(/\s*<meta property="og:image:width" content="[^"]*">\n?/, '\n');
  html = html.replace(/\s*<meta property="og:image:height" content="[^"]*">\n?/, '\n');
  html = html.replace(/<meta name="twitter:title" content="[^"]*">/, `<meta name="twitter:title" content="${t}">`);
  html = html.replace(/<meta name="twitter:description" content="[^"]*">/, `<meta name="twitter:description" content="${d}">`);
  html = html.replace(/<meta name="twitter:image" content="[^"]*">/, `<meta name="twitter:image" content="${img}">`);

  return html;
}

export const config = {
  // Everything except the lite app's own assets and the /api/* functions —
  // both already serve the right thing regardless of User-Agent.
  matcher: ['/((?!lite/|api/).*)'],
};
