import React, { useRef, useState } from 'react';
import { searchTitles } from '../api';
import { navigate } from '../App';

type Status = 'idle' | 'loading' | 'done' | 'error';

export default function Search() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<any[]>([]);
  const [status, setStatus] = useState<Status>('idle');
  const timerRef = useRef<any>(null);
  const requestIdRef = useRef(0);

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

  function onChange(e: React.ChangeEvent<HTMLInputElement>) {
    const value = e.target.value;
    setQuery(value);
    if (timerRef.current) clearTimeout(timerRef.current);
    const trimmed = value.trim();
    if (trimmed.length < 2) {
      requestIdRef.current++;
      setResults([]);
      setStatus('idle');
      return;
    }
    timerRef.current = setTimeout(function () { runSearch(trimmed); }, 600);
  }

  function openResult(item: any) {
    const type = item.Type === 'series' ? 'tv' : 'movie';
    navigate('#/title/' + type + '/' + item.imdbID);
  }

  return (
    <div>
      <div className="tv-search-bar">
        <input
          type="text"
          className="tv-search-input"
          data-focusable="true"
          placeholder="Search movies & TV shows"
          value={query}
          onChange={onChange}
        />
      </div>
      {status === 'loading' ? <div className="tv-status">Searching…</div> : null}
      {status === 'error' ? <div className="tv-error">Search failed. Try again.</div> : null}
      {status === 'done' && results.length === 0 ? <div className="tv-status">No results.</div> : null}
      <div className="tv-grid">
        {results.map(function (item, i) {
          const hasPoster = item.Poster && item.Poster !== 'N/A';
          return (
            <button
              key={item.imdbID + ':' + i}
              type="button"
              className="tv-tile"
              data-focusable="true"
              onClick={function () { openResult(item); }}
            >
              <span
                className="tv-tile-poster"
                style={hasPoster ? { backgroundImage: 'url(' + item.Poster + ')' } : undefined}
              />
              <span className="tv-tile-title">{item.Title}</span>
              <span className="tv-tile-meta">{item.Year}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
