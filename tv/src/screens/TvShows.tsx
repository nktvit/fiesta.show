import React, { useEffect, useState } from 'react';
import { getList } from '../api';
import { Movie } from '../types';
import PosterGrid from '../components/PosterGrid';
import ListPage from './ListPage';

// Mirrors the main site's /tv page: a trending row on top of the paginated
// popular grid.
export default function TvShows() {
  const [trending, setTrending] = useState<Movie[]>([]);

  useEffect(function () {
    let cancelled = false;
    getList('trending_tv').then(function (m) { if (!cancelled) setTrending(m); });
    return function () { cancelled = true; };
  }, []);

  return (
    <div>
      <PosterGrid title="Trending TV" movies={trending} />
      <ListPage kind="tv" />
    </div>
  );
}
