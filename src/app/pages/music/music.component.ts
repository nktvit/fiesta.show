import { Component, computed, DestroyRef, inject, signal, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Meta, Title } from '@angular/platform-browser';
import { ActivatedRoute, Router } from '@angular/router';
import { catchError, distinctUntilChanged, firstValueFrom, map, of, switchMap, tap } from 'rxjs';
import { MusicAlbumCardComponent } from '../../components/music-album-card/music-album-card.component';
import { MusicArtistCardComponent } from '../../components/music-artist-card/music-artist-card.component';
import { MusicHomeComponent } from '../../components/music-home/music-home.component';
import { MusicPlaylistCardComponent } from '../../components/music-playlist-card/music-playlist-card.component';
import { MusicSearchSuggestComponent } from '../../components/music-search-suggest/music-search-suggest.component';
import { MusicSubnavComponent } from '../../components/music-subnav/music-subnav.component';
import { MusicTrackRowComponent } from '../../components/music-track-row/music-track-row.component';
import { NavbarComponent } from '../../components/navbar/navbar.component';
import { MusicCatalogService, MusicSearchType } from '../../services/music-catalog.service';
import { MusicLibraryService } from '../../services/music-library.service';
import { MusicAlbum, MusicArtist, MusicPlaylist, MusicService, MusicTrack } from '../../services/music.service';

export type MusicSearchTab = 'songs' | 'albums' | 'artists' | 'playlists';

export const MUSIC_SEARCH_TABS: readonly MusicSearchTab[] = ['songs', 'albums', 'artists', 'playlists'];
const PAGE = 20;
const API_TYPE: Record<MusicSearchTab, MusicSearchType> = { songs: 'tracks', albums: 'albums', artists: 'artists', playlists: 'playlists' };

interface Paging {
  /** Loaded at least once (the first page for songs/albums/artists comes with the search). */
  loaded: boolean;
  /** The last page came back full, so another may exist. */
  more: boolean;
  total: number | null;
  busy: boolean;
}

const emptyPaging = (): Record<MusicSearchTab, Paging> => ({
  songs: { loaded: false, more: false, total: null, busy: false },
  albums: { loaded: false, more: false, total: null, busy: false },
  artists: { loaded: false, more: false, total: null, busy: false },
  playlists: { loaded: false, more: false, total: null, busy: false },
});

/** /music: search box with suggestions and recent searches, result tabs, and the home shelves. */
@Component({
  selector: 'app-music',
  imports: [
    NavbarComponent, MusicTrackRowComponent, MusicSubnavComponent, MusicHomeComponent, MusicSearchSuggestComponent,
    MusicAlbumCardComponent, MusicArtistCardComponent, MusicPlaylistCardComponent,
  ],
  templateUrl: './music.component.html',
})
export class MusicComponent {
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private music = inject(MusicService);
  private catalog = inject(MusicCatalogService);
  private title = inject(Title);
  private meta = inject(Meta);
  protected readonly library = inject(MusicLibraryService);

  readonly tabs = MUSIC_SEARCH_TABS;
  readonly text = signal('');
  /** The query in the URL (what the results are for). */
  readonly q = signal('');
  readonly tab = signal<MusicSearchTab>('songs');
  readonly status = signal<'idle' | 'loading' | 'done' | 'error'>('idle');
  /** Suggestions only follow what the user types, never a query that came from the URL. */
  readonly suggestOn = signal(false);

  private readonly songs = signal<MusicTrack[]>([]);
  private readonly albums = signal<MusicAlbum[]>([]);
  private readonly artists = signal<MusicArtist[]>([]);
  private readonly playlists = signal<MusicPlaylist[]>([]);
  private readonly paging = signal<Record<MusicSearchTab, Paging>>(emptyPaging());

  readonly visibleSongs = computed(() => this.songs().filter((t) => !this.library.isBlocked(t)));
  readonly visibleAlbums = computed(() => this.albums().filter((a) => !this.library.isBlocked({ kind: 'album', data: a })));
  readonly visibleArtists = computed(() => this.artists().filter((a) => !this.library.isBlocked({ kind: 'artist', data: a })));
  readonly visiblePlaylists = computed(() => this.playlists());

  readonly current = computed(() => this.paging()[this.tab()]);
  readonly canLoadMore = computed(() => this.current().loaded && this.current().more);

