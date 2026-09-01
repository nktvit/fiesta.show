// Vercel Routing Middleware — runs before the CDN cache/static-file layer,
// unlike a declarative vercel.json `has`-conditioned rewrite (which loses to
// a literal static file match, e.g. "/" resolving straight to the built
// index.html before rewrites are ever consulted). This is what actually lets
// old-TV routing apply to the root path too.
import { rewrite, next } from '@vercel/functions';

export default function middleware(request) {
  const ua = request.headers.get('user-agent') || '';
  if (ua.indexOf('Tizen') === -1) return next();

  const url = new URL(request.url);
  url.pathname = '/lite/index.html';
  return rewrite(url);
}

export const config = {
  // Everything except the lite app's own assets and the /api/* functions —
  // both already serve the right thing regardless of User-Agent.
  matcher: ['/((?!lite/|api/).*)'],
};
