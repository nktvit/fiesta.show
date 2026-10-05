// Ported from Monochrome (Apache-2.0), js/listening-tracker.js and js/smart-recommendations.js - adapted for Fiesta.
//
// Pure listening statistics and recommendation scoring. Everything here works on a
// plain ListeningData object (no storage, no player) so it is easy to test.
// Differences from upstream: durations are in seconds (upstream divided a value that
// was already in seconds by 1000), track ids are numbers, a track that plays to its
// natural end counts as fully listened (a 30 s preview of a 4 min song is a whole
// listen), and disliked artists use the artist ids on the track rather than a
// nested `track.artist.id`.

import type { MusicTrack } from '../services/music.service';

export const MAX_TRACKS = 2000;
export const MAX_ARTISTS = 500;
/** A track left within this many seconds counts as a skip. */
export const SKIP_THRESHOLD_S = 5;
/** Played at least this share of the track: a completion (and not "short"). */
export const COMPLETION_RATIO = 0.3;

export interface TrackSignal {
  playCount: number;
  skipCount: number;
  /** Plays that reached COMPLETION_RATIO. */
  completionCount: number;
  totalPlayTime: number;
  lastPlayed: number;
  /** Smoothed 0..1 share of the track that gets played. */
  avgCompletionRatio: number;
}

export interface ArtistSignal {
  name: string;
  /** Exponentially smoothed taste score; negative means "keeps getting skipped". */
  affinity: number;
  playCount: number;
  skipCount: number;
  totalPlayTime: number;
}

export interface ListeningData {
  version: 1;
  tracks: Record<string, TrackSignal>;
  artists: Record<string, ArtistSignal>;
}

export interface ArtistRef {
  id: number;
  name: string;
}

export function emptyListening(): ListeningData {
  return { version: 1, tracks: {}, artists: {} };
}

/** Defensive copy of whatever came out of storage. */
export function sanitizeListening(raw: unknown): ListeningData {
  const out = emptyListening();
  if (!raw || typeof raw !== 'object') return out;
  const r = raw as Partial<ListeningData>;
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  for (const [id, t] of Object.entries(r.tracks ?? {})) {
    if (!t || typeof t !== 'object') continue;
    out.tracks[id] = {
      playCount: num(t.playCount), skipCount: num(t.skipCount), completionCount: num(t.completionCount),
      totalPlayTime: num(t.totalPlayTime), lastPlayed: num(t.lastPlayed), avgCompletionRatio: num(t.avgCompletionRatio),
    };
  }
  for (const [id, a] of Object.entries(r.artists ?? {})) {
    if (!a || typeof a !== 'object') continue;
    out.artists[id] = {
      name: typeof a.name === 'string' ? a.name : '', affinity: num(a.affinity), playCount: num(a.playCount),
      skipCount: num(a.skipCount), totalPlayTime: num(a.totalPlayTime),
    };
  }
  return out;
}

/** Credited artists of a track (id + name), main artist first, no duplicates. */
export function trackArtists(t: Pick<MusicTrack, 'artist' | 'artistId' | 'artists'>): ArtistRef[] {
  const out: ArtistRef[] = [];
  const seen = new Set<number>();
  for (const a of t.artists ?? []) {
    if (a && a.id && !seen.has(a.id)) {
      seen.add(a.id);
      out.push({ id: a.id, name: a.name });
    }
  }
  if (t.artistId && !seen.has(t.artistId)) out.push({ id: t.artistId, name: t.artist });
  return out;
}

/** What one play looked like, as the tracker sees it. */
export interface PlayOutcome {
  playedSeconds: number;
  durationSeconds: number;
  /** The track played to its natural end. */
  completed: boolean;
  /** The listener moved on early (skip event). */
  skipped: boolean;
}

/** Share of the track that was heard, 0..1. A natural end always counts as 1. */
export function completionRatio(o: PlayOutcome): number {
  if (o.completed) return 1;
  return o.durationSeconds > 0 ? Math.min(Math.max(o.playedSeconds / o.durationSeconds, 0), 1) : 0;
}

