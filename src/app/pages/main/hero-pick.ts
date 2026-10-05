import { IMovie } from '../../interfaces/movie.interface';

const DAY_MS = 86_400_000;

/**
 * The home hero: one of the top 5 trending titles that has a backdrop, rotating
 * once per UTC day (the same for every visitor, so it can be preloaded).
 *
 * KEEP IN SYNC with the inline script in src/index.html, which makes the same
 * pick from the same API response to preload the image before Angular boots.
 */
export function pickHero(movies: IMovie[], now: number = Date.now()): IMovie | null {
  const candidates = movies.filter(m => m.Backdrop).slice(0, 5);
  if (candidates.length === 0) return movies[0] ?? null;
  return candidates[Math.floor(now / DAY_MS) % candidates.length];
}
