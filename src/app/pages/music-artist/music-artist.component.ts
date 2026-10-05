import { Component, computed, DestroyRef, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Meta, Title } from '@angular/platform-browser';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { catchError, EMPTY, firstValueFrom, merge, switchMap, tap } from 'rxjs';
import { MusicAlbumCardComponent } from '../../components/music-album-card/music-album-card.component';
import { MusicArtistBackdropComponent } from '../../components/music-artist-backdrop/music-artist-backdrop.component';
import { MusicArtistGalleryComponent } from '../../components/music-artist-gallery/music-artist-gallery.component';
import { MusicArtistBioComponent } from '../../components/music-artist-bio/music-artist-bio.component';
import { MusicArtistCardComponent } from '../../components/music-artist-card/music-artist-card.component';
import { MusicLikeButtonComponent } from '../../components/music-like-button/music-like-button.component';
import { MusicSubnavComponent } from '../../components/music-subnav/music-subnav.component';
import { MusicTrackRowComponent } from '../../components/music-track-row/music-track-row.component';
import { NavbarComponent } from '../../components/navbar/navbar.component';
import { MusicArtistImage, MusicCatalogService, MusicDiscographyFilter } from '../../services/music-catalog.service';
import { MusicLibraryService } from '../../services/music-library.service';
import { MusicPlayerService } from '../../services/music-player.service';
import { MusicSettingsService } from '../../services/music-settings.service';
import { MusicToastService } from '../../services/music-toast.service';
import { MusicAlbum, MusicArtist, MusicLibraryItem, MusicService, MusicTrack } from '../../services/music.service';
import { artistThemeVars } from '../../utils/music-artist-theme';
import { ArtistPalette, imagePalette } from '../../utils/music-color';
import { tidalImage } from '../../utils/music-format';
import { shareMusicLink } from '../../utils/music-links';

/**
 * Glass panel: translucent tinted fill over the palette gradient, blur, hairline border, soft shadow.
 * Opaque tinted fill without backdrop-filter support (unprefixed or -webkit-) and under
 * prefers-reduced-transparency. Tailwind adds the -webkit- prefix for backdrop-blur itself.
 */
export const GLASS_PANEL =
  'rounded-2xl border border-white/15 bg-white/[0.08] shadow-[0_8px_32px_rgba(0,0,0,0.35)] backdrop-blur-xl [&_.text-gray-400]:text-gray-300 ' +
  '[@supports_not_((backdrop-filter:blur(1px))_or_(-webkit-backdrop-filter:blur(1px)))]:bg-[var(--ag-panel,#161616)] ' +
  '[@supports_not_((backdrop-filter:blur(1px))_or_(-webkit-backdrop-filter:blur(1px)))]:backdrop-blur-none ' +
  '[@media(prefers-reduced-transparency:reduce)]:bg-[var(--ag-panel,#161616)] [@media(prefers-reduced-transparency:reduce)]:backdrop-blur-none';
/** Same panel without blur, for Settings > reduce blur. */
export const GLASS_PANEL_SOLID = 'rounded-2xl border border-white/15 bg-[var(--ag-panel,#161616)] shadow-[0_8px_32px_rgba(0,0,0,0.35)] [&_.text-gray-400]:text-gray-300';

const PAGE = 30;
const SHUFFLE_ALBUMS = 10;
const TOP_PAGE = 20;

export const ARTIST_FILTERS: readonly { id: MusicDiscographyFilter; label: string }[] = [
  { id: 'ALBUMS', label: 'Albums' },
  { id: 'EPSANDSINGLES', label: 'EPs & Singles' },
  { id: 'COMPILATIONS', label: 'Compilations' },
  { id: 'APPEARS_ON', label: 'Appears on' },
];

interface Disco {
  items: MusicAlbum[];
  loaded: boolean;
  more: boolean;
  busy: boolean;
}

