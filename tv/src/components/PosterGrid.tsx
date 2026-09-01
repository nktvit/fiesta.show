import React from 'react';
import { Movie } from '../types';

interface Props {
  title?: string;
  movies: Movie[];
  onSelect: (m: Movie) => void;
  layout?: 'row' | 'grid';
}

export default function PosterGrid({ title, movies, onSelect, layout }: Props) {
  if (!movies.length) return null;
  const containerClass = layout === 'grid' ? 'tv-grid' : 'tv-row-scroll';

  return (
    <div className="tv-row">
      {title ? <h2 className="tv-row-title">{title}</h2> : null}
      <div className={containerClass}>
        {movies.map(function (m, i) {
          const key = String(m.tmdbId || m.imdbID || i) + ':' + i;
          const hasPoster = m.Poster && m.Poster !== 'N/A';
          return (
            <button
              key={key}
              type="button"
              className="tv-tile"
              data-focusable="true"
              onClick={function () { onSelect(m); }}
            >
              <span
                className="tv-tile-poster"
                style={hasPoster ? { backgroundImage: 'url(' + m.Poster + ')' } : undefined}
              />
              <span className="tv-tile-title">{m.Title}</span>
              <span className="tv-tile-meta">
                {m.Year || ''}{typeof m.Rating === 'number' && m.Rating > 0 ? ' · ★ ' + m.Rating.toFixed(1) : ''}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
