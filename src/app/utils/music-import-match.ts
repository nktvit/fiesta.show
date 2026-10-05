// Ported from Monochrome (Apache-2.0), js/playlist-importer.js - adapted for Fiesta.
import { MusicTrack } from '../services/music.service';

/** Matches below this combined score are reported as missing. */
export const MATCH_THRESHOLD = 0.6;
/** A candidate whose title alone scores under this is never taken. */
const MIN_TITLE_SCORE = 0.5;

export function normalizeIsrc(isrc: unknown): string {
  return String(isrc ?? '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

export function isIsrcMatch(a: unknown, b: unknown): boolean {
  const x = normalizeIsrc(a);
  return x.length > 0 && x === normalizeIsrc(b);
}

export function normalizeForMatch(s: unknown): string {
  return String(s ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

export function tokenize(s: unknown): string[] {
  return String(s ?? '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, ' ').trim().split(/\s+/).filter(Boolean);
}

/** 1 equal, 0.85 one contains the other, else shared-token ratio. */
export function stringSimilarity(a: unknown, b: unknown): number {
  const na = normalizeForMatch(a);
  const nb = normalizeForMatch(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.85;
  const sa = new Set(tokenize(a));
  const sb = new Set(tokenize(b));
  if (!sa.size || !sb.size) return 0;
  let common = 0;
  for (const t of sa) if (sb.has(t)) common++;
  return common / Math.max(sa.size, sb.size);
}

export function splitArtists(s: unknown): string[] {
  return String(s ?? '')
    .split(/[,&;]| and | feat\.? | featuring /i)
    .map((x) => x.trim())
    .filter(Boolean);
}

function artistNames(t: MusicTrack): string[] {
  const names = (t.artists ?? []).map((a) => a?.name).filter(Boolean);
  return names.length ? names : t.artist ? [t.artist] : [];
}

export interface MatchScore {
  score: number;
  titleScore: number;
  artistScore: number;
  albumScore: number;
}

/** title 50%, artist 40%, album 10% (album only counts when the source row has one). */
export function scoreTrack(item: MusicTrack, title: string, artist: string, album?: string): MatchScore {
  const titleScore = stringSimilarity(item.title, title);
  const have = artistNames(item);
  let artistScore = 0;
  for (const ta of splitArtists(artist)) for (const ia of have) artistScore = Math.max(artistScore, stringSimilarity(ia, ta));
  if (have.length) artistScore = Math.max(artistScore, stringSimilarity(have.join(' '), artist));
  const albumScore = album ? stringSimilarity(item.album, album) : 0;
  return { score: titleScore * 0.5 + artistScore * 0.4 + albumScore * 0.1, titleScore, artistScore, albumScore };
}

export interface MatchTarget {
  title: string;
  artist?: string;
  album?: string;
  isrc?: string;
}

/**
 * The best candidate for a source row: an ISRC-equal one wins outright
 * (score 1), otherwise the highest fuzzy score at or above MATCH_THRESHOLD.
 */
export function findBestMatch(
  candidates: MusicTrack[],
  target: MatchTarget,
): { track: MusicTrack; score: number; by: 'isrc' | 'fuzzy' } | null {
  if (!candidates?.length) return null;
  if (target.isrc) {
    const hit = candidates.find((c) => isIsrcMatch(c.isrc, target.isrc));
    if (hit) return { track: hit, score: 1, by: 'isrc' };
  }
  if (!target.title) return null;
  let best: MusicTrack | null = null;
  let bestScore = -1;
  for (const c of candidates) {
    const s = scoreTrack(c, target.title, target.artist ?? '', target.album);
    if (s.titleScore < MIN_TITLE_SCORE) continue;
    if (s.score > bestScore) {
      bestScore = s.score;
      best = c;
    }
  }
  return best && bestScore >= MATCH_THRESHOLD ? { track: best, score: bestScore, by: 'fuzzy' } : null;
}