  constructor() {
    this.setMeta('');

    // The query and the tab live in the URL (?q=&type=), so back/forward and shared links work.
    this.route.queryParamMap.pipe(takeUntilDestroyed(inject(DestroyRef))).subscribe((p) => {
      const type = p.get('type');
      this.tab.set(MUSIC_SEARCH_TABS.includes(type as MusicSearchTab) ? (type as MusicSearchTab) : 'songs');
      untracked(() => this.ensureTabLoaded());
    });

    this.route.queryParamMap
      .pipe(
        map((p) => (p.get('q') ?? '').trim()),
        distinctUntilChanged(),
        tap((q) => {
          this.q.set(q);
          this.text.set(q);
          this.setMeta(q);
        }),
        switchMap((q) => {
          this.resetResults();
          if (!q) {
            this.status.set('idle');
            return of(null);
          }
          this.status.set('loading');
          return this.music.search(q).pipe(
            tap((r) => {
              this.songs.set(r.tracks);
              this.albums.set(r.albums);
              this.artists.set(r.artists);
              this.paging.update((s) => ({
                ...s,
                songs: { ...s.songs, loaded: true, more: r.tracks.length >= PAGE },
                albums: { ...s.albums, loaded: true, more: r.albums.length >= PAGE },
                artists: { ...s.artists, loaded: true, more: r.artists.length >= PAGE },
              }));
              this.status.set('done');
              this.ensureTabLoaded();
            }),
            catchError(() => {
              this.status.set('error');
              return of(null);
            }),
          );
        }),
        takeUntilDestroyed(inject(DestroyRef)),
      )
      .subscribe();
  }

  private setMeta(q: string): void {
    this.title.setTitle(q ? `${q} | Stream Fiesta` : 'Music | Stream Fiesta');
    this.meta.updateTag({ name: 'description', content: q ? `Search results for ${q} on Stream Fiesta Music.` : 'Search and play lossless music.' });
  }

  private resetResults(): void {
    this.songs.set([]);
    this.albums.set([]);
    this.artists.set([]);
    this.playlists.set([]);
    this.paging.set(emptyPaging());
  }

  /** Playlists are not part of the combined search: fetch the first page when its tab opens. */
  private ensureTabLoaded(): void {
    if (this.tab() === 'playlists' && this.q() && this.status() === 'done' && !this.paging().playlists.loaded && !this.paging().playlists.busy) {
      void this.loadMore();
    }
  }

  onInput(event: Event): void {
    this.text.set((event.target as HTMLInputElement).value);
    this.suggestOn.set(true);
  }

  submit(event: Event): void {
    event.preventDefault();
    this.run(this.text());
  }

  /** Run a search for `text`. */
  run(text: string): void {
    const value = text.trim();
    this.suggestOn.set(false);
    if (value) this.library.addSearch(value);
    this.text.set(value);
    void this.router.navigate([], { queryParams: { q: value || null, type: null }, queryParamsHandling: 'merge' });
  }

  /** Used by the home chips and the recent-search chips. */
  search(q: string): void {
    this.run(q);
  }

  removeRecent(q: string): void {
    this.library.removeSearch(q);
  }

  clearRecents(): void {
    this.library.clearSearches();
  }

  selectTab(t: MusicSearchTab): void {
    void this.router.navigate([], { queryParams: { type: t === 'songs' ? null : t }, queryParamsHandling: 'merge', replaceUrl: true });
  }

  /** Append the next 20 of the current tab (action=search-type). */
  async loadMore(): Promise<void> {
    const tab = this.tab();
    const q = this.q();
    const state = this.paging()[tab];
    if (!q || state.busy) return;
    const offset = { songs: this.songs().length, albums: this.albums().length, artists: this.artists().length, playlists: this.playlists().length }[tab];
    this.setPaging(tab, { busy: true });
    try {
      const page = await firstValueFrom(this.catalog.searchType<MusicTrack & MusicAlbum & MusicArtist & MusicPlaylist>(q, API_TYPE[tab], offset, PAGE));
      if (q !== this.q()) return;
      const items = page.items ?? [];
      switch (tab) {
        case 'songs': this.songs.update((l) => mergeById(l, items as MusicTrack[], (x) => x.id)); break;
        case 'albums': this.albums.update((l) => mergeById(l, items as MusicAlbum[], (x) => x.id)); break;
        case 'artists': this.artists.update((l) => mergeById(l, items as MusicArtist[], (x) => x.id)); break;
        default: this.playlists.update((l) => mergeById(l, items as MusicPlaylist[], (x) => x.uuid)); break;
      }
      const have = { songs: this.songs().length, albums: this.albums().length, artists: this.artists().length, playlists: this.playlists().length }[tab];
      this.setPaging(tab, { loaded: true, busy: false, total: page.total, more: items.length >= PAGE && (page.total === null || have < page.total) });
    } catch {
      this.setPaging(tab, { busy: false, loaded: true, more: false });
    }
  }

  private setPaging(tab: MusicSearchTab, patch: Partial<Paging>): void {
    this.paging.update((s) => ({ ...s, [tab]: { ...s[tab], ...patch } }));
  }

  tabLabel(t: MusicSearchTab): string {
    return t.charAt(0).toUpperCase() + t.slice(1);
  }

  protected onKeydown(e: KeyboardEvent, suggest: MusicSearchSuggestComponent): void {
    suggest.handleKey(e);
  }
}

function mergeById<T>(list: T[], more: T[], id: (x: T) => string | number): T[] {
  const seen = new Set(list.map(id));
  return [...list, ...more.filter((x) => !seen.has(id(x)))];
}
