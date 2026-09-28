import React, { useEffect, useState } from 'react';
import { getListPage, discoverByGenre, getGenres } from '../api';
import { Movie } from '../types';
import PosterGrid from '../components/PosterGrid';
import Spinner from '../components/Spinner';
import { focusFirstContent } from '../remote';

// One component behind /tv, /top-rated and /genre/:id — a titled grid with a
// remote-friendly "Load more" button (an infinite scroll needs a scroll
// event the D-pad never produces).

interface Props {
  kind: 'tv' | 'top-rated' | 'genre';
  genreId?: string;
}

function fetchPage(kind: Props['kind'], genreId: string | undefined, page: number) {
  if (kind === 'genre') return discoverByGenre(+(genreId || 0), page);
  return getListPage(kind === 'tv' ? 'popular_tv' : 'top_rated', page);
}

export default function ListPage({ kind, genreId }: Props) {
  const [heading, setHeading] = useState('');
  const [movies, setMovies] = useState<Movie[]>([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(0);
  const [status, setStatus] = useState<'loading' | 'more' | 'done' | 'error'>('loading');

  useEffect(function () {
    let cancelled = false;
    setMovies([]);
    setPage(1);
    setTotalPages(0);
    setStatus('loading');

    if (kind === 'genre') {
      setHeading('');
      getGenres().then(function (genres) {
        if (cancelled) return;
        for (let i = 0; i < genres.length; i++) {
          if (String(genres[i].id) === String(genreId)) { setHeading(genres[i].name + ' Movies'); return; }
        }
        setHeading('Genre');
      });
    } else {
      setHeading(kind === 'tv' ? 'Popular TV Shows' : 'Top Rated Movies');
    }

    fetchPage(kind, genreId, 1).then(function (r) {
      if (cancelled) return;
      setMovies(r.movies);
      setTotalPages(r.totalPages);
      setStatus(r.movies.length ? 'done' : 'error');
      focusFirstContent();
    });
    return function () { cancelled = true; };
  }, [kind, genreId]);

  function loadMore() {
    const next = page + 1;
    setStatus('more');
    fetchPage(kind, genreId, next).then(function (r) {
      setMovies(function (prev) { return prev.concat(r.movies); });
      setPage(next);
      setStatus('done');
    });
  }

  return (
    <div>
      <h1 className="tv-page-title">{heading}</h1>
      {status === 'loading' ? <Spinner /> : null}
      {status === 'error' ? <div className="tv-error">Couldn't load this list.</div> : null}
      <PosterGrid movies={movies} layout="grid" />
      {status !== 'loading' && status !== 'error' && page < totalPages ? (
        <div className="tv-load-more-wrap">
          <button type="button" className="tv-load-more" data-focusable="true" onClick={loadMore} disabled={status === 'more'}>
            {status === 'more' ? 'Loading…' : 'Load more'}
          </button>
        </div>
      ) : null}
    </div>
  );
}
