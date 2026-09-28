import React, { useEffect, useRef, useState } from 'react';
import { searchTitles } from '../api';
import { moviePath, onLinkClick, navigate, buildQuery } from '../router';
import Spinner from '../components/Spinner';

type Status = 'idle' | 'loading' | 'done' | 'error';

interface Props { initialQuery: string; }

// Same URL contract as the main site's /search?query=… page: the query
// lives in the address bar (replaceState, so Back leaves the page rather
// than stepping through keystrokes).
export default function Search({ initialQuery }: Props) {
  const [query, setQuery] = useState(initialQuery);
  const [results, setResults] = useState<any[]>([]);
  const [status, setStatus] = useState<Status>('idle');
  const timerRef = useRef<any>(null);
  const requestIdRef = useRef(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  function runSearch(value: string) {
    const id = ++requestIdRef.current;
    setStatus('loading');
    searchTitles(value, 1).then(function (r) {
      if (id !== requestIdRef.current) return;
      setResults(r.results);
      setStatus('done');
    }).catch(function () {
      if (id !== requestIdRef.current) return;
      setStatus('error');
    });
  }

  useEffect(function () {
    const trimmed = initialQuery.trim();
    if (trimmed.length >= 2) runSearch(trimmed);
    const t = setTimeout(function () { if (inputRef.current) inputRef.current.focus(); }, 80);
    return function () { clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function onChange(e: React.ChangeEvent<HTMLInputElement>) {
    const value = e.target.value;
    setQuery(value);
    if (timerRef.current) clearTimeout(timerRef.current);
    const trimmed = value.trim();
    navigate('/search' + buildQuery({ query: trimmed || null }), true);
    if (trimmed.length < 2) {
      requestIdRef.current++;
      setResults([]);
      setStatus('idle');
      return;
    }
    timerRef.current = setTimeout(function () { runSearch(trimmed); }, 600);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    // Enter on a TV keyboard closes the on-screen keyboard; search right away
    // and move focus to the first result so the D-pad can take over.
    if (e.keyCode === 13) {
      if (timerRef.current) clearTimeout(timerRef.current);
      const trimmed = query.trim();
      if (trimmed.length >= 2) runSearch(trimmed);
      e.preventDefault();
      setTimeout(function () {
        const first = document.querySelector('.tv-grid [data-focusable]') as HTMLElement | null;
        if (first) first.focus();
      }, 50);
    }
  }

  return (
    <div>
      <div className="tv-search-bar">
        <input
          ref={inputRef}
          type="text"
          className="tv-search-input"
          data-focusable="true"
          placeholder="Search movies & TV shows"
          value={query}
          onChange={onChange}
          onKeyDown={onKeyDown}
        />
      </div>
      {status === 'loading' ? <Spinner label="Searching…" /> : null}
      {status === 'error' ? <div className="tv-error">Search failed. Try again.</div> : null}
      {status === 'done' && results.length === 0 ? <div className="tv-status">No results for “{query.trim()}”.</div> : null}
      {status === 'idle' ? <div className="tv-status tv-status-muted">Type at least two letters to search.</div> : null}
      <div className="tv-grid">
        {results.map(function (item, i) {
          const hasPoster = item.Poster && item.Poster !== 'N/A';
          const type = item.Type === 'series' ? 'tv' : 'movie';
          return (
            <a
              key={item.imdbID + ':' + i}
              href={moviePath(type, item.imdbID)}
              className="tv-tile"
              data-focusable="true"
              onClick={onLinkClick}
            >
              <span
                className="tv-tile-poster"
                style={hasPoster ? { backgroundImage: 'url(' + item.Poster + ')' } : undefined}
              >
                {!hasPoster ? <span className="tv-tile-noposter">{item.Title}</span> : null}
              </span>
              <span className="tv-tile-title">{item.Title}</span>
              <span className="tv-tile-meta">{item.Year}{type === 'tv' ? ' · TV' : ''}</span>
            </a>
          );
        })}
      </div>
    </div>
  );
}
