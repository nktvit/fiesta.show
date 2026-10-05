import { HttpClient } from '@angular/common/http';
import { NgTemplateOutlet } from '@angular/common';
import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { MusicCatalogService } from '../../services/music-catalog.service';
import { MusicDiscoveryService } from '../../services/music-discovery.service';
import { MusicLibraryService } from '../../services/music-library.service';
import { MusicListeningTrackerService } from '../../services/music-listening-tracker.service';
import { MusicRecommenderService } from '../../services/music-recommender.service';
import { MusicSettingsService } from '../../services/music-settings.service';
import { MusicAlbum, MusicArtist, MusicLibraryItem, MusicMix, MusicPlaylist, MusicTrack, UserPlaylist } from '../../services/music.service';
import { shuffled } from '../../utils/music-recs-scoring';
import { MusicAlbumCardComponent } from '../music-album-card/music-album-card.component';
import { MusicArtistCardComponent } from '../music-artist-card/music-artist-card.component';
import { MusicPinsRowComponent } from '../music-pins-row/music-pins-row.component';
import { MusicPlaylistCardComponent } from '../music-playlist-card/music-playlist-card.component';
import { MusicRailComponent } from '../music-rail/music-rail.component';
import { MusicTrackRowComponent } from '../music-track-row/music-track-row.component';

/** One owner-curated entry of src/assets/music/editors-picks.json. */
export type EditorsPick =
  | ({ kind: 'album' } & MusicAlbum)
  | ({ kind: 'playlist' } & MusicPlaylist);

export const EDITORS_PICKS_URL = '/assets/music/editors-picks.json';

/** Home cards render the activity kinds that have a card. */
type ActivityCard =
  | { key: string; kind: 'album'; album: MusicAlbum }
  | { key: string; kind: 'artist'; artist: MusicArtist }
  | { key: string; kind: 'playlist'; playlist: MusicPlaylist | UserPlaylist | MusicMix };

type Load<T> = { status: 'idle' | 'loading' | 'done'; items: T[] };
const idle = <T>(): Load<T> => ({ status: 'idle', items: [] });

/** Recommendations are re-used for this long when the visitor comes back to the home. */
const CACHE_MS = 10 * 60 * 1000;
interface HomeCache {
  at: number;
  key: string;
  mixes: MusicMix[];
  songs: MusicTrack[];
  albums: MusicAlbum[];
  artists: MusicArtist[];
}
let homeCache: HomeCache | null = null;

/**
 * The /music home (no ?q=). With no history it shows the suggestion chips and Editors' picks.
 * Once there is some listening it adds Jump back in, Recently played, Mixes for you,
 * Recommended songs / albums / artists and Your playlists. Each section hides via
 * settings.homeSections. Owned by package P9.
 */
@Component({
  selector: 'app-music-home',
  imports: [
    NgTemplateOutlet, RouterLink, MusicAlbumCardComponent, MusicArtistCardComponent, MusicPlaylistCardComponent, MusicRailComponent,
    MusicTrackRowComponent, MusicPinsRowComponent,
  ],
  templateUrl: './music-home.component.html',
  host: { class: 'block' },
})
export class MusicHomeComponent implements OnInit {
  private router = inject(Router);
  private http = inject(HttpClient);
  private discovery = inject(MusicDiscoveryService);
  private catalog = inject(MusicCatalogService);
  private recommender = inject(MusicRecommenderService);
  private tracker = inject(MusicListeningTrackerService);
  protected readonly library = inject(MusicLibraryService);
  protected readonly settings = inject(MusicSettingsService);

  protected readonly suggestions = ['Daft Punk', 'Radiohead', 'Kendrick Lamar', 'Billie Eilish', 'Fleetwood Mac', 'Tame Impala'];
  protected readonly sections = this.settings.homeSections;

  /** Any listening, likes, visits or own playlists at all: switches the personal sections on. */
  protected readonly personal = computed(
    () =>
      this.library.history().length > 0 || this.library.favorites().tracks.length > 0 || this.library.activity().length > 0
      || this.library.playlists().length > 0,
  );

  protected readonly activity = computed<ActivityCard[]>(() => {
    const out: ActivityCard[] = [];
    for (const it of this.library.activity()) {
      if (this.library.isBlocked(it)) continue;
      const card = this.activityCard(it);
      if (card) out.push(card);
    }
    return out;
  });

  /** Last played tracks, newest first, without repeats. */
  protected readonly recent = computed<MusicTrack[]>(() => {
    const seen = new Set<number>();
    const out: MusicTrack[] = [];
    for (const h of this.library.history()) {
      if (seen.has(h.track.id) || this.library.isBlocked(h.track)) continue;
      seen.add(h.track.id);
      out.push(h.track);
      if (out.length >= 5) break;
    }
    return out;
  });

  protected readonly myPlaylists = computed(() => this.library.playlists().slice(0, 12));

  protected readonly picks = signal<EditorsPick[]>([]);
  protected readonly mixes = signal<Load<MusicMix>>(idle());
  protected readonly songs = signal<Load<MusicTrack>>(idle());
  protected readonly albums = signal<Load<MusicAlbum>>(idle());
  protected readonly artists = signal<Load<MusicArtist>>(idle());

  protected readonly visibleSongs = computed(() => this.songs().items.filter((t) => !this.library.isBlocked(t)));
  protected readonly visibleAlbums = computed(() => this.albums().items.filter((a) => !this.library.isBlocked({ kind: 'album', data: a })));
  protected readonly visibleArtists = computed(() => this.artists().items.filter((a) => !this.library.isBlocked({ kind: 'artist', data: a })));
  protected readonly pickAlbums = computed(() => this.picks().filter((p): p is { kind: 'album' } & MusicAlbum => p.kind === 'album' && !this.library.isBlocked({ kind: 'album', data: p })));
  protected readonly pickPlaylists = computed(() => this.picks().filter((p): p is { kind: 'playlist' } & MusicPlaylist => p.kind === 'playlist'));

