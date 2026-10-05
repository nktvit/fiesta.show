import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { MusicAlbum, MusicArtist, MusicTrack } from './music.service';

/**
 * Catalogue extras behind `/api/music` (lib/music/catalog.js, lib/music/search.js).
 * Owned by package P8 (F0 wrote these thin wrappers; P8 may extend them).
 */

export type MusicSearchType = 'tracks' | 'albums' | 'artists' | 'playlists';
export type MusicDiscographyFilter = 'ALBUMS' | 'EPSANDSINGLES' | 'COMPILATIONS' | 'APPEARS_ON';

export interface MusicSuggestions {
  /** Plain query completions. */
  terms: string[];
  tracks: MusicTrack[];
  albums: MusicAlbum[];
  artists: MusicArtist[];
}

export interface MusicPage<T> {
  items: T[];
  total: number;
}

export interface MusicAlbumExtras {
  moreByArtist: MusicAlbum[];
  epsSingles: MusicAlbum[];
  similarAlbums: MusicAlbum[];
  similarArtists: MusicArtist[];
  copyright: string;
  releaseDate: string;
}

export interface MusicArtistLink {
  type: string;
  url: string;
}

export interface MusicAotyScore {
  critic?: number;
  user?: number;
  criticCount?: number;
  userCount?: number;
  mustHear?: boolean;
  url?: string;
}

/** An artist bio as plain text; `links` are the albums/artists it mentions, as Fiesta routes. */
export interface MusicArtistBio {
  text: string;
  source: string;
  links?: { label: string; route: string }[];
}

@Injectable({ providedIn: 'root' })
export class MusicCatalogService {
  private http = inject(HttpClient);

  private get<T>(action: string, params: Record<string, string | number> = {}): Observable<T> {
    return this.http.get<T>('/api/music', { params: { action, ...params } });
  }

  suggest(q: string): Observable<MusicSuggestions> {
    return this.get('suggest', { q });
  }

  /** One result type, paged (Load more). Playlists come back as MusicPlaylist. */
  searchType<T = unknown>(q: string, type: MusicSearchType, offset = 0, limit = 25): Observable<MusicPage<T>> {
    return this.get('search-type', { q, type, offset, limit });
  }

  /** A track plus the rest of its album. */
  track(id: number | string): Observable<{ track: MusicTrack; albumTracks: MusicTrack[]; album?: MusicAlbum | null }> {
    return this.get('track', { id });
  }

  /** Several tracks by id (shared playlists, imports). */
  tracks(ids: (number | string)[]): Observable<MusicTrack[]> {
    return this.get('tracks', { ids: ids.join(',') });
  }

  albumExtras(id: number | string): Observable<MusicAlbumExtras> {
    return this.get('album-extras', { id });
  }

  artistBio(id: number | string): Observable<MusicArtistBio> {
    return this.get('artist-bio', { id });
  }

  similarArtists(id: number | string): Observable<MusicArtist[]> {
    return this.get('similar-artists', { id });
  }

  similarAlbums(id: number | string): Observable<MusicAlbum[]> {
    return this.get('similar-albums', { id });
  }

  artistAlbums(id: number | string, filter: MusicDiscographyFilter, offset = 0, limit = 50): Observable<MusicPage<MusicAlbum>> {
    return this.get('artist-albums', { id, filter, offset, limit });
  }

  artistTopTracks(id: number | string, offset = 0, limit = 20): Observable<MusicPage<MusicTrack>> {
    return this.get('artist-toptracks', { id, offset, limit });
  }

  artistLinks(id: number | string): Observable<MusicArtistLink[]> {
    return this.get('artist-links', { id });
  }

  /** Album of the Year scores; null when the album isn't listed there. */
  aoty(title: string, artist: string): Observable<MusicAotyScore | null> {
    return this.get('aoty', { title, artist });
  }
}
