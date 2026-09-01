// Thin fetch wrappers over the SAME /api/* serverless endpoints the main
// Angular app calls in production (src/app/services/{movie,tmdb}.service.ts)
// — no backend duplication. This client always talks relative /api/* paths;
// there's no dev-mode direct-to-TMDB/OMDB branch like the Angular services
// have, since this bundle only ever runs against the deployed domain.

import { Movie, MovieDetails, SeasonEpisode, SubtitleTrack, StreamResult, MediaType } from './types';

async function getJSON(url: string): Promise<any> {
  const res = await fetch(url);
  const data = await res.json().catch(function () { return {}; });
  if (!res.ok) throw new Error((data && data.error) || 'request failed (' + res.status + ')');
  return data;
}

export function getList(list: string): Promise<Movie[]> {
  return getJSON('/api/tmdb?list=' + list)
    .then(function (r) { return r.movies || []; })
    .catch(function () { return []; });
}

export function discoverByGenre(genreId: number, page: number): Promise<{ movies: Movie[]; totalPages: number }> {
  return getJSON('/api/tmdb?list=discover&genre=' + genreId + '&page=' + page)
    .then(function (r) { return { movies: r.movies || [], totalPages: r.totalPages || 0 }; })
    .catch(function () { return { movies: [], totalPages: 0 }; });
}

export function getGenres(): Promise<{ id: number; name: string }[]> {
  return getJSON('/api/tmdb?list=genres')
    .then(function (r) { return r.genres || []; })
    .catch(function () { return []; });
}

// OMDB search — results already carry a real imdbID, no TMDB resolution needed.
export function searchTitles(query: string, page: number): Promise<{ results: any[]; totalResults: number }> {
  return getJSON('/api/omdb?action=search&q=' + encodeURIComponent(query) + '&page=' + page)
    .then(function (r) {
      return r && r.Search ? { results: r.Search, totalResults: Number(r.totalResults) || 0 } : { results: [], totalResults: 0 };
    })
    .catch(function () { return { results: [], totalResults: 0 }; });
}

// TMDB list rows (trending/popular/etc.) only carry a numeric tmdbId — this
// resolves it to the imdbID everything else (details/stream/subs) needs.
export function resolveImdbId(tmdbId: number, type: MediaType): Promise<string> {
  return getJSON('/api/tmdb?list=movie&id=' + tmdbId + '&type=' + type)
    .then(function (r) { return r.imdbID || ''; })
    .catch(function () { return ''; });
}

export function getMovieDetails(imdbId: string): Promise<MovieDetails & { _tmdbId?: number; _backdrop?: string }> {
  return getJSON('/api/movie?id=' + encodeURIComponent(imdbId)).then(function (body) {
    if (!body || !body.imdbID) throw new Error('title not found');
    return body;
  });
}

export function getMediaType(details: { Type?: string }): MediaType {
  return details.Type === 'series' ? 'tv' : 'movie';
}

export function getTVDetails(tmdbId: number): Promise<{ totalSeasons: number; seasons: { number: number; name: string; episodeCount: number }[] }> {
  return getJSON('/api/tmdb?list=tv_details&id=' + tmdbId).catch(function () {
    return { totalSeasons: 0, seasons: [] };
  });
}

export function getTVSeasonEpisodes(tmdbId: number, season: number): Promise<SeasonEpisode[]> {
  return getJSON('/api/tmdb?list=tv_episodes&id=' + tmdbId + '&season=' + season)
    .then(function (r) { return r.episodes || []; })
    .catch(function () { return []; });
}

export function getCredits(tmdbId: number, type: MediaType): Promise<{ cast: any[]; directors: any[] }> {
  return getJSON('/api/tmdb?list=credits&id=' + tmdbId + '&type=' + type).catch(function () {
    return { cast: [], directors: [] };
  });
}

function streamParams(type: MediaType, imdbId: string, season?: number | null, episode?: number | null): URLSearchParams {
  const params = new URLSearchParams({ type: type, id: imdbId });
  if (type === 'tv' && season && episode) {
    params.set('s', String(season));
    params.set('e', String(episode));
  }
  return params;
}

export function getStream(type: MediaType, imdbId: string, season?: number | null, episode?: number | null, srv?: 1 | 2): Promise<StreamResult> {
  const params = streamParams(type, imdbId, season, episode);
  if (srv) params.set('srv', String(srv));
  return getJSON('/api/stream?' + params.toString());
}

export function getSubtitles(type: MediaType, imdbId: string, season?: number | null, episode?: number | null): Promise<SubtitleTrack[]> {
  const params = streamParams(type, imdbId, season, episode);
  return getJSON('/api/subs?' + params.toString())
    .then(function (r) { return Array.isArray(r.tracks) ? r.tracks : []; })
    .catch(function () { return []; });
}

// True IMDB ids look like "tt1234567"; anything else in a route param is a
// TMDB numeric id that still needs resolveImdbId() — same sniff the main
// app's movie-page.component.ts uses.
export function isImdbId(id: string): boolean {
  return /^tt\d+$/.test(id);
}
