import React, { useEffect, useState } from 'react';
import { installRemoteNav } from './remote';
import Home from './screens/Home';
import Search from './screens/Search';
import Details from './screens/Details';
import Player from './screens/Player';
import { MediaType } from './types';

interface Route {
  screen: 'home' | 'search' | 'details' | 'player';
  params: string[];
}

function parseHash(hash: string): Route {
  const clean = hash.replace(/^#\/?/, '');
  const parts = clean.split('/').filter(function (p) { return p.length > 0; });
  if (parts[0] === 'search') return { screen: 'search', params: parts.slice(1) };
  if (parts[0] === 'title') return { screen: 'details', params: parts.slice(1) };
  if (parts[0] === 'watch') return { screen: 'player', params: parts.slice(1) };
  return { screen: 'home', params: [] };
}

// Plain hash assignment pushes a new session-history entry on its own —
// window.history.back() (wired to the remote's Back button) just works.
export function navigate(path: string) {
  window.location.hash = path;
}

export default function App() {
  const [route, setRoute] = useState<Route>(function () {
    return parseHash(window.location.hash);
  });

  useEffect(function () {
    function onHashChange() {
      setRoute(parseHash(window.location.hash));
      window.scrollTo(0, 0);
    }
    window.addEventListener('hashchange', onHashChange);
    const cleanupNav = installRemoteNav(function () {
      window.history.back();
    });
    return function () {
      window.removeEventListener('hashchange', onHashChange);
      cleanupNav();
    };
  }, []);

  // Auto-focus the first tile/button on every screen — there's no mouse, so
  // without this the viewer's first arrow-key press would only "arrive" at
  // the first element instead of already starting there.
  useEffect(function () {
    const t = setTimeout(function () {
      const active = document.activeElement;
      const withinBody = !active || active === document.body;
      if (withinBody) {
        const first = document.querySelector('[data-focusable]') as HTMLElement | null;
        if (first) first.focus();
      }
    }, 60);
    return function () { clearTimeout(t); };
  }, [route]);

  const isPlayer = route.screen === 'player';

  return (
    <div>
      {!isPlayer ? (
        <div className="tv-nav">
          <span className="tv-nav-brand">Stream Fiesta</span>
          <a href="#/" className="tv-nav-link" data-focusable="true">Home</a>
          <a href="#/search" className="tv-nav-link" data-focusable="true">Search</a>
        </div>
      ) : null}
      <div className={isPlayer ? '' : 'tv-page'}>
        {route.screen === 'home' ? <Home /> : null}
        {route.screen === 'search' ? <Search /> : null}
        {route.screen === 'details' ? (
          <Details type={(route.params[0] as MediaType) || 'movie'} id={route.params[1] || ''} />
        ) : null}
        {route.screen === 'player' ? (
          <Player
            type={(route.params[0] as MediaType) || 'movie'}
            imdbId={route.params[1] || ''}
            season={route.params[2] ? +route.params[2] : null}
            episode={route.params[3] ? +route.params[3] : null}
          />
        ) : null}
      </div>
    </div>
  );
}
