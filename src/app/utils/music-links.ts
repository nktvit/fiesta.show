/**
 * Share helpers for music pages: absolute Fiesta URLs and the Web Share / clipboard
 * fallback. Owned by package P8.
 */

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
