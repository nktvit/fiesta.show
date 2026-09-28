// Path-based routing that mirrors the main Angular app's URL scheme
// (src/app/app.routes.ts) one-to-one, so any link that works on the full
// site opens the same thing here, and vice versa:
//
//   /                          home
//   /search?query=dune         search
//   /movie/:id?type=tv&s=1&e=2 details (id is an IMDb "tt…" or a TMDB number)
//   /movie/:id?play=1[&s&e]    playback (same query the main app's Play uses)
//   /person/:id                person credits
//   /genre/:id                 genre grid
//   /top-rated                 top rated grid
//   /tv                        TV shows
//
// The URL bar keeps the real path because Vercel middleware *rewrites* legacy
// browsers to /lite/index.html rather than redirecting them, so the History
// API works exactly like it does for the Angular router. The remote's Back
// button maps onto window.history.back() (see remote.ts).

export type Screen = 'home' | 'search' | 'movie' | 'person' | 'genre' | 'top-rated' | 'tv';

export interface Route {
  screen: Screen;
  id: string;
  query: { [key: string]: string };
  // pathname + search, used as an identity key for effects
  href: string;
}

const NAV_EVENT = 'fiesta:navigate';

function parseQuery(search: string): { [key: string]: string } {
  const out: { [key: string]: string } = {};
  const raw = search.replace(/^\?/, '');
  if (!raw) return out;
  const parts = raw.split('&');
  for (let i = 0; i < parts.length; i++) {
    if (!parts[i]) continue;
    const eq = parts[i].indexOf('=');
    const k = eq === -1 ? parts[i] : parts[i].slice(0, eq);
    const v = eq === -1 ? '' : parts[i].slice(eq + 1);
    try {
      out[decodeURIComponent(k)] = decodeURIComponent(v.replace(/\+/g, ' '));
    } catch (e) {
      out[k] = v;
    }
  }
  return out;
}

export function buildQuery(params: { [key: string]: string | number | null | undefined }): string {
  const parts: string[] = [];
  for (const k in params) {
    if (!Object.prototype.hasOwnProperty.call(params, k)) continue;
    const v = params[k];
    if (v === null || v === undefined || v === '') continue;
    parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(v)));
  }
  return parts.length ? '?' + parts.join('&') : '';
}

// Old builds of this client used hash routes (#/title/… and #/watch/…).
// Translate a leftover bookmark into the real path so it still opens.
function legacyHashToPath(hash: string): string | null {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(function (p) { return p.length > 0; });
  if (parts[0] === 'search') return '/search';
  if (parts[0] === 'title' && parts[2]) return '/movie/' + parts[2] + buildQuery({ type: parts[1] === 'tv' ? 'tv' : null });
  if (parts[0] === 'watch' && parts[2]) {
    return '/movie/' + parts[2] + buildQuery({ type: parts[1] === 'tv' ? 'tv' : null, play: 1, s: parts[3], e: parts[4] });
  }
  return null;
}

export function parseLocation(): Route {
  const legacy = window.location.hash ? legacyHashToPath(window.location.hash) : null;
  if (legacy) {
    window.history.replaceState(null, '', legacy);
  }

  let path = window.location.pathname.replace(/\/+$/, '') || '/';
  // A direct hit on the bundle's own URL (or a dev server) — treat as home.
  if (path === '/lite' || path === '/lite/index.html') path = '/';
  const query = parseQuery(window.location.search);
  const href = path + window.location.search;
  const seg = path.split('/').filter(function (p) { return p.length > 0; });

  if (seg.length === 0) return { screen: 'home', id: '', query: query, href: href };
  if (seg[0] === 'search') return { screen: 'search', id: '', query: query, href: href };
  if (seg[0] === 'movie' && seg[1]) return { screen: 'movie', id: seg[1], query: query, href: href };
  if (seg[0] === 'person' && seg[1]) return { screen: 'person', id: seg[1], query: query, href: href };
  if (seg[0] === 'genre' && seg[1]) return { screen: 'genre', id: seg[1], query: query, href: href };
  if (seg[0] === 'top-rated') return { screen: 'top-rated', id: '', query: query, href: href };
  if (seg[0] === 'tv') return { screen: 'tv', id: '', query: query, href: href };
  // Anything else (about, terms, unknown) — the main app redirects to home too.
  return { screen: 'home', id: '', query: query, href: href };
}

export function navigate(path: string, replace?: boolean) {
  if (replace) window.history.replaceState(null, '', path);
  else window.history.pushState(null, '', path);
  // pushState doesn't fire popstate — tell the app ourselves. A plain Event
  // via createEvent (not `new Event()`, which Chromium 47 does support but
  // some TV shells don't) keeps this bulletproof.
  const ev = document.createEvent('Event');
  ev.initEvent(NAV_EVENT, false, false);
  window.dispatchEvent(ev);
}

export function subscribe(listener: () => void): () => void {
  window.addEventListener('popstate', listener);
  window.addEventListener(NAV_EVENT, listener);
  return function () {
    window.removeEventListener('popstate', listener);
    window.removeEventListener(NAV_EVENT, listener);
  };
}

// Link helper: the href is real (so the URL is copyable and works on the
// main site), but the click is intercepted to stay in-app.
export function onLinkClick(e: React.MouseEvent<HTMLAnchorElement>) {
  const target = e.currentTarget;
  const href = target.getAttribute('href') || '';
  if (!href || href.charAt(0) !== '/') return;
  e.preventDefault();
  navigate(href);
}

export function moviePath(type: 'movie' | 'tv', id: string, opts?: { play?: boolean; season?: number | null; episode?: number | null }): string {
  const o = opts || {};
  return '/movie/' + encodeURIComponent(id) + buildQuery({
    type: type === 'tv' ? 'tv' : null,
    s: type === 'tv' ? o.season : null,
    e: type === 'tv' ? o.episode : null,
    play: o.play ? 1 : null,
  });
}
