import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';

export interface MusicTrack {
  id: number;
  title: string;
  artist: string;
  artistId: number | null;
  album: string;
  albumId: number | null;
  cover: string;
  /** Seconds. */
  duration: number;
  explicit: boolean;
  trackNumber: number;
  quality: string;
}

export interface MusicAlbum {
  id: number;
  title: string;
  artist: string;
  cover: string;
  year: string;
  tracks: number;
  duration: number;
  quality: string;
}

export interface MusicArtist {
  id: number;
  name: string;
  picture: string;
}

export interface MusicSearchResult {
  tracks: MusicTrack[];
  albums: MusicAlbum[];
  artists: MusicArtist[];
}

/** How to play a track; produced by `/api/music?action=manifest`. */
export interface MusicManifest {
  /** FULL needs a signed-in TIDAL subscription; PREVIEW is 30 seconds. */
  presentation: 'FULL' | 'PREVIEW';
  quality: string;
  signedIn: boolean;
  kind: 'segments' | 'file';
  codec: string;
  // kind === 'segments'
  sampleRate?: number;
  init?: string;
  /** Append `&n=<segment number, from 1>`. */
  media?: string;
  /** Seconds per segment. */
  durations?: number[];
  // kind === 'file'
  mime?: string;
  url?: string;
}

@Injectable({ providedIn: 'root' })
export class MusicService {
  private http = inject(HttpClient);

  search(q: string): Observable<MusicSearchResult> {
    return this.http.get<MusicSearchResult>('/api/music', { params: { action: 'search', q } });
  }

  album(id: number | string): Observable<{ album: MusicAlbum; tracks: MusicTrack[] }> {
    return this.http.get<{ album: MusicAlbum; tracks: MusicTrack[] }>('/api/music', {
      params: { action: 'album', id },
    });
  }

  artist(id: number | string): Observable<{ artist: MusicArtist; topTracks: MusicTrack[]; albums: MusicAlbum[] }> {
    return this.http.get<{ artist: MusicArtist; topTracks: MusicTrack[]; albums: MusicAlbum[] }>('/api/music', {
      params: { action: 'artist', id },
    });
  }

  manifest(id: number | string, quality: 'LOSSLESS' | 'HIGH' | 'LOW'): Observable<MusicManifest> {
    return this.http.get<MusicManifest>('/api/music', { params: { action: 'manifest', id, quality } });
  }
}
