import { inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import {
  adaptiveSeeds, filterRecommendations, rankRecommendations, shuffled, smartSeeds, trackArtists,
} from '../utils/music-recs-scoring';
import { MusicDiscoveryService } from './music-discovery.service';
import { MusicLibraryService } from './music-library.service';
import { MusicListeningTrackerService } from './music-listening-tracker.service';
import { MusicService, MusicTrack } from './music.service';

// Ported from Monochrome (Apache-2.0), js/player.js (enableRadio, fetchRadioRecommendations,
// pickRadioSeeds, enableAutoplay, fetchAutoplayRecommendations), js/smart-recommendations.js and
// js/api.js getRecommendedTracksForPlaylist - adapted for Fiesta.

/** What a radio station is seeded from. */
export interface RadioSeed {
  kind: 'track' | 'album' | 'artist' | 'playlist' | 'mix';
  id: string | number;
  label: string;
  /** Tracks already in hand (album/playlist contents), to seed from without a fetch. */
  tracks?: MusicTrack[];
}

/** How many tracks a fresh radio station opens with, and the least it must have. */
export const RADIO_OPENING = 30;
export const RADIO_MIN = 10;
/** The recently-played ring a station avoids repeating. */
export const RECENT_RING = 100;

/** Round-robin merge of several lists (keeps each list's own order). */
export function interleave<T>(lists: T[][]): T[] {
  const out: T[] = [];
  const longest = lists.reduce((n, l) => Math.max(n, l.length), 0);
  for (let i = 0; i < longest; i++) for (const l of lists) if (i < l.length) out.push(l[i]);
  return out;
}

/** Keeps the first occurrence of each id and drops anything in `exclude`. */
export function uniqueTracks(tracks: MusicTrack[], exclude: Iterable<number> = []): MusicTrack[] {
  const seen = new Set<number>(exclude);
  const out: MusicTrack[] = [];
  for (const t of tracks) {
    if (!t || !t.id || seen.has(t.id)) continue;
    seen.add(t.id);
    out.push(t);
  }
  return out;
}

/**
 * Radio and autoplay recommendations, and the seeds the home page uses.
 * Owned by package P9. Must NOT inject MusicPlayerService: the player calls it
 * through Injector.get(MusicRecommenderService) at call time. (It does read the
 * listening tracker, which only reaches the player lazily in start().)
 */
@Injectable({ providedIn: 'root' })
export class MusicRecommenderService {
  private discovery = inject(MusicDiscoveryService);
  private music = inject(MusicService);
  private library = inject(MusicLibraryService);
  private tracker = inject(MusicListeningTrackerService);

  // ── Radio ──────────────────────────────────────────────────────────────

  /**
   * The opening queue for a radio station: at least RADIO_MIN (when TIDAL has them) and up
   * to RADIO_OPENING tracks that are not the seed and not among the last 100 played.
   */
  async radioTracks(seed: RadioSeed): Promise<MusicTrack[]> {
    const seedIds = new Set<number>();
    let lists: MusicTrack[][] = [];

    switch (seed.kind) {
      case 'track': {
        const id = Number(seed.id);
        seedIds.add(id);
        lists = [await this.trackMix(id)];
        if (!lists[0].length && seed.tracks?.[0]) lists = [await this.artistFallback(seed.tracks[0])];
        break;
      }
      case 'artist': {
        lists = [await this.artistMix(Number(seed.id))];
        break;
      }
      default: {
        // album / playlist / mix: two random tracks of it seed two track mixes.
        const source = seed.tracks?.length ? seed.tracks : await this.tracksOf(seed);
        source.forEach((t) => seedIds.add(t.id));
        const picks = shuffled(source).slice(0, 2);
        lists = await Promise.all(picks.map((t) => this.trackMix(t.id)));
        if (!lists.some((l) => l.length) && picks[0]) lists = [await this.artistFallback(picks[0])];
      }
    }

    const candidates = this.clean(interleave(lists), seedIds);
    const recent = new Set(this.recentIds());
    const fresh = candidates.filter((t) => !recent.has(t.id));
    // The 100-track ring is a preference: it only gives way when it would leave too few.
    const picked = fresh.length >= RADIO_MIN ? fresh : fresh.concat(candidates.filter((t) => recent.has(t.id))).slice(0, Math.max(RADIO_MIN, fresh.length));
    return picked.slice(0, RADIO_OPENING);
  }

  /**
   * More tracks for a running radio ('radio') or for autoplay at the end of the queue.
   * `seeds` are the last few queue tracks; `exclude` already holds the queue and recent plays.
   */
  async refill(seeds: MusicTrack[], opts: { mode: 'radio' | 'autoplay'; exclude: Set<number>; limit: number }): Promise<MusicTrack[]> {
    const limit = Math.max(1, opts.limit);
    const exclude = new Set(opts.exclude);
    seeds.forEach((t) => exclude.add(t.id));

    let picks: MusicTrack[];
    if (opts.mode === 'autoplay') {
      picks = adaptiveSeeds(this.tracker.data(), seeds, new Set(this.recentIds()), this.seeds(20), 5);
    } else {
      picks = shuffled(seeds);
    }
    if (!picks.length) picks = this.seeds(5);
    picks = picks.slice(0, 3);
    if (!picks.length) return [];

    let lists = await Promise.all(picks.map((t) => this.trackMix(t.id)));
    if (!lists.some((l) => l.length)) lists = [await this.artistFallback(picks[0])];
    return this.clean(interleave(lists), exclude).slice(0, limit);
  }

  /** "Recommended songs" under a playlist: mixes of a few of its tracks, minus what is already in it. */
  async forPlaylist(tracks: MusicTrack[], limit: number): Promise<MusicTrack[]> {
    if (!tracks.length) return [];
    const own = new Set(tracks.map((t) => t.id));
    const picks = shuffled(tracks).slice(0, 3);
    let lists = await Promise.all(picks.map((t) => this.trackMix(t.id)));
    if (!lists.some((l) => l.length)) lists = [await this.artistFallback(picks[0])];
    return this.clean(interleave(lists), own).slice(0, Math.max(1, limit));
  }

  // ── Home ───────────────────────────────────────────────────────────────

  /**
   * Tracks to base recommendations on: favourites (weight 3), playlist tracks (2) and
   * history (1), adjusted by what the tracker learned, best first.
   */
  seeds(count = 50): MusicTrack[] {
    const fav = this.library.favorites().tracks;
    const playlists = this.library.playlists().flatMap((p) => p.tracks);
    const history = this.library.history().map((h) => h.track);
    return smartSeeds(this.tracker.data(), { favorites: fav, playlists, history }, count).filter((t) => !this.library.isBlocked(t));
  }

  /** Recommended songs for the home page, away from what the listener already has. */
  async forYouSongs(limit: number): Promise<MusicTrack[]> {
    const seeds = shuffled(this.seeds(20)).slice(0, 3);
    if (!seeds.length) return [];
    const known = new Set<number>([
      ...this.library.favorites().tracks.map((t) => t.id),
      ...this.library.playlists().flatMap((p) => p.tracks.map((t) => t.id)),
      ...this.library.history().map((h) => h.track.id),
    ]);
    seeds.forEach((t) => known.add(t.id));
    let lists = await Promise.all(seeds.map((t) => this.trackMix(t.id)));
    if (!lists.some((l) => l.length)) lists = [await this.artistFallback(seeds[0])];
    return this.clean(interleave(lists), known).slice(0, limit);
  }

  // ── internals ──────────────────────────────────────────────────────────

  private recentIds(): number[] {
    return this.library.history().slice(0, RECENT_RING).map((h) => h.track.id);
  }

  /** Dedupe, exclude, drop blocked and disliked/abandoned tracks, then rank by taste (stable). */
  private clean(tracks: MusicTrack[], exclude: Iterable<number>): MusicTrack[] {
    const unique = uniqueTracks(tracks, exclude).filter((t) => !this.library.isBlocked(t));
    return rankRecommendations(this.tracker.data(), filterRecommendations(this.tracker.data(), unique));
  }

  private async trackMix(id: number): Promise<MusicTrack[]> {
    try {
      return (await firstValueFrom(this.discovery.trackMix(id))).tracks;
    } catch {
      return [];
    }
  }

  private async artistMix(id: number): Promise<MusicTrack[]> {
    try {
      return (await firstValueFrom(this.discovery.artistMix(id))).tracks;
    } catch {
      return [];
    }
  }

  /** When a track has no mix of its own: the mix of its main artist. */
  private async artistFallback(t: MusicTrack): Promise<MusicTrack[]> {
    const artist = trackArtists(t)[0];
    return artist ? this.artistMix(artist.id) : [];
  }

  private async tracksOf(seed: RadioSeed): Promise<MusicTrack[]> {
    try {
      if (seed.kind === 'album') return (await firstValueFrom(this.music.album(seed.id))).tracks;
      if (seed.kind === 'playlist') return (await firstValueFrom(this.discovery.playlist(String(seed.id)))).tracks;
      if (seed.kind === 'mix') return (await firstValueFrom(this.discovery.mix(String(seed.id)))).tracks;
    } catch {
      // fall through: no seed tracks
    }
    return [];
  }
}
