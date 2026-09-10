import { Component, ElementRef, HostListener, OnDestroy, computed, inject, signal, viewChild } from '@angular/core';
import { NavigationEnd, Router, RouterLink } from '@angular/router';
import { filter } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { TmdbService } from '../../services/tmdb.service';

interface NavTab {
  path: string;
  label: string;
  icon: 'home' | 'search' | 'tv' | 'star';
  /** `/` matches only itself; the rest also match their child routes. */
  exact: boolean;
}

/** Everything inside the sheet that can hold focus, in DOM order. */
const FOCUSABLE = 'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])';

@Component({
  selector: 'app-bottom-nav',
  imports: [RouterLink],
  templateUrl: './bottom-nav.component.html',
  styleUrl: './bottom-nav.component.css',
})
export class BottomNavComponent implements OnDestroy {
  readonly tabs: NavTab[] = [
    { path: '/', label: 'Home', icon: 'home', exact: true },
    { path: '/search', label: 'Search', icon: 'search', exact: false },
    { path: '/tv', label: 'TV Shows', icon: 'tv', exact: false },
    { path: '/top-rated', label: 'Top Rated', icon: 'star', exact: false },
  ];

  readonly genres = signal<{ id: number; name: string }[]>([]);
  readonly genresOpen = signal(false);

  private readonly sheetPanel = viewChild<ElementRef<HTMLElement>>('sheetPanel');
  private readonly genresBtn = viewChild<ElementRef<HTMLElement>>('genresBtn');

  /** Page offset captured at open time, restored on close — see `openGenres()`. */
  private lockedScrollY = 0;

  // The old top navbar read `router.url` once in ngOnInit, so in a client-routed
  // SPA the highlight froze on whatever route happened to load first. This
  // signal is re-stamped on every NavigationEnd instead.
  private readonly url = signal('/');
  readonly genresActive = computed(() => this.url().startsWith('/genre'));
  /** The genre currently being viewed, so the sheet can mark it. */
  readonly activeGenreId = computed(() => {
    const match = /^\/genre\/(\d+)/.exec(this.url());
    return match ? +match[1] : null;
  });

  private router = inject(Router);
  private tmdb = inject(TmdbService);

  constructor() {
    this.url.set(this.normalize(this.router.url));

    this.router.events
      .pipe(
        filter((e): e is NavigationEnd => e instanceof NavigationEnd),
        takeUntilDestroyed(),
      )
      .subscribe(e => {
        this.url.set(this.normalize(e.urlAfterRedirects));
        this.closeGenres();
      });

    this.tmdb.getGenres().subscribe(g => this.genres.set(g));
  }

  isActive(tab: NavTab): boolean {
    // While the sheet is up, Genres owns the highlight — otherwise two tabs
    // read as active at once.
    if (this.genresOpen()) return false;
    const url = this.url();
    return tab.exact ? url === tab.path : url === tab.path || url.startsWith(tab.path + '/');
  }

  toggleGenres(): void {
    this.genresOpen() ? this.closeGenres() : this.openGenres();
  }

  openGenres(): void {
    // iOS Safari ignores `overflow: hidden` on its own, so the lock class also
    // pins the body with `position: fixed` — which collapses the page to the
    // top unless we counteract it with the current offset and put it back on
    // close.
    this.lockedScrollY = window.scrollY;
    this.genresOpen.set(true);
    document.body.style.top = `-${this.lockedScrollY}px`;
    document.body.classList.add('nav-sheet-open');

    // The panel is behind @if, so it only exists once this signal write has
    // been rendered — and a microtask still runs *before* Angular commits that
    // render, so the focus call would find nothing (verified: activeElement
    // stayed on <body>). A macrotask lands after the commit.
    setTimeout(() => this.focusables()[0]?.focus());
  }

  closeGenres(): void {
    if (!this.genresOpen()) return;
    this.genresOpen.set(false);
    this.releaseScrollLock();
    // Return focus to the control that opened the sheet, not to <body>.
    this.genresBtn()?.nativeElement.focus();
  }

  /** Tab/Shift+Tab cycle inside the sheet — nothing behind it is reachable. */
  onSheetKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Tab') return;

    const items = this.focusables();
    if (items.length === 0) return;

    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;

    if (event.shiftKey && (active === first || !this.sheetPanel()?.nativeElement.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    this.closeGenres();
  }

  ngOnDestroy(): void {
    this.releaseScrollLock();
  }

  private focusables(): HTMLElement[] {
    const panel = this.sheetPanel()?.nativeElement;
    return panel ? Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)) : [];
  }

  private releaseScrollLock(): void {
    if (!document.body.classList.contains('nav-sheet-open')) return;
    document.body.classList.remove('nav-sheet-open');
    document.body.style.top = '';
    window.scrollTo(0, this.lockedScrollY);
  }

  private normalize(url: string): string {
    return url.split(/[?#]/)[0];
  }
}
