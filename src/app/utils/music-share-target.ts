import { MusicLibraryItem } from '../services/music.service';
import { buildShareUrl } from './music-share';

/**
 * Share links for music items. Everything shared is an absolute Fiesta URL on
 * this site (never a TIDAL link). Pure except `shareItem`, which talks to
 * navigator.share / the clipboard.
 */

export interface MusicShareTarget {
  title: string;
  text: string;
  url: string;
}

export type MusicShareOutcome = 'shared' | 'copied' | 'failed';

/** The site path an item lives at, or null when it has no public page (visitor playlists use a payload link). */
export function musicSharePath(item: MusicLibraryItem): string | null {
  switch (item.kind) {
    case 'track': return `/music/track/${item.data.id}`;
    case 'album': return `/music/album/${item.data.id}`;
    case 'artist': return `/music/artist/${item.data.id}`;
    case 'playlist': return `/music/playlist/${item.data.uuid}`;
    case 'mix': return `/music/mix/${encodeURIComponent(item.data.id)}`;
    default: return null;
  }
}

/** `https://<host>/music/...` for a path; `origin` defaults to this page's. */
export function musicShareUrl(path: string, origin?: string): string {
  const base = origin ?? (typeof location !== 'undefined' ? location.origin : '');
  return base.replace(/\/$/, '') + path;
}

function describe(item: MusicLibraryItem): { title: string; text: string } {
  switch (item.kind) {
    case 'track': return { title: item.data.title, text: `${item.data.title} - ${item.data.artist}` };
    case 'album': return { title: item.data.title, text: `${item.data.title} - ${item.data.artist}` };
    case 'artist': return { title: item.data.name, text: item.data.name };
    case 'playlist': return { title: item.data.title, text: item.data.title };
    case 'mix': return { title: item.data.title, text: item.data.title };
    default: return { title: item.data.name, text: item.data.name };
  }
}

/** What to share for an item, or null when it can't be shared. */
export async function musicShareTarget(item: MusicLibraryItem, origin?: string): Promise<MusicShareTarget | null> {
  const d = describe(item);
  if (item.kind === 'userPlaylist') {
    if (!item.data.tracks.length) return null;
    return { ...d, url: await buildShareUrl({ name: item.data.name, description: item.data.description, tracks: item.data.tracks }) };
  }
  const path = musicSharePath(item);
  return path ? { ...d, url: musicShareUrl(path, origin) } : null;
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the legacy path
  }
  try {
    if (typeof document === 'undefined') return false;
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

/**
 * Opens the Web Share sheet when the browser has one, else copies the link.
 * A dismissed share sheet counts as 'shared' (nothing to report).
 */
export async function shareMusicTarget(target: MusicShareTarget): Promise<MusicShareOutcome> {
  if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
    try {
      await navigator.share({ title: target.title, text: target.text, url: target.url });
      return 'shared';
    } catch (e) {
      if ((e as { name?: string })?.name === 'AbortError') return 'shared';
      // fall through to copying
    }
  }
  return (await copyText(target.url)) ? 'copied' : 'failed';
}
