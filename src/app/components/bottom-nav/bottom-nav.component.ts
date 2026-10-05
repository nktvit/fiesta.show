import { Component, computed, inject, signal } from '@angular/core';
import { NavigationEnd, Router, RouterLink } from '@angular/router';
import { filter } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

interface NavTab {
  path: string;
  label: string;
  icon: 'home' | 'search' | 'tv' | 'star' | 'music';
  /** `/` matches only itself; the rest also match their child routes. */
  exact: boolean;
}

@Component({
  selector: 'app-bottom-nav',
  imports: [RouterLink],
  templateUrl: './bottom-nav.component.html',
})
export class BottomNavComponent {
  readonly tabs: NavTab[] = [
    { path: '/', label: 'Home', icon: 'home', exact: true },
    { path: '/search', label: 'Search', icon: 'search', exact: false },
    { path: '/tv', label: 'TV Shows', icon: 'tv', exact: false },
    { path: '/top-rated', label: 'Top Rated', icon: 'star', exact: false },
  ];

  /** Rendered after the other tabs, so it is not part of `tabs`: the newest tab goes at the end of the row. */
  readonly musicTab: NavTab = { path: '/music', label: 'Music', icon: 'music', exact: false };

  // The old top navbar read `router.url` once in ngOnInit, so in a client-routed
  // SPA the highlight froze on whatever route happened to load first. This
  // signal is re-stamped on every NavigationEnd instead.
  private readonly url = signal('/');

  /** Genres are browsed from the Search tab now, so /genre/* keeps Search lit. */
  private readonly searchLit = computed(() => this.url().startsWith('/genre'));

  private router = inject(Router);

  constructor() {
    this.url.set(this.normalize(this.router.url));

    this.router.events
      .pipe(
        filter((e): e is NavigationEnd => e instanceof NavigationEnd),
        takeUntilDestroyed(),
      )
      .subscribe(e => this.url.set(this.normalize(e.urlAfterRedirects)));
  }

  isActive(tab: NavTab): boolean {
    const url = this.url();
    if (tab.path === '/search' && this.searchLit()) return true;
    return tab.exact ? url === tab.path : url === tab.path || url.startsWith(tab.path + '/');
  }

  private normalize(url: string): string {
    return url.split(/[?#]/)[0];
  }
}
