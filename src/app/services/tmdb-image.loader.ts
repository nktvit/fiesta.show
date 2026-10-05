import { ImageLoaderConfig } from '@angular/common';

const TMDB_HOST = 'image.tmdb.org';

/**
 * Sizes TMDB serves per image kind (developer.themoviedb.org/docs/image-basics).
 * Posters: w92 w154 w185 w342 w500 w780 original. Backdrops: w300 w780 w1280
 * original (w300 is skipped: far too soft for a full-bleed hero). `original` is deliberately never requested (a poster is ~1.9 MB
 * there), so each kind is capped at its largest sized folder.
 */
const TIERS = {
  poster: [92, 154, 185, 342, 500, 780],
  backdrop: [780, 1280],
} as const;

/** Passed through NgOptimizedImage's [loaderParams]; posters when omitted. */
export interface TmdbLoaderParams {
  kind?: 'poster' | 'backdrop';
}

/**
 * The srcset widths NgOptimizedImage generates (IMAGE_CONFIG.breakpoints). The
 * poster tiers plus 1280 for the hero, so each descriptor lines up with a real
 * size folder.
 */
export const TMDB_IMAGE_BREAKPOINTS = [92, 154, 185, 342, 500, 780, 1280];

export function tmdbIsImage(src: string | null | undefined): boolean {
  return !!src && src.includes(TMDB_HOST);
}

/**
 * Posters may be up to this much softer than the requested width. A 120px card
 * on a 3x phone asks for 360w; w500 is 2x the bytes of w342 for detail nobody
 * can see on a thumbnail. (Angular puts `sizes="auto"` on lazy images, so the
 * browser sizes from the real layout and `sizes` itself can't shave this.)
 * Backdrops are exact: the hero is full-bleed and does show the detail.
 */
const POSTER_SOFTNESS = 0.68;

function tmdbTier(width: number, kind: 'poster' | 'backdrop'): string {
  const tiers = TIERS[kind];
  const needed = kind === 'poster' ? width * POSTER_SOFTNESS : width;
  return `w${tiers.find(t => t >= needed) ?? tiers[tiers.length - 1]}`;
}

/**
 * Maps a requested width to the matching TMDB size folder. The file extension is
 * left alone: image.tmdb.org 404s on rewritten .webp paths (checked for real
 * poster, backdrop and profile paths) but already serves WebP from the .jpg URL
 * when the browser sends `Accept: image/webp`.
 */
export function tmdbImageLoader(config: ImageLoaderConfig): string {
  const { src, width, loaderParams } = config;

  if (!tmdbIsImage(src)) {
    return src;
  }

  const filename = src.split('/').pop()!;
  const kind = (loaderParams as TmdbLoaderParams | undefined)?.kind ?? 'poster';
  return `https://${TMDB_HOST}/t/p/${tmdbTier(width || 342, kind)}/${filename}`;
}
