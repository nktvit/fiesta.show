import React, { useEffect, useState } from 'react';
import { installRemoteNav } from './remote';
import { Route, parseLocation, subscribe, onLinkClick } from './router';
import Home from './screens/Home';
import Search from './screens/Search';
import Details from './screens/Details';
import Player from './screens/Player';
import ListPage from './screens/ListPage';
import TvShows from './screens/TvShows';
import Person from './screens/Person';
import { MediaType } from './types';

const NAV_LINKS: { href: string; label: string; screen: Route['screen'] }[] = [
  { href: '/', label: 'Home', screen: 'home' },
  { href: '/search', label: 'Search', screen: 'search' },
  { href: '/tv', label: 'TV Shows', screen: 'tv' },
  { href: '/top-rated', label: 'Top Rated', screen: 'top-rated' },
];

export default function App() {
  const [route, setRoute] = useState<Route>(parseLocation);

  useEffect(function () {
    let lastHref = route.href;
    const unsubscribe = subscribe(function () {
      const next = parseLocation();
      // Query-only replaceState updates (search typing, season pick) keep
      // the same screen; don't reset scroll for those.
      const screenChanged = next.href.split('?')[0] !== lastHref.split('?')[0] || next.query.play !== parseQueryPlay(lastHref);
      lastHref = next.href;
      setRoute(next);
      if (screenChanged) window.scrollTo(0, 0);
    });
    const cleanupNav = installRemoteNav(function () {
      window.history.back();
    });
    return function () {
      unsubscribe();
      cleanupNav();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-focus the first tile/button on every screen — there's no mouse, so
  // without this the viewer's first arrow-key press would only "arrive" at
  // the first element instead of already starting there.
  const screenKey = route.screen + ':' + route.id + ':' + (route.query.play || '');
  useEffect(function () {
    const t = setTimeout(function () {
      const active = document.activeElement;
      const withinBody = !active || active === document.body;
      if (withinBody) {
        const first = document.querySelector('.tv-content [data-focusable]') as HTMLElement | null
          || document.querySelector('[data-focusable]') as HTMLElement | null;
        if (first) first.focus();
      }
    }, 60);
    return function () { clearTimeout(t); };
  }, [screenKey]);

  const isPlayer = route.screen === 'movie' && route.query.play === '1';
  const mediaType: MediaType = route.query.type === 'tv' ? 'tv' : 'movie';
  const season = route.query.s ? +route.query.s : null;
  const episode = route.query.e ? +route.query.e : null;

  if (isPlayer) {
    return (
      <Player
        key={route.href}
        type={mediaType}
        id={route.id}
        season={season}
        episode={episode}
      />
    );
  }

  return (
    <div className="tv-app">
      <div className="tv-nav">
        <a href="/" className="tv-nav-brand" onClick={onLinkClick}>
          <span className="tv-nav-brand-mark">F</span>
          <span className="tv-nav-brand-text">Stream Fiesta</span>
        </a>
        <div className="tv-nav-links">
          {NAV_LINKS.map(function (l) {
            return (
              <a
                key={l.href}
                href={l.href}
                className={'tv-nav-link' + (route.screen === l.screen ? ' is-active' : '')}
                data-focusable="true"
                onClick={onLinkClick}
              >
                {l.label}
              </a>
            );
          })}
        </div>
      </div>
      <div className="tv-page tv-content">
        {route.screen === 'home' ? <Home /> : null}
        {route.screen === 'search' ? <Search key="search" initialQuery={route.query.query || ''} /> : null}
        {route.screen === 'movie' ? (
          <Details type={mediaType} id={route.id} season={season} episode={episode} />
        ) : null}
        {route.screen === 'person' ? <Person id={route.id} /> : null}
        {route.screen === 'genre' ? <ListPage kind="genre" genreId={route.id} /> : null}
        {route.screen === 'top-rated' ? <ListPage kind="top-rated" /> : null}
        {route.screen === 'tv' ? <TvShows /> : null}
      </div>
    </div>
  );
}

function parseQueryPlay(href: string): string | undefined {
  return /[?&]play=1(&|$)/.test(href) ? '1' : undefined;
}
