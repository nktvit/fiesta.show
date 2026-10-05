import { Component, computed, DestroyRef, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Meta, Title } from '@angular/platform-browser';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { catchError, map, of, switchMap, tap } from 'rxjs';
import { MusicAlbumCardComponent } from '../../components/music-album-card/music-album-card.component';
import { MusicArtistCardComponent } from '../../components/music-artist-card/music-artist-card.component';
import { MusicPlaylistCardComponent } from '../../components/music-playlist-card/music-playlist-card.component';
import { MusicRailComponent } from '../../components/music-rail/music-rail.component';
import { MusicSubnavComponent } from '../../components/music-subnav/music-subnav.component';
import { MusicTrackRowComponent } from '../../components/music-track-row/music-track-row.component';
import { NavbarComponent } from '../../components/navbar/navbar.component';
import { MusicDiscoveryService, MusicPageLink, MusicPageSections, MusicShelf } from '../../services/music-discovery.service';
import { MusicLibraryService } from '../../services/music-library.service';
import { MusicAlbum, MusicArtist, MusicMix, MusicPlaylist, MusicTrack } from '../../services/music.service';

/** A shelf with its items narrowed to one kind, so the template needs no casts. */
export type ExploreShelf =
  | { kind: 'links'; title: string; items: MusicPageLink[] }
  | { kind: 'albums'; title: string; items: MusicAlbum[] }
  | { kind: 'artists'; title: string; items: MusicArtist[] }
  | { kind: 'playlists'; title: string; items: MusicPlaylist[] }
  | { kind: 'mixes'; title: string; items: MusicMix[] }
  | { kind: 'tracks'; title: string; items: MusicTrack[] };

/** Same rule as the backend: `pages/<slug>`. Anything else in ?page= is ignored. */
export function explorePagePath(raw: string | null): string | null {
  return raw && /^pages\/[a-z0-9_-]{1,64}$/.test(raw) ? raw : null;
}

/** Route /music/explore (?page=<whitelisted TIDAL page path>): genres, moods and decades. */
@Component({
  selector: 'app-music-explore',
  imports: [
    NavbarComponent, RouterLink, MusicSubnavComponent, MusicRailComponent, MusicAlbumCardComponent, MusicArtistCardComponent,
    MusicPlaylistCardComponent, MusicTrackRowComponent,
  ],
  templateUrl: './music-explore.component.html',
})
export class MusicExploreComponent {
  private route = inject(ActivatedRoute);
  private discovery = inject(MusicDiscoveryService);
  private title = inject(Title);
  private meta = inject(Meta);
  private library = inject(MusicLibraryService);

  /** The drilled-into page path, or null on explore's root. */
  readonly page = signal<string | null>(null);
  readonly heading = signal('Explore');
  private readonly rawShelves = signal<MusicShelf[]>([]);
  readonly status = signal<'loading' | 'done' | 'unavailable'>('loading');

  readonly shelves = computed<ExploreShelf[]>(() => {
    const out: ExploreShelf[] = [];
    for (const s of this.rawShelves()) {
      const shelf = this.narrow(s);
      if (shelf && shelf.items.length) out.push(shelf);
    }
    return out;
  });

  constructor() {
    this.setMeta('Explore');
    this.route.queryParamMap
      .pipe(
        map((q) => explorePagePath(q.get('page'))),
        tap((p) => {
          this.page.set(p);
          this.status.set('loading');
          this.rawShelves.set([]);
        }),
        switchMap((p) =>
          (p ? this.discovery.page(p) : this.discovery.explore()).pipe(
            catchError(() => of<MusicPageSections | null>(null)),
          ),
        ),
        takeUntilDestroyed(inject(DestroyRef)),
      )
      .subscribe((r) => {
        if (!r || !r.sections.length) {
          this.heading.set('Explore');
          this.status.set('unavailable');
          return;
        }
        const name = r.title && this.page() ? r.title : 'Explore';
        this.heading.set(name);
        this.setMeta(name);
        this.rawShelves.set(r.sections);
        this.status.set('done');
      });
  }

  private setMeta(name: string): void {
    this.title.setTitle(name === 'Explore' ? 'Explore Music | Stream Fiesta' : `${name} | Explore Music | Stream Fiesta`);
    this.meta.updateTag({
      name: 'description',
      content: name === 'Explore' ? 'Browse music by genre, mood and decade on Stream Fiesta.' : `${name}: playlists, albums and artists to explore on Stream Fiesta.`,
    });
  }

  private narrow(s: MusicShelf): ExploreShelf | null {
    switch (s.kind) {
      case 'links': return { kind: 'links', title: s.title, items: s.items as MusicPageLink[] };
      case 'albums': return { kind: 'albums', title: s.title, items: (s.items as MusicAlbum[]).filter((a) => !this.library.isBlocked({ kind: 'album', data: a })) };
      case 'artists': return { kind: 'artists', title: s.title, items: (s.items as MusicArtist[]).filter((a) => !this.library.isBlocked({ kind: 'artist', data: a })) };
      case 'playlists': return { kind: 'playlists', title: s.title, items: s.items as MusicPlaylist[] };
      case 'mixes': return { kind: 'mixes', title: s.title, items: s.items as MusicMix[] };
      case 'tracks': return { kind: 'tracks', title: s.title, items: (s.items as MusicTrack[]).filter((t) => !this.library.isBlocked(t)).slice(0, 10) };
      default: return null;
    }
  }
}