/** Whether this play counts as a skip: an explicit skip, or abandoned inside SKIP_THRESHOLD_S. */
export function isSkip(o: PlayOutcome): boolean {
  if (o.completed) return false;
  return o.skipped || o.playedSeconds < SKIP_THRESHOLD_S;
}

export function artistWeight(ratio: number, skipped: boolean): number {
  if (skipped) return -0.5;
  if (ratio > 0.8) return 1.0;
  if (ratio > 0.5) return 0.5;
  if (ratio > COMPLETION_RATIO) return 0.2;
  return -0.2;
}

/**
 * Records one finished play into `data` (mutates). Returns what was recorded so the
 * caller can react: 'skip', 'completion' or 'partial' (heard some, but under 30 %).
 */
export function recordPlay(
  data: ListeningData,
  track: Pick<MusicTrack, 'id' | 'artist' | 'artistId' | 'artists' | 'duration'>,
  outcome: PlayOutcome,
  now = Date.now(),
): 'skip' | 'completion' | 'partial' {
  const key = String(track.id);
  const sig: TrackSignal = data.tracks[key] ?? {
    playCount: 0, skipCount: 0, completionCount: 0, totalPlayTime: 0, lastPlayed: 0, avgCompletionRatio: 0,
  };
  data.tracks[key] = sig;
  const dur = outcome.durationSeconds > 0 ? outcome.durationSeconds : track.duration;
  const full: PlayOutcome = { ...outcome, durationSeconds: dur };
  const ratio = completionRatio(full);
  const skipped = isSkip(full);

  sig.playCount++;
  sig.totalPlayTime += Math.max(outcome.playedSeconds, 0);
  sig.lastPlayed = now;
  sig.avgCompletionRatio = sig.avgCompletionRatio === 0 ? ratio : sig.avgCompletionRatio * 0.8 + ratio * 0.2;

  let result: 'skip' | 'completion' | 'partial';
  if (skipped) {
    sig.skipCount++;
    result = 'skip';
  } else if (ratio >= COMPLETION_RATIO) {
    sig.completionCount++;
    result = 'completion';
  } else {
    result = 'partial';
  }

  const w = artistWeight(ratio, skipped);
  for (const a of trackArtists(track)) {
    const art = data.artists[String(a.id)] ?? { name: a.name, affinity: 0, playCount: 0, skipCount: 0, totalPlayTime: 0 };
    data.artists[String(a.id)] = art;
    art.affinity = art.affinity * 0.9 + w;
    art.playCount++;
    art.totalPlayTime += Math.max(outcome.playedSeconds, 0);
    if (skipped) art.skipCount++;
    if (a.name) art.name = a.name;
  }
  return result;
}

/** Keeps the newest MAX_TRACKS tracks and the MAX_ARTISTS best-liked artists (mutates). */
export function pruneListening(data: ListeningData): void {
  const tracks = Object.entries(data.tracks);
  if (tracks.length > MAX_TRACKS) {
    tracks.sort((a, b) => b[1].lastPlayed - a[1].lastPlayed);
    data.tracks = Object.fromEntries(tracks.slice(0, MAX_TRACKS));
  }
  const artists = Object.entries(data.artists);
  if (artists.length > MAX_ARTISTS) {
    artists.sort((a, b) => b[1].affinity - a[1].affinity);
    data.artists = Object.fromEntries(artists.slice(0, MAX_ARTISTS));
  }
}

// ── Queries ──────────────────────────────────────────────────────────────

export function trackSignal(data: ListeningData, id: number): TrackSignal | null {
  return data.tracks[String(id)] ?? null;
}

