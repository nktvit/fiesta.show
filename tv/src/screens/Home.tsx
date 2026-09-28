import React, { useEffect, useState } from 'react';
import { getList } from '../api';
import { Movie } from '../types';
import PosterGrid from '../components/PosterGrid';
import Spinner from '../components/Spinner';
import { focusFirstContent } from '../remote';

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
      focusFirstContent();
    });
    return function () { cancelled = true; };
  }, []);

  if (loading) return <Spinner />;
  if (!rows.length) return <div className="tv-error">Couldn't load titles. Check your connection.</div>;

  return (
    <div>
      {rows.map(function (r) {
        return <PosterGrid key={r.title} title={r.title} movies={r.movies} />;
      })}
    </div>
  );
}
