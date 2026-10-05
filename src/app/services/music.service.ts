import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';

/** A credited artist, as TIDAL lists them on a track or album. */
export interface MusicArtistRef {
  id: number;
  name: string;
}

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
  // Optional extras (absent on tracks stored before they existed).
  isrc?: string;
  artists?: MusicArtistRef[];
  copyright?: string;
  popularity?: number;
  bpm?: number;
  /** ISO date: when the track started streaming, else the album's release date. */
  releaseDate?: string;
  version?: string;
  /** TIDAL's track ReplayGain in dB, from the catalogue (the manifest's value wins). */
  replayGain?: number;
  /** Linear peak amplitude, from the catalogue. */
  peak?: number;
}

export type MusicAlbumType = 'ALBUM' | 'EP' | 'SINGLE' | 'COMPILATION';

export interface MusicAlbum {
  id: number;
  title: string;
  artist: string;
  cover: string;
  year: string;
  tracks: number;
  duration: number;
  quality: string;
  artistId?: number | null;
  artists?: MusicArtistRef[];
  type?: MusicAlbumType;
  releaseDate?: string;
  explicit?: boolean;
  copyright?: string;
  popularity?: number;
}

export interface MusicArtist {
  id: number;
  name: string;
  picture: string;
  popularity?: number;
  /** TIDAL artist role categories ("Artist", "Songwriter", ...). */
  roles?: string[];
}

/** A TIDAL (editorial or user) playlist. */
export interface MusicPlaylist {
  uuid: string;
  title: string;
  description: string;
  cover: string;
  creator: string;
  /** Number of tracks. */
  tracks: number;
  /** Seconds. */
  duration: number;
  lastUpdated: string;
}

/** A TIDAL mix (My Mix, track radio, artist radio). */
export interface MusicMix {
  id: string;
  title: string;
  subTitle: string;
  cover: string;
  type: string;
}

/** A playlist the visitor made, kept in their browser (MusicLibraryService). */
export interface UserPlaylist {
  id: string;
  name: string;
  description: string;
  /** URL or downscaled data URL; absent means "auto collage". */
  cover?: string;
  tracks: (MusicTrack & { addedAt: number })[];
  createdAt: number;
  updatedAt: number;
  folderId?: string | null;
}

/** Anything the library can like, pin, block or a menu can act on. */
export type MusicLibraryItem =
  | { kind: 'track'; data: MusicTrack }
  | { kind: 'album'; data: MusicAlbum }
  | { kind: 'artist'; data: MusicArtist }
  | { kind: 'playlist'; data: MusicPlaylist }
  | { kind: 'mix'; data: MusicMix }
  | { kind: 'userPlaylist'; data: UserPlaylist };

export type MusicLibraryKind = MusicLibraryItem['kind'];

export interface MusicSearchResult {
  tracks: MusicTrack[];
  albums: MusicAlbum[];
  artists: MusicArtist[];
}

/** Streaming tiers the manifest action accepts. */
export type MusicQuality = 'LOW' | 'HIGH' | 'LOSSLESS' | 'HI_RES_LOSSLESS';

/** How to play a track; produced by `/api/music?action=manifest`. */
export interface MusicManifest {
  /** FULL needs a signed-in TIDAL subscription; PREVIEW is 30 seconds. */
  presentation: 'FULL' | 'PREVIEW';
  quality: string;
  signedIn: boolean;
  kind: 'segments' | 'file';
  codec: string;
  // Loudness normalisation from TIDAL playbackinfo, when provided.
  /** dB. */
  trackReplayGain?: number;
  /** Linear 0..1. */
  trackPeakAmplitude?: number;
  /** dB. */
  albumReplayGain?: number;
  /** Linear 0..1. */
  albumPeakAmplitude?: number;
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

  manifest(id: number | string, quality: MusicQuality): Observable<MusicManifest> {
    return this.http.get<MusicManifest>('/api/music', { params: { action: 'manifest', id, quality } });
  }
}
