/** Formatting helpers shared by every music view. Pure; safe to call in templates. */

/** "3:07", or "1:02:05" past an hour. Negative/invalid -> "0:00". */
export function time(s: number): string {
  const t = Number.isFinite(s) && s > 0 ? Math.floor(s) : 0;
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = String(t % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

/** "42 min", "1 hr 5 min", "2 hr". */
export function longDuration(s: number): string {
  const m = Math.round((Number.isFinite(s) && s > 0 ? s : 0) / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} hr ${m % 60} min` : `${h} hr`;
}

const TIDAL_SIZE = /\/(\d+)x(\d+)\.(jpg|jpeg|png|webp)(\?.*)?$/i;

/**
 * The same TIDAL image at another size (TIDAL serves 80, 160, 320, 640, 750,
 * 1080 and 1280 square). Non-TIDAL or unsized URLs come back unchanged.
 */
export function tidalImage(url: string, size: number): string {
  if (!url || !/^https:\/\/resources\.tidal\.com\//.test(url)) return url || '';
  return url.replace(TIDAL_SIZE, `/${size}x${size}.$3$4`);
}

// Hosts the `img` action accepts (lib/music/artist-images.js keeps the server list).
const PROXIED_HOST = /^https:\/\/((resources|image)\.tidal\.com|(e-)?cdns?-images\.dzcdn\.net|upload\.wikimedia\.org|assets\.fanart\.tv)\//;

function base64url(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * An artist/cover image (TIDAL, Deezer, Wikimedia) through `/api/music?action=img` (same origin, CORS), for
 * canvases that read pixels. Other URLs (data:, '') come back unchanged.
 */
export function proxiedImage(url: string): string {
  if (!url || !PROXIED_HOST.test(url)) return url || '';
  return '/api/music?action=img&u=' + base64url(url);
}

/** "just now", "5 min ago", "3 hours ago", "yesterday", "4 days ago", else a short date. */
export function relativeDate(ms: number, now: number = Date.now()): string {
  const diff = Math.max(0, now - ms);
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return h === 1 ? '1 hour ago' : `${h} hours ago`;
  const d = Math.floor(h / 24);
  if (d === 1) return 'yesterday';
  if (d < 7) return `${d} days ago`;
  const date = new Date(ms);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString(undefined, sameYear ? { month: 'short', day: 'numeric' } : { year: 'numeric', month: 'short', day: 'numeric' });
}
