import React, { useEffect, useState } from 'react';
import { getMovieDetails, getMediaType, resolveImdbId, isImdbId, getTVDetails, getTVSeasonEpisodes } from '../api';
import { navigate } from '../App';
import { MediaType, SeasonEpisode } from '../types';

interface Props {
  type: MediaType;
  id: string;
}

export default function Details({ type, id }: Props) {
  const [details, setDetails] = useState<any>(null);
  const [tmdbId, setTmdbId] = useState<number | null>(null);
  const [status, setStatus] = useState<'loading' | 'done' | 'error'>('loading');
  const [season, setSeason] = useState(1);
  const [seasons, setSeasons] = useState<number[]>([]);
  const [episodes, setEpisodes] = useState<SeasonEpisode[]>([]);

  useEffect(function () {
    let cancelled = false;
    setStatus('loading');
    setDetails(null);
    setTmdbId(null);
    setSeason(1);
    setSeasons([]);
    setEpisodes([]);
    if (!id) { setStatus('error'); return; }

    const idPromise: Promise<string> = isImdbId(id) ? Promise.resolve(id) : resolveImdbId(+id, type);

    idPromise.then(function (imdbId) {
      if (!imdbId) throw new Error('not found');
      return getMovieDetails(imdbId);
    }).then(function (d) {
      if (cancelled) return;
      setDetails(d);
      setStatus('done');

      const mediaType = getMediaType(d);
      if (mediaType !== 'tv') return;

      const resolvedTmdbId = d._tmdbId || (!isImdbId(id) ? +id : null);
      if (!resolvedTmdbId) { setSeasons([1]); return; }
      setTmdbId(resolvedTmdbId);
      getTVDetails(resolvedTmdbId).then(function (info) {
        if (cancelled) return;
        const total = info.totalSeasons || 1;
        const list: number[] = [];
        for (let i = 1; i <= total; i++) list.push(i);
        setSeasons(list.length ? list : [1]);
      });
    }).catch(function () {
      if (!cancelled) setStatus('error');
    });

    return function () { cancelled = true; };
  }, [type, id]);

  useEffect(function () {
    if (!tmdbId || !details || getMediaType(details) !== 'tv') return;
    let cancelled = false;
    getTVSeasonEpisodes(tmdbId, season).then(function (eps) {
      if (!cancelled) setEpisodes(eps);
    });
    return function () { cancelled = true; };
  }, [tmdbId, season, details]);

  if (status === 'loading') return <div className="tv-status">Loading…</div>;
  if (status === 'error' || !details) return <div className="tv-error">Couldn't load this title.</div>;

  const mediaType = getMediaType(details);
  const imdbId = details.imdbID;
  const backdrop = details._backdrop || (details.Poster !== 'N/A' ? details.Poster : null);

  function watch(s?: number, e?: number) {
    const path = mediaType === 'tv'
      ? '#/watch/tv/' + imdbId + '/' + (s || 1) + '/' + (e || 1)
      : '#/watch/movie/' + imdbId;
    navigate(path);
  }

  return (
    <div>
      <div className="tv-details-hero" style={backdrop ? { backgroundImage: 'url(' + backdrop + ')' } : undefined}>
        <div className="tv-details-hero-fade" />
      </div>
      <div className="tv-details-body">
        <h1 className="tv-details-title">{details.Title}</h1>
        <div className="tv-details-meta">
          {details.Year || ''}
          {details.Runtime && details.Runtime !== 'N/A' ? ' · ' + details.Runtime : ''}
          {details.imdbRating && details.imdbRating !== 'N/A' ? ' · ★ ' + details.imdbRating : ''}
        </div>
        {details.Plot && details.Plot !== 'N/A' ? <div className="tv-details-plot">{details.Plot}</div> : null}

        {mediaType === 'movie' ? (
          <div>
            <button type="button" className="tv-btn" data-focusable="true" onClick={function () { watch(); }}>
              &#9654; Play
            </button>
          </div>
        ) : null}

        {details.Director && details.Director !== 'N/A' ? (
          <div>
            <div className="tv-details-row-label">Director</div>
            <div className="tv-details-row-value">{details.Director}</div>
          </div>
        ) : null}
        {details.Actors && details.Actors !== 'N/A' ? (
          <div>
            <div className="tv-details-row-label">Cast</div>
            <div className="tv-details-row-value">{details.Actors}</div>
          </div>
        ) : null}

        {mediaType === 'tv' ? (
          <div>
            <div className="tv-season-bar">
              {seasons.map(function (s) {
                const activeStyle = s === season ? { background: '#e50914', borderColor: '#e50914' } : undefined;
                return (
                  <button
                    key={s}
                    type="button"
                    data-focusable="true"
                    className="tv-season-pill"
                    style={activeStyle}
                    onClick={function () { setSeason(s); }}
                  >
                    Season {s}
                  </button>
                );
              })}
            </div>
            {episodes.length === 0 ? <div className="tv-status">No episode info for this season.</div> : null}
            {episodes.map(function (ep) {
              return (
                <button
                  key={ep.number}
                  type="button"
                  className="tv-episode-row"
                  data-focusable="true"
                  onClick={function () { watch(season, ep.number); }}
                >
                  {ep.number}. {ep.title}{ep.rating ? ' — ★ ' + ep.rating : ''}
                </button>
              );
            })}
          </div>
        ) : null}
      </div>
    </div>
  );
}
