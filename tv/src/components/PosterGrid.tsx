import React from 'react';
import { Movie } from '../types';
import { moviePath, onLinkClick } from '../router';

interface Props {
  title?: string;
  movies: Movie[];
  layout?: 'row' | 'grid';
}

export function titleHref(m: Movie): string {
  const type = m.mediaType === 'tv' ? 'tv' : 'movie';
  const id = m.imdbID || (m.tmdbId ? String(m.tmdbId) : '');
  return id ? moviePath(type, id) : '';
}

// Tiles are real links to the same /movie/:id URLs the main site uses, so a
// focused tile's address is meaningful; the click is intercepted in-app.
export default function PosterGrid({ title, movies, layout }: Props) {
  if (!movies.length) return null;
  const containerClass = layout === 'grid' ? 'tv-grid' : 'tv-row-scroll';

  return (
    <div className="tv-row">
      {title ? <h2 className="tv-row-title">{title}</h2> : null}
      <div className={containerClass}>
        {movies.map(function (m, i) {
          const key = String(m.tmdbId || m.imdbID || i) + ':' + i;
          const hasPoster = m.Poster && m.Poster !== 'N/A';
          const href = titleHref(m);
          if (!href) return null;
          return (
            <a
              key={key}
              href={href}
              className="tv-tile"
              data-focusable="true"
              onClick={onLinkClick}
            >
              <span
                className="tv-tile-poster"
                style={hasPoster ? { backgroundImage: 'url(' + m.Poster + ')' } : undefined}
              >
                {!hasPoster ? <span className="tv-tile-noposter">{m.Title}</span> : null}
              </span>
              <span className="tv-tile-title">{m.Title}</span>
              <span className="tv-tile-meta">
                {m.Year || ''}{typeof m.Rating === 'number' && m.Rating > 0 ? ' · ★ ' + m.Rating.toFixed(1) : ''}
                {m.mediaType === 'tv' ? ' · TV' : ''}
              </span>
            </a>
          );
        })}
      </div>
    </div>
  );
}