const emptyDisco = (): Record<MusicDiscographyFilter, Disco> => ({
  ALBUMS: { items: [], loaded: false, more: false, busy: false },
  EPSANDSINGLES: { items: [], loaded: false, more: false, busy: false },
  COMPILATIONS: { items: [], loaded: false, more: false, busy: false },
  APPEARS_ON: { items: [], loaded: false, more: false, busy: false },
});

function shuffled<T>(list: T[]): T[] {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** /music/artist/:id */
@Component({
  selector: 'app-music-artist',
  imports: [
    NavbarComponent, RouterLink, MusicTrackRowComponent, MusicSubnavComponent, MusicAlbumCardComponent,
    MusicArtistCardComponent, MusicLikeButtonComponent, MusicArtistBioComponent, MusicArtistBackdropComponent, MusicArtistGalleryComponent,
  ],
  templateUrl: './music-artist.component.html',
})
export class MusicArtistComponent {
  private route = inject(ActivatedRoute);
  private music = inject(MusicService);
  private catalog = inject(MusicCatalogService);
  private title = inject(Title);
  private meta = inject(Meta);
  private toast = inject(MusicToastService);
  private library = inject(MusicLibraryService);
  protected readonly player = inject(MusicPlayerService);
  protected readonly settings = inject(MusicSettingsService);

  readonly filters = ARTIST_FILTERS;
  readonly artist = signal<MusicArtist | null>(null);
  private readonly top = signal<MusicTrack[]>([]);
  readonly topMore = signal(false);
  readonly topBusy = signal(false);
  readonly topExpanded = signal(false);
  private readonly disco = signal<Record<MusicDiscographyFilter, Disco>>(emptyDisco());
  readonly filter = signal<MusicDiscographyFilter>('ALBUMS');
  private readonly similar = signal<MusicArtist[]>([]);
  readonly status = signal<'loading' | 'done' | 'error'>('loading');
  readonly shuffleBusy = signal(false);
  /** Pictures of the artist (artist-images action); [] until loaded or when none exist. */
  readonly images = signal<MusicArtistImage[]>([]);
  /** Colour theme from the artist's picture; null = indigo fallback look. */
  readonly palette = signal<ArtistPalette | null>(null);
  /** `--ag-*` custom properties bound on the page root; every one null (removed) without a palette. */
  readonly theme = computed(() => artistThemeVars(this.palette()));
  /** Backdrop rotation: the portrait first (instant), then up to two photos from other sources. */
  readonly backdropUrls = computed(() => {
    const a = this.artist();
    const first = a?.picture ? [tidalImage(a.picture, 750)] : [];
    const photos = this.images().filter((i) => i.kind === 'photo' && i.source !== 'tidal').map((i) => i.url);
    return [...new Set([...first, ...photos])].slice(0, 3);
  });
  /** Gallery pictures; a gallery of one is not shown. */
  readonly gallery = computed(() => (this.images().length >= 2 ? this.images() : []));
  protected readonly glassPanel = computed(() => (this.settings.reduceBlur() ? GLASS_PANEL_SOLID : GLASS_PANEL));
  protected readonly portrait = computed(() => {
    const a = this.artist();
    if (a?.picture) return tidalImage(a.picture, 750);
    // TIDAL has no picture for this artist: the best photo we found stands in.
    return this.images().find((i) => i.kind === 'photo')?.url ?? '';
  });

  readonly item = computed<MusicLibraryItem | null>(() => {
    const a = this.artist();
    return a ? { kind: 'artist', data: a } : null;
  });
  readonly topTracks = computed(() => this.top().filter((t) => !this.library.isBlocked(t)));
  /** The first five on the page until "Show all" expands the list. */
  readonly shownTop = computed(() => (this.topExpanded() ? this.topTracks() : this.topTracks().slice(0, 5)));
  readonly canExpandTop = computed(() => !this.topExpanded() && (this.topTracks().length > 5 || this.topMore()));
  readonly similarArtists = computed(() => this.similar().filter((a) => !this.library.isBlocked({ kind: 'artist', data: a })));
  readonly currentDisco = computed(() => this.disco()[this.filter()]);
  readonly albums = computed(() => this.currentDisco().items.filter((a) => !this.library.isBlocked({ kind: 'album', data: a })));
  /** Pills for lists that have content (Albums always stays). */
  readonly pills = computed(() => this.filters.filter((f) => f.id === 'ALBUMS' || !this.disco()[f.id].loaded || this.disco()[f.id].items.length > 0));
  /** Liked songs by this artist. */
  readonly inLibrary = computed(() => {
    const a = this.artist();
    if (!a) return [];
    return this.library.favorites().tracks.filter((t) => t.artistId === a.id || !!t.artists?.some((x) => x.id === a.id)).filter((t) => !this.library.isBlocked(t));
  });

  constructor() {
    this.route.paramMap
      .pipe(
        tap(() => {
          this.status.set('loading');
          this.top.set([]);
          this.topExpanded.set(false);
          this.topMore.set(false);
          this.disco.set(emptyDisco());
          this.filter.set('ALBUMS');
          this.similar.set([]);
          this.images.set([]);
          this.palette.set(null);
        }),
        switchMap((p) => {
          const id = p.get('id') ?? '';
          return this.music.artist(id).pipe(
            tap((r) => {
              this.artist.set(r.artist);
              this.top.set(r.topTracks);
              this.topMore.set(r.topTracks.length >= 10);
              this.disco.update((d) => ({ ...d, ALBUMS: { items: r.albums, loaded: true, more: r.albums.length >= PAGE, busy: false } }));
              this.status.set('done');
              this.title.setTitle(`${r.artist.name} | Stream Fiesta`);
              this.meta.updateTag({ name: 'description', content: `Listen to ${r.artist.name}: top songs and albums in lossless on Stream Fiesta.` });
              this.library.recordActivity({ kind: 'artist', data: r.artist });
              if (r.artist.picture) void this.applyPalette(tidalImage(r.artist.picture, 320), id);
            }),
            switchMap(() =>
              merge(
                this.catalog.artistImages(id).pipe(
                  tap((l) => {
                    if (String(this.artist()?.id) !== id) return;
                    this.images.set(l);
                    // No portrait from TIDAL (or its colours failed to load): theme from the first pictures we found.
                    if (!this.palette()) void this.paletteFromImages(l.filter((i) => i.kind === 'photo').slice(0, 2).map((i) => i.url), id);
                  }),
                  catchError(() => EMPTY),
                ),
                this.catalog.similarArtists(id).pipe(tap((l) => this.similar.set(l)), catchError(() => EMPTY)),
                ...(['EPSANDSINGLES', 'COMPILATIONS', 'APPEARS_ON'] as const).map((f) =>
                  this.catalog.artistAlbums(id, f, 0, PAGE).pipe(
                    tap((page) => this.setDisco(f, { items: page.items, loaded: true, more: page.items.length >= PAGE })),
                    catchError(() => {
                      this.setDisco(f, { items: [], loaded: true, more: false });
                      return EMPTY;
                    }),
                  ),
                ),
              ),
            ),
            catchError(() => {
              if (this.status() !== 'done') this.status.set('error');
              return EMPTY;
            }),
          );
        }),
        takeUntilDestroyed(inject(DestroyRef)),
      )
      .subscribe();
  }

  /** Reads the colours of `url` and, if this artist is still showing, fades the theme in. */
  private async applyPalette(url: string, id: string): Promise<void> {
    const p = await imagePalette(url);
    if (p && String(this.artist()?.id) === String(id)) this.palette.set(p);
  }

  private async paletteFromImages(urls: string[], id: string): Promise<void> {
    for (const u of urls) {
      if (this.palette() || String(this.artist()?.id) !== String(id)) return;
      await this.applyPalette(u, id);
    }
  }

  private setDisco(f: MusicDiscographyFilter, patch: Partial<Disco>): void {
    this.disco.update((d) => ({ ...d, [f]: { ...d[f], ...patch } }));
  }

  selectFilter(f: MusicDiscographyFilter): void {
    this.filter.set(f);
  }

  async loadMoreAlbums(): Promise<void> {
    const a = this.artist();
    const f = this.filter();
    const state = this.disco()[f];
    if (!a || state.busy) return;
    this.setDisco(f, { busy: true });
    try {
      const page = await firstValueFrom(this.catalog.artistAlbums(a.id, f, state.items.length, PAGE));
      if (this.artist()?.id !== a.id) return;
      const seen = new Set(state.items.map((x) => x.id));
      const fresh = page.items.filter((x) => !seen.has(x.id));
      this.setDisco(f, { items: [...state.items, ...fresh], busy: false, more: page.items.length >= PAGE && fresh.length > 0 });
    } catch {
      this.setDisco(f, { busy: false, more: false });
    }
  }

  /** "Show all": reveal the loaded top songs, then page through the rest. */
  async showAllTop(): Promise<void> {
    this.topExpanded.set(true);
    if (this.topMore()) await this.loadMoreTop();
  }

  async loadMoreTop(): Promise<void> {
    const a = this.artist();
    if (!a || this.topBusy()) return;
    this.topBusy.set(true);
    try {
      const have = this.top().length;
      const page = await firstValueFrom(this.catalog.artistTopTracks(a.id, have, TOP_PAGE));
      if (this.artist()?.id !== a.id) return;
      const seen = new Set(this.top().map((t) => t.id));
      const fresh = page.items.filter((t) => !seen.has(t.id));
      this.top.update((l) => [...l, ...fresh]);
      this.topMore.set(page.items.length >= TOP_PAGE && fresh.length > 0 && (page.total === null || this.top().length < page.total));
    } catch {
      this.topMore.set(false);
    } finally {
      this.topBusy.set(false);
    }
  }

  playTop(): void {
    const a = this.artist();
    const t = this.topTracks();
    if (a && t.length) void this.player.play(t[0], t, { context: { type: 'artist', id: a.id, label: a.name } });
  }

  /** Shuffle the whole discography: the tracks of up to 10 albums, mixed. */
  async shuffleAll(): Promise<void> {
    const a = this.artist();
    if (!a || this.shuffleBusy()) return;
    this.shuffleBusy.set(true);
    try {
      const d = this.disco();
      const source = [...d.ALBUMS.items, ...d.EPSANDSINGLES.items].filter((x) => !this.library.isBlocked({ kind: 'album', data: x }));
      const picked = source.slice(0, SHUFFLE_ALBUMS);
      const lists = await Promise.all(picked.map((al) => firstValueFrom(this.music.album(al.id)).then((r) => r.tracks).catch(() => [] as MusicTrack[])));
      const seen = new Set<number>();
      let tracks = lists.flat().filter((t) => !this.library.isBlocked(t) && !seen.has(t.id) && !!seen.add(t.id));
      if (!tracks.length) tracks = this.topTracks();
      if (!tracks.length) throw new Error('empty');
      tracks = shuffled(tracks);
      await this.player.play(tracks[0], tracks, { shuffle: true, context: { type: 'artist', id: a.id, label: a.name } });
    } catch {
      this.toast.show({ message: `Couldn't shuffle ${a.name}`, tone: 'warn' });
    } finally {
      this.shuffleBusy.set(false);
    }
  }

  radio(): void {
    const a = this.artist();
    if (a) void this.player.startRadio({ kind: 'artist', id: a.id, label: a.name });
  }

  async share(): Promise<void> {
    const a = this.artist();
    if (!a) return;
    const r = await shareMusicLink({ title: a.name, path: `/music/artist/${a.id}` });
    if (r === 'copied') this.toast.show({ message: 'Link copied' });
    else if (r === 'failed') this.toast.show({ message: "Couldn't copy the link", tone: 'warn' });
  }
}
