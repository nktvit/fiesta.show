import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { MusicAlbum, MusicArtist, MusicMix, MusicPlaylist, MusicTrack } from './music.service';

/**
 * Discovery data behind `/api/music` (lib/music/discovery.js): mixes, radio,
 * TIDAL playlists, explore and page shelves.
 * Owned by package P9 (F0 wrote these thin wrappers; P9 may extend them).
 */

export type MusicShelfKind = 'tracks' | 'albums' | 'artists' | 'playlists' | 'mixes' | 'links';

/** A link shelf item (genre/mood page) on explore. */
export interface MusicPageLink {
  title: string;
  /** Whitelisted TIDAL page path, for `page(path)`. */
  path: string;
  cover?: string;
}

export interface MusicShelf {
  title: string;
  kind: MusicShelfKind;
  items: (MusicTrack | MusicAlbum | MusicArtist | MusicPlaylist | MusicMix | MusicPageLink)[];
}

export interface MusicPageSections {
  /** The page's own title ("Hip-Hop"); empty on explore's root. */
  title?: string;
  sections: MusicShelf[];
}

@Injectable({ providedIn: 'root' })
export class MusicDiscoveryService {
  private http = inject(HttpClient);

  private get<T>(action: string, params: Record<string, string | number> = {}): Observable<T> {
    return this.http.get<T>('/api/music', { params: { action, ...params } });
  }

  mix(id: string): Observable<{ mix: MusicMix; tracks: MusicTrack[] }> {
    return this.get('mix', { id });
  }

  /** TIDAL's radio for a track. */
  trackMix(id: number | string): Observable<{ mixId: string; tracks: MusicTrack[] }> {
    return this.get('track-mix', { id });
  }

  /** Only the id of a track's mix (cheap: no songs), for linking to /music/mix/:id. Empty when TIDAL has none. */
  trackMixId(id: number | string): Observable<{ mixId: string; tracks: MusicTrack[] }> {
    return this.get('track-mix', { id, mixOnly: 1 });
  }

  /** TIDAL's radio for an artist. */
  artistMix(id: number | string): Observable<{ mixId: string; tracks: MusicTrack[] }> {
    return this.get('artist-mix', { id });
  }

  playlist(uuid: string, offset = 0): Observable<{ playlist: MusicPlaylist; tracks: MusicTrack[]; total: number }> {
    return this.get('playlist', { id: uuid, offset });
  }

  explore(): Observable<MusicPageSections> {
    return this.get('explore');
  }

  page(path: string): Observable<MusicPageSections> {
    return this.get('page', { path });
  }
}
