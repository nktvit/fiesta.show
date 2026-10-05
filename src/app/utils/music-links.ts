/**
 * Pasted-link parsing for the music search box: a tidal.com, listen.tidal.com or
 * monochrome.tf album / track / artist / playlist / mix URL becomes the matching
 * Fiesta route. Pure; owned by package P8.
 */

export type MusicLinkKind = 'album' | 'track' | 'artist' | 'playlist' | 'mix';

export interface MusicLink {
  kind: MusicLinkKind;
  id: string;
  /** The Fiesta path, e.g. `/music/album/123`. */
  route: string;
}

const HOSTS = /^(?:www\.|listen\.|play\.|embed\.)?(?:tidal\.com|monochrome\.tf)$/i;
const KINDS: readonly MusicLinkKind[] = ['album', 'track', 'artist', 'playlist', 'mix'];
const NUMERIC = /^\d{1,12}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MIX = /^[A-Za-z0-9]{8,40}$/;

function validId(kind: MusicLinkKind, id: string): boolean {
  if (kind === 'playlist') return UUID.test(id);
  if (kind === 'mix') return MIX.test(id);
  return NUMERIC.test(id);
}

/** The Fiesta route a pasted music link points at, or null when it isn't one. */
export function parseMusicLink(input: string): MusicLink | null {
  const text = (input ?? '').trim();
  if (!text || /\s/.test(text)) return null;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : 'https://' + text);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (!HOSTS.test(url.hostname)) return null;

  // monochrome.tf can carry the route in the hash (#/album/1); tidal.com has an
  // optional /browse and a locale prefix (/de/album/1).
  const path = url.hash.startsWith('#/') && !url.pathname.replace(/\//g, '') ? url.hash.slice(1) : url.pathname;
  const parts = path.split('?')[0].split('/').filter(Boolean);
  for (let i = 0; i < parts.length - 1; i++) {
    const kind = parts[i].toLowerCase() as MusicLinkKind;
    if (!KINDS.includes(kind)) continue;
    const id = decodeURIComponent(parts[i + 1]);
    if (!validId(kind, id)) return null;
    const key = kind === 'playlist' ? id.toLowerCase() : id;
    return { kind, id: key, route: `/music/${kind}/${key}` };
  }
  return null;
}

/** Absolute Fiesta URL for a music path (`/music/album/1`) on this origin. */
export function musicUrl(path: string, origin?: string): string {
  const base = origin ?? (typeof location !== 'undefined' ? location.origin : '');
  return base + path;
}

export type MusicShareResult = 'shared' | 'copied' | 'failed';

/**
 * Share a Fiesta page: the Web Share sheet where the browser has one, else copy
 * the link. A dismissed share sheet counts as 'shared' (nothing to report).
 */
export async function shareMusicLink(opts: { title: string; text?: string; path: string }): Promise<MusicShareResult> {
  const url = musicUrl(opts.path);
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
      try {
        await navigator.share({ title: opts.title, text: opts.text, url });
        return 'shared';
      } catch (e) {
        if ((e as { name?: string })?.name === 'AbortError') return 'shared';
        // fall through to copying
      }
    }
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(url);
      return 'copied';
    }
  } catch {
    // clipboard refused (permissions, insecure origin)
  }
  return 'failed';
}