/** Taste score of one track: completion up, skips down, a little for play count. */
export function trackScore(data: ListeningData, id: number): number {
  const s = trackSignal(data, id);
  if (!s) return 0;
  const skipRate = s.playCount > 0 ? s.skipCount / s.playCount : 0;
  const completionRate = s.playCount > 0 ? s.completionCount / s.playCount : 0;
  return s.avgCompletionRatio * 2 + completionRate * 3 - skipRate * 4 + Math.log2(s.playCount + 1) * 0.5;
}

export interface RankedArtist {
  id: number;
  name: string;
  affinity: number;
  playCount: number;
}

/** Artists played at least twice, best affinity first. */
export function topArtists(data: ListeningData, limit = 20): RankedArtist[] {
  return Object.entries(data.artists)
    .filter(([, v]) => v.playCount >= 2)
    .sort((a, b) => b[1].affinity - a[1].affinity)
    .slice(0, limit)
    .map(([id, v]) => ({ id: Number(id), name: v.name, affinity: v.affinity, playCount: v.playCount }));
}

/** Artists that keep getting skipped (played at least twice, affinity under -0.3). */
export function dislikedArtists(data: ListeningData, limit = 30): RankedArtist[] {
  return Object.entries(data.artists)
    .filter(([, v]) => v.playCount >= 2 && v.affinity < -0.3)
    .sort((a, b) => a[1].affinity - b[1].affinity)
    .slice(0, limit)
    .map(([id, v]) => ({ id: Number(id), name: v.name, affinity: v.affinity, playCount: v.playCount }));
}

export interface RankedTrack {
  id: number;
  playCount: number;
  completionRatio: number;
}

/** Tracks played at least twice and mostly to the end, most played first. */
export function topTracks(data: ListeningData, limit = 50): RankedTrack[] {
  return Object.entries(data.tracks)
    .filter(([, v]) => v.playCount >= 2 && v.avgCompletionRatio > 0.6)
    .sort((a, b) => b[1].playCount - a[1].playCount)
    .slice(0, limit)
    .map(([id, v]) => ({ id: Number(id), playCount: v.playCount, completionRatio: v.avgCompletionRatio }));
}

export function frequentlySkippedTrackIds(data: ListeningData, limit = 50): Set<number> {
  return new Set(
    Object.entries(data.tracks)
      .filter(([, v]) => v.playCount >= 2 && v.skipCount / v.playCount > 0.5)
      .sort((a, b) => b[1].skipCount / b[1].playCount - a[1].skipCount / a[1].playCount)
      .slice(0, limit)
      .map(([id]) => Number(id)),
  );
}

export function shortPlayTrackIds(data: ListeningData, limit = 50): Set<number> {
  return new Set(
    Object.entries(data.tracks)
      .filter(([, v]) => v.playCount >= 2 && v.avgCompletionRatio < COMPLETION_RATIO)
      .sort((a, b) => a[1].avgCompletionRatio - b[1].avgCompletionRatio)
      .slice(0, limit)
      .map(([id]) => Number(id)),
  );
}

// ── Recommendation scoring (smart-recommendations.js) ────────────────────

export function completionBonus(data: ListeningData, id: number): number {
  const s = trackSignal(data, id);
  if (!s) return 0;
  if (s.avgCompletionRatio > 0.8) return 2;
  if (s.avgCompletionRatio > 0.5) return 1;
  if (s.avgCompletionRatio < 0.2 && s.playCount >= 2) return -3;
  return 0;
}

function byDislikedArtist(t: MusicTrack, disliked: Set<number>): boolean {
  if (!disliked.size) return false;
  return trackArtists(t).some((a) => disliked.has(a.id));
}

export function dislikedArtistIds(data: ListeningData): Set<number> {
  return new Set(dislikedArtists(data, 30).map((a) => a.id));
}

/** Where seed candidates come from: favourites weigh 3, playlist tracks 2, history 1. */
export interface SeedSources {
  favorites: MusicTrack[];
  playlists: MusicTrack[];
  history: MusicTrack[];
}

