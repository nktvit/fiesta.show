import React, { useEffect, useState } from 'react';
import { getList } from '../api';
import { Movie } from '../types';
import PosterGrid from '../components/PosterGrid';
import { navigate } from '../App';

const ROWS = [
  { key: 'trending', title: 'Trending Now' },
  { key: 'now_playing', title: 'Now Playing' },
  { key: 'popular', title: 'Popular Movies' },
  { key: 'top_rated', title: 'Top Rated' },
  { key: 'trending_tv', title: 'Trending TV' },
];

export default function Home() {
  const [rows, setRows] = useState<{ title: string; movies: Movie[] }[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(function () {
    let cancelled = false;
    Promise.all(ROWS.map(function (r) { return getList(r.key); })).then(function (results) {
      if (cancelled) return;
      const built = ROWS.map(function (r, i) { return { title: r.title, movies: results[i] || [] }; })
        .filter(function (r) { return r.movies.length > 0; });
      setRows(built);
      setLoading(false);
    });
    return function () { cancelled = true; };
  }, []);

  function openTitle(m: Movie) {
    const type = m.mediaType === 'tv' ? 'tv' : 'movie';
    const id = m.imdbID || String(m.tmdbId);
    if (!id) return;
    navigate('#/title/' + type + '/' + id);
  }

  if (loading) return <div className="tv-status">Loading…</div>;
  if (!rows.length) return <div className="tv-error">Couldn't load titles. Check your connection.</div>;

  return (
    <div>
      {rows.map(function (r) {
        return <PosterGrid key={r.title} title={r.title} movies={r.movies} onSelect={openTitle} />;
      })}
    </div>
  );
}
