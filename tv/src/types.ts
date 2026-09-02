// Mirrors src/app/interfaces/movie.interface.ts and the /api/tmdb response
// shapes on the main app — kept as plain types (no shared package) since
// this is an intentionally separate build.

export interface Movie {
  imdbID: string;
  tmdbId?: number;
  mediaType?: 'movie' | 'tv';
  Title: string;
  Poster: string;
  Plot: string;
  Backdrop?: string;
  Rating?: number;
  Year?: string;
}

export interface CastMember {
  id: number;
  name: string;
  character: string;
  profilePath: string | null;
}

export interface MovieDetails {
  imdbID: string;
  Title: string;
  Plot: string;
  Poster: string;
  Type: 'movie' | 'series';
  Director?: string;
  Released?: string;
  Country?: string;
  Genre?: string;
  Runtime?: string;
  imdbRating?: string;
  Actors?: string;
}

export interface SeasonEpisode {
  number: number;
  title: string;
  rating: string | null;
  airDate: string | null;
  still: string | null;
}

export interface SubtitleTrack {
  lang: string;
  label: string;
  src: string;
}

export interface StreamResult {
  master: string;
  server: number | null;
  env: string;
}

export type MediaType = 'movie' | 'tv';