/**
 * Best tracks to seed recommendations from: weighted by source plus the taste score and
 * completion bonus, minus tracks by disliked artists and tracks that are played and abandoned.
 * Order is deterministic (best first); `shuffle` is the caller's choice.
 */
export function smartSeeds(data: ListeningData, sources: SeedSources, count = 50): MusicTrack[] {
  const scored = new Map<number, { score: number; track: MusicTrack }>();
  const add = (tracks: MusicTrack[], weight: number): void => {
    for (const t of tracks) {
      if (!t || !t.id) continue;
      const score = weight + trackScore(data, t.id) + completionBonus(data, t.id);
      const have = scored.get(t.id);
      if (have) {
        have.score += score;
        have.track = t;
      } else {
        scored.set(t.id, { score, track: t });
      }
    }
  };
  add(sources.favorites, 3);
  add(sources.playlists, 2);
  add(sources.history, 1);

  const disliked = dislikedArtistIds(data);
  return [...scored.values()]
    .sort((a, b) => b.score - a.score)
    .filter(({ track }) => {
      if (byDislikedArtist(track, disliked)) return false;
      const s = trackSignal(data, track.id);
      return !(s && s.playCount >= 3 && s.avgCompletionRatio < 0.2);
    })
    .slice(0, count)
    .map((s) => s.track);
}

/** Drops tracks the listener keeps skipping or abandoning, and tracks by disliked artists. */
export function filterRecommendations(data: ListeningData, tracks: MusicTrack[]): MusicTrack[] {
  const skipped = frequentlySkippedTrackIds(data, 100);
  const short = shortPlayTrackIds(data, 100);
  const disliked = dislikedArtistIds(data);
  return tracks.filter((t) => t && t.id && !skipped.has(t.id) && !short.has(t.id) && !byDislikedArtist(t, disliked));
}

export function scoreRecommendation(data: ListeningData, t: MusicTrack): number {
  let score = 0;
  const top = topArtists(data, 30);
  const topById = new Map(top.map((a) => [a.id, a]));
  const artists = trackArtists(t);
  const main = artists[0];
  if (main && topById.has(main.id)) score += Math.min((topById.get(main.id)?.affinity ?? 0) * 2, 5);
  if (artists.slice(1).some((a) => topById.has(a.id))) score += 1;
  if (byDislikedArtist(t, dislikedArtistIds(data))) score -= 5;
  if (frequentlySkippedTrackIds(data, 50).has(t.id)) score -= 3;
  return score;
}

/** Best first; ties keep their incoming order (stable). */
export function rankRecommendations(data: ListeningData, tracks: MusicTrack[]): MusicTrack[] {
  return tracks
    .map((t, i) => ({ t, i, s: scoreRecommendation(data, t) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.t);
}

/**
 * Seeds for refilling a running queue: the queue tracks that were heard best (and are
 * not recently played, nor by disliked artists), padded with smart seeds.
 */
export function adaptiveSeeds(
  data: ListeningData,
  queueTracks: MusicTrack[],
  recentIds: Set<number>,
  extra: MusicTrack[],
  count = 5,
): MusicTrack[] {
  const disliked = dislikedArtistIds(data);
  const scored: { track: MusicTrack; score: number }[] = [];
  for (const t of queueTracks) {
    if (!t || recentIds.has(t.id) || byDislikedArtist(t, disliked)) continue;
    const s = trackSignal(data, t.id);
    scored.push({ track: t, score: s ? s.avgCompletionRatio : 0.5 });
  }
  scored.sort((a, b) => b.score - a.score);
  const best = scored.slice(0, Math.ceil(count / 2)).map((s) => s.track);
  if (best.length < count) {
    for (const t of extra) {
      if (best.length >= count) break;
      if (recentIds.has(t.id) || best.some((b) => b.id === t.id)) continue;
      best.push(t);
    }
  }
  return best.slice(0, count);
}

/** Fisher-Yates shuffle into a new array. `rand` is injectable for tests. */
export function shuffled<T>(items: readonly T[], rand: () => number = Math.random): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
