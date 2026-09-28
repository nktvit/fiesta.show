import React, { useEffect, useState } from 'react';
import { getMovieDetails, getMediaType, resolveImdbId, isImdbId, getTVDetails, getTVSeasonEpisodes, getCredits } from '../api';
import { navigate, moviePath, buildQuery } from '../router';
import { requestFullscreen } from '../fullscreen';
import { progressKey, readSavedProgress, formatTime } from '../progress';
import { MediaType, SeasonEpisode, CastMember } from '../types';
import { focusFirstContent } from '../remote';

interface Props {
  type: MediaType;
  id: string;
  season: number | null;
  episode: number | null;
}

function stripNA(v: any): string {
  return v && v !== 'N/A' ? String(v) : '';
}

export default function Details({ type, id, season: urlSeason, episode: urlEpisode }: Props) {
  const [details, setDetails] = useState<any>(null);
  const [tmdbId, setTmdbId] = useState<number | null>(null);
  const [status, setStatus] = useState<'loading' | 'done' | 'error'>('loading');
  const [season, setSeason] = useState(urlSeason || 1);
  const [seasons, setSeasons] = useState<{ number: number; name: string }[]>([]);
  const [episodes, setEpisodes] = useState<SeasonEpisode[]>([]);
  const [cast, setCast] = useState<CastMember[]>([]);

  useEffect(function () {
    let cancelled = false;
    setStatus('loading');
    setDetails(null);
    setTmdbId(null);
    setSeason(urlSeason || 1);
    setSeasons([]);
    setEpisodes([]);
    setCast([]);
    if (!id) { setStatus('error'); return; }

    const idPromise: Promise<string> = isImdbId(id) ? Promise.resolve(id) : resolveImdbId(+id, type);

    idPromise.then(function (imdbId) {
      if (!imdbId) throw new Error('not found');
      return getMovieDetails(imdbId);
    }).then(function (d) {
      if (cancelled) return;
      setDetails(d);
      setStatus('done');
      focusFirstContent();

      const mediaType = getMediaType(d);
      const resolvedTmdbId = d._tmdbId || (!isImdbId(id) ? +id : null);
      if (resolvedTmdbId) {
        setTmdbId(resolvedTmdbId);
        getCredits(resolvedTmdbId, mediaType).then(function (c) {
          if (!cancelled) setCast((c.cast || []).slice(0, 12));
        });
      }
      if (mediaType !== 'tv') return;
      if (!resolvedTmdbId) { setSeasons([{ number: 1, name: 'Season 1' }]); return; }
      getTVDetails(resolvedTmdbId).then(function (info) {
        if (cancelled) return;
        const list = (info.seasons || []).filter(function (s) { return s.number > 0; })
          .map(function (s) { return { number: s.number, name: s.name || ('Season ' + s.number) }; });
        if (!list.length) {
          const total = info.totalSeasons || 1;
          for (let i = 1; i <= total; i++) list.push({ number: i, name: 'Season ' + i });
        }
        setSeasons(list);
      });
    }).catch(function () {
      if (!cancelled) setStatus('error');
    });

    return function () { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type, id]);

  useEffect(function () {
    if (!tmdbId || !details || getMediaType(details) !== 'tv') return;
    let cancelled = false;
    getTVSeasonEpisodes(tmdbId, season).then(function (eps) {
      if (!cancelled) setEpisodes(eps);
    });
    return function () { cancelled = true; };
  }, [tmdbId, season, details]);

  if (status === 'loading') {
    return (
      <div className="tv-status">
        <div className="tv-spinner tv-spinner-inline" /><span>Loading…</span>
      </div>
    );
  }
  if (status === 'error' || !details) return <div className="tv-error">Couldn't load this title.</div>;

  const mediaType = getMediaType(details);
  const imdbId: string = details.imdbID;
  const backdrop = details._backdrop || stripNA(details.Poster);
  const poster = stripNA(details.Poster);
  const genres = stripNA(details.Genre).split(',').map(function (g: string) { return g.trim(); }).filter(function (g: string) { return g.length > 0; });

  const resumeEpisode = mediaType === 'tv' ? (urlEpisode || 1) : null;
  const resumeSeason = mediaType === 'tv' ? (urlSeason || 1) : null;
  const saved = readSavedProgress(progressKey(imdbId, mediaType, resumeSeason, resumeEpisode));
  const hasResume = !!(saved && saved.time > 5);

  // The fullscreen request has to happen inside the click handler (it needs
  // a user gesture); the player then fills the fullscreen viewport.
  function watch(s?: number, e?: number) {
    requestFullscreen(document.documentElement);
    navigate(moviePath(mediaType, imdbId, { play: true, season: s || resumeSeason || 1, episode: e || resumeEpisode || 1 }));
  }

  function pickSeason(s: number) {
    setSeason(s);
    // Keep the URL in step with the main site (?s=…) without a history entry.
    navigate('/movie/' + encodeURIComponent(id) + buildQuery({ type: 'tv', s: s, e: 1 }), true);
  }

  const playLabel = mediaType === 'tv'
    ? (hasResume ? 'Resume S' + resumeSeason + ' E' + resumeEpisode : 'Play S' + resumeSeason + ' E' + resumeEpisode)
    : (hasResume ? 'Resume' : 'Play');

  return (
    <div className="tv-details">
      <div className="tv-details-hero" style={backdrop ? { backgroundImage: 'url(' + backdrop + ')' } : undefined}>
        <div className="tv-details-hero-fade" />
      </div>
      <div className="tv-details-body">
        <div className="tv-details-cols">
          {poster ? <img className="tv-details-poster" src={poster} alt="" /> : null}
          <div className="tv-details-main">
            <h1 className="tv-details-title">{details.Title}</h1>
            <div className="tv-details-meta">
              {stripNA(details.Year) ? <span className="tv-chip">{details.Year}</span> : null}
              {stripNA(details.Runtime) ? <span className="tv-chip">{details.Runtime}</span> : null}
              {stripNA(details.imdbRating) ? <span className="tv-chip tv-chip-rating">★ {details.imdbRating}</span> : null}
              {mediaType === 'tv' ? <span className="tv-chip">TV series</span> : null}
              {stripNA(details.Rated) ? <span className="tv-chip">{details.Rated}</span> : null}
            </div>
            {genres.length ? (
              <div className="tv-details-genres">
                {genres.map(function (g: string) { return <span key={g} className="tv-genre-tag">{g}</span>; })}
              </div>
            ) : null}
            {stripNA(details.Plot) ? <div className="tv-details-plot">{details.Plot}</div> : null}

            <div className="tv-details-actions">
              <button type="button" className="tv-btn" data-focusable="true" onClick={function () { watch(); }}>
                <span className="tv-btn-icon">&#9654;</span> {playLabel}
              </button>
              {hasResume && saved ? (
                <span className="tv-details-resume">
                  {formatTime(saved.time)}{saved.duration ? ' of ' + formatTime(saved.duration) : ''} watched
                </span>
              ) : null}
            </div>

            <div className="tv-details-facts">
              {stripNA(details.Director) ? (
                <div className="tv-fact"><span className="tv-fact-label">Director</span><span className="tv-fact-value">{details.Director}</span></div>
              ) : null}
              {stripNA(details.Actors) ? (
                <div className="tv-fact"><span className="tv-fact-label">Starring</span><span className="tv-fact-value">{details.Actors}</span></div>
              ) : null}
              {stripNA(details.Country) ? (
                <div className="tv-fact"><span className="tv-fact-label">Country</span><span className="tv-fact-value">{details.Country}</span></div>
              ) : null}
            </div>
          </div>
        </div>

        {mediaType === 'tv' ? (
          <div className="tv-episodes">
            <h2 className="tv-section-title">Episodes</h2>
            <div className="tv-season-bar">
              {seasons.map(function (s) {
                return (
                  <button
                    key={s.number}
                    type="button"
                    data-focusable="true"
                    className={'tv-season-pill' + (s.number === season ? ' is-active' : '')}
                    onClick={function () { pickSeason(s.number); }}
                  >
                    {s.name}
                  </button>
                );
              })}
            </div>
            {episodes.length === 0 ? <div className="tv-status tv-status-muted">No episode info for this season.</div> : null}
            <div className="tv-episode-list">
              {episodes.map(function (ep) {
                const isCurrent = season === resumeSeason && ep.number === resumeEpisode;
                const epSaved = readSavedProgress(progressKey(imdbId, 'tv', season, ep.number));
                const pct = epSaved && epSaved.duration ? Math.min(100, Math.round((epSaved.time / epSaved.duration) * 100)) : 0;
                return (
                  <button
                    key={ep.number}
                    type="button"
                    className={'tv-episode-row' + (isCurrent ? ' is-current' : '')}
                    data-focusable="true"
                    onClick={function () { watch(season, ep.number); }}
                  >
                    <span className="tv-episode-still" style={ep.still ? { backgroundImage: 'url(' + ep.still + ')' } : undefined}>
                      <span className="tv-episode-play">&#9654;</span>
                      {pct > 0 ? <span className="tv-episode-progress"><span className="tv-episode-progress-fill" style={{ width: pct + '%' }} /></span> : null}
                    </span>
                    <span className="tv-episode-text">
                      <span className="tv-episode-title">{ep.number}. {ep.title || 'Episode ' + ep.number}</span>
                      <span className="tv-episode-meta">
                        {ep.airDate || ''}{ep.rating ? (ep.airDate ? ' · ' : '') + '★ ' + ep.rating : ''}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}

        {cast.length ? (
          <div className="tv-cast">
            <h2 className="tv-section-title">Cast</h2>
            <div className="tv-row-scroll">
              {cast.map(function (c) {
                return (
                  <a
                    key={c.id}
                    href={'/person/' + c.id}
                    className="tv-cast-card"
                    data-focusable="true"
                    onClick={function (e) { e.preventDefault(); navigate('/person/' + c.id); }}
                  >
                    <span className="tv-cast-photo" style={c.profilePath ? { backgroundImage: 'url(' + c.profilePath + ')' } : undefined} />
                    <span className="tv-cast-name">{c.name}</span>
                    <span className="tv-cast-role">{c.character}</span>
                  </a>
                );
              })}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