  ngOnInit(): void {
    if (this.sections().picks) void this.loadPicks();
    if (this.personal()) this.loadPersonal(false);
  }

  protected search(q: string): void {
    void this.router.navigate(['/music'], { queryParams: { q } });
  }

  protected refresh(which: 'songs' | 'albums' | 'artists'): void {
    homeCache = null;
    if (which === 'songs') void this.loadSongs();
    if (which === 'albums') void this.loadAlbums();
    if (which === 'artists') void this.loadArtists();
  }

  // ── loading ────────────────────────────────────────────────────────────

  private async loadPicks(): Promise<void> {
    try {
      const j = await firstValueFrom(this.http.get<{ picks?: EditorsPick[] }>(EDITORS_PICKS_URL));
      this.picks.set((j.picks ?? []).filter((p) => p && (p.kind === 'album' || p.kind === 'playlist')));
    } catch {
      this.picks.set([]); // no curated list: the section just doesn't show
    }
  }

  private loadPersonal(force: boolean): void {
    const s = this.sections();
    const key = this.recommender.seeds(8).map((t) => t.id).join(',');
    if (!force && homeCache && homeCache.key === key && Date.now() - homeCache.at < CACHE_MS) {
      this.mixes.set({ status: 'done', items: homeCache.mixes });
      this.songs.set({ status: 'done', items: homeCache.songs });
      this.albums.set({ status: 'done', items: homeCache.albums });
      this.artists.set({ status: 'done', items: homeCache.artists });
      return;
    }
    const jobs: Promise<void>[] = [];
    if (s.mixes) jobs.push(this.loadMixes());
    if (s.forYou) jobs.push(this.loadSongs(), this.loadAlbums(), this.loadArtists());
    void Promise.all(jobs).then(() => {
      homeCache = {
        at: Date.now(), key, mixes: this.mixes().items, songs: this.songs().items, albums: this.albums().items, artists: this.artists().items,
      };
    });
  }

  /** "Mixes for you": the radio mix of a few of the most-played tracks, one per artist. */
  private async loadMixes(): Promise<void> {
    this.mixes.set({ status: 'loading', items: [] });
    const top = new Map(this.tracker.topTracks().map((t, i) => [t.id, i] as const));
    const ranked = this.recommender.seeds(40).sort((a, b) => (top.get(a.id) ?? 999) - (top.get(b.id) ?? 999));
    const picks: MusicTrack[] = [];
    const artists = new Set<number | null>();
    for (const t of ranked) {
      if (artists.has(t.artistId)) continue;
      artists.add(t.artistId);
      picks.push(t);
      if (picks.length >= 5) break;
    }
    const mixes = await Promise.all(
      picks.map(async (t): Promise<MusicMix | null> => {
        try {
          const { mixId } = await firstValueFrom(this.discovery.trackMixId(t.id));
          return mixId ? { id: mixId, title: `${t.title} Radio`, subTitle: t.artist, cover: t.cover, type: 'TRACK_MIX' } : null;
        } catch {
          return null;
        }
      }),
    );
    this.mixes.set({ status: 'done', items: mixes.filter((m): m is MusicMix => !!m) });
  }

  private async loadSongs(): Promise<void> {
    this.songs.set({ status: 'loading', items: [] });
    try {
      this.songs.set({ status: 'done', items: await this.recommender.forYouSongs(10) });
    } catch {
      this.songs.set({ status: 'done', items: [] });
    }
  }

  private async loadAlbums(): Promise<void> {
    this.albums.set({ status: 'loading', items: [] });
    try {
      const seed = shuffled(this.recommender.seeds(20)).find((t) => t.albumId);
      const items = seed?.albumId ? await firstValueFrom(this.catalog.similarAlbums(seed.albumId)) : [];
      this.albums.set({ status: 'done', items: items.slice(0, 12) });
    } catch {
      this.albums.set({ status: 'done', items: [] });
    }
  }

  private async loadArtists(): Promise<void> {
    this.artists.set({ status: 'loading', items: [] });
    try {
      const top = this.tracker.topArtists();
      const seedArtist = top.length ? top[Math.floor(Math.random() * Math.min(top.length, 3))].id : shuffled(this.recommender.seeds(20)).find((t) => t.artistId)?.artistId;
      const items = seedArtist ? await firstValueFrom(this.catalog.similarArtists(seedArtist)) : [];
      this.artists.set({ status: 'done', items: items.slice(0, 12) });
    } catch {
      this.artists.set({ status: 'done', items: [] });
    }
  }

  private activityCard(it: MusicLibraryItem): ActivityCard | null {
    switch (it.kind) {
      case 'album': return { key: 'album:' + it.data.id, kind: 'album', album: it.data };
      case 'artist': return { key: 'artist:' + it.data.id, kind: 'artist', artist: it.data };
      case 'playlist': return { key: 'playlist:' + it.data.uuid, kind: 'playlist', playlist: it.data };
      case 'mix': return { key: 'mix:' + it.data.id, kind: 'playlist', playlist: it.data };
      case 'userPlaylist': {
        const live = this.library.playlist(it.data.id);
        return live ? { key: 'user:' + live.id, kind: 'playlist', playlist: live } : null;
      }
      default: return null;
    }
  }
}
