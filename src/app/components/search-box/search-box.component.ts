import { Component, ElementRef, NgZone, OnDestroy, ViewChild, inject, input } from '@angular/core';
import { MovieService } from '../../services/movie.service';
import { TmdbService, PersonSearchResult } from '../../services/tmdb.service';
import { NgClass, TitleCasePipe } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';
import { LoggerService } from "../../services/logger.service";
import { Subject, debounceTime, distinctUntilChanged, takeUntil, firstValueFrom } from 'rxjs';
import { environment } from '../../../environments/environment';

interface SearchSuggestion {
  id: string;
  title: string;
  year: string;
  type: string;
  poster: string | null;
  kind?: 'title' | 'person';
}

@Component({
  selector: 'app-search-box',
  imports: [NgClass, TitleCasePipe],
  templateUrl: './search-box.component.html',
  styleUrl: './search-box.component.css'
})
export class SearchBoxComponent implements OnDestroy {
  searchTerm = "";
  lastSearchTerm = "";
  /** Permanent, load-bearing copy: it no longer blanks on focus. Fits both the
      342px mobile field and the 288px navbar slot at sm:. */
  placeholder = "Search titles or people";

  /** 'glass' is for the three pages whose navbar is transparent over hero art
      (/, /movie/:id, /person/:id) — a solid #121212 chip there reads as a hole
      punched in the image. Threaded from the navbar's own `transparent()`. */
  readonly surface = input<'sunken' | 'glass'>('sunken');

  private static seq = 0;
  /** Replaces the hardcoded Preline id the sr-only label pointed at, and gives
      aria-controls / aria-activedescendant unique targets. */
  readonly uid = 'sf-search-' + (++SearchBoxComponent.seq);

  @ViewChild('searchInput') private searchInput?: ElementRef<HTMLInputElement>;
  @ViewChild('shell') private shell?: ElementRef<HTMLElement>;

  private vvListener = () => this.measureDropdown();
  private static safeBottomPx = -1;
  mode: 'home' | 'search' = 'home';
  isPromptUpdated = false;
  isLoading = false;
  isFocused = false;

  // Suggestions related properties
  suggestions: SearchSuggestion[] = [];
  showSuggestions = false;
  isLoadingSuggestions = false;
  isLoadingMore = false;
  private suggestionsPage = 1;
  private totalSuggestions = 0;
  private titleSuggestionsCount = 0;
  private lastSuggestionTerm = '';
  private searchTerms = new Subject<string>();
  private destroy$ = new Subject<void>();
  protected selectedSuggestionIndex = -1;

  private movieService = inject(MovieService);
  private tmdbService = inject(TmdbService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private logger = inject(LoggerService);
  private host = inject<ElementRef<HTMLElement>>(ElementRef);
  private zone = inject(NgZone);

  performSearch(prompt: string) {
    prompt = prompt.trim();
    if (prompt !== "" && prompt !== this.lastSearchTerm) {
      this.isLoading = true;
      this.lastSearchTerm = prompt;
      this.logger.log("search-box", prompt);
      this.hideSuggestions();

      this.movieService.searchMovies(prompt).subscribe({
        next: () => {
          this.router.navigate(['/search'], { queryParams: { query: prompt } });
        },
        error: (error) => {
          this.logger.error('Error during search:', error);
          // RxJS does not fire `complete` after `error`, so without this one
          // dropped request left the field disabled and spinning forever.
          this.isLoading = false;
        },
        complete: () => {
          this.isLoading = false;
        }
      });
    }
  }

  ngOnInit() {
    // populate the inputbox with the request in query
    this.route.queryParams.subscribe(params => {
      const query = params['query'];
      if (query) {
        this.searchTerm = query;
        this.lastSearchTerm = query;
      } else if (this.router.url.split('?')[0] === '/search') {
        // Scoped to /search on purpose. A blanket else is a cross-page
        // regression: movie-page navigates with `queryParamsHandling: 'merge'`,
        // and each of those emissions would wipe whatever the user had typed
        // into the header box.
        this.searchTerm = '';
        this.lastSearchTerm = '';
      }
    });

    // Setup search suggestions
    this.searchTerms.pipe(
      debounceTime(300), // Wait for 300ms pause
      distinctUntilChanged(), // Only emit if the value is different
      takeUntil(this.destroy$) // Automatically unsubscribe when component is destroyed
    ).subscribe(term => {
      this.fetchSuggestions(term);
    });
  }

  ngOnDestroy() {
    // A route change while focused must not leak the listeners or leave the
    // BMC widget hidden for the rest of the session.
    document.body.classList.remove('sf-suggest-open');
    this.removeViewportListeners();
    this.destroy$.next();
    this.destroy$.complete();
  }

  handleInput(e: any) {
    this.searchTerm = e.target.value;
    this.isPromptUpdated = true;

    if (this.searchTerm.length >= 2) {
      this.searchTerms.next(this.searchTerm);
    } else {
      this.hideSuggestions();
    }
  }

  async fetchSuggestions(term: string, page: number = 1) {
    term = term.trim();
    if (term.length < 2) return;

    if (page === 1) {
      this.isLoadingSuggestions = true;
      this.suggestionsPage = 1;
      this.totalSuggestions = 0;
      this.titleSuggestionsCount = 0;
    } else {
      this.isLoadingMore = true;
    }

    try {
      let titleSuggestions: SearchSuggestion[] = [];
      let total = 0;

      const peoplePromise: Promise<PersonSearchResult[]> = page === 1
        ? firstValueFrom(this.tmdbService.searchPeople(term)).catch(() => [])
        : Promise.resolve([]);

      if (environment.production) {
        const response = await fetch(`/api/suggestions?q=${encodeURIComponent(term)}&page=${page}`);
        const data = await response.json();
        if (data.suggestions) {
          titleSuggestions = data.suggestions.map((s: SearchSuggestion) => ({
            ...s,
            poster: s.poster ? this.toThumbnail(s.poster) : null,
            kind: 'title' as const,
          }));
          total = data.totalResults || data.suggestions.length;
        }
      } else {
        const response = await fetch(
          `https://www.omdbapi.com/?apikey=${environment.OMDB_API_KEY}&s=${encodeURIComponent(term)}&page=${page}`
        );
        const data = await response.json();
        if (data.Response === 'True') {
          titleSuggestions = data.Search.map((item: any) => ({
            id: item.imdbID,
            title: item.Title,
            year: item.Year,
            type: item.Type,
            poster: item.Poster !== 'N/A' ? this.toThumbnail(item.Poster) : null,
            kind: 'title' as const,
          }));
          total = +data.totalResults;
        }
      }

      const people = await peoplePromise;

      // A slow page-1 "bat" must not land on top of a newer "batman", and a tap
      // on Clear inside the 300ms debounce must not reopen the list.
      if (page === 1 && this.searchTerm.trim() !== term) return;
      const peopleSuggestions: SearchSuggestion[] = people.slice(0, 4).map(p => ({
        id: String(p.id),
        title: p.name,
        year: p.knownForDepartment || '',
        type: 'person',
        poster: p.profilePath,
        kind: 'person' as const,
      }));

      if (page === 1) {
        this.suggestions = [...peopleSuggestions, ...titleSuggestions];
        this.totalSuggestions = total;
        this.titleSuggestionsCount = titleSuggestions.length;
      } else {
        this.suggestions = [...this.suggestions, ...titleSuggestions];
        this.titleSuggestionsCount += titleSuggestions.length;
      }
      this.lastSuggestionTerm = term;
      this.suggestionsPage = page;
      this.showSuggestions = this.suggestions.length > 0;
      this.selectedSuggestionIndex = -1;
    } catch (error) {
      this.logger.error('Error fetching suggestions:', error);
      if (page === 1) {
        this.suggestions = [];
        this.showSuggestions = false;
      }
    } finally {
      this.isLoadingSuggestions = false;
      this.isLoadingMore = false;
    }
  }

  get hasMoreSuggestions(): boolean {
    return this.titleSuggestionsCount < this.totalSuggestions;
  }

  onSuggestionsScroll(event: Event) {
    const el = event.target as HTMLElement;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    if (nearBottom && !this.isLoadingMore && this.hasMoreSuggestions) {
      this.fetchSuggestions(this.lastSuggestionTerm, this.suggestionsPage + 1);
    }
  }

  private toThumbnail(url: string): string {
    // OMDB/Amazon: SX300 → SX100
    if (url.includes('media-amazon.com')) {
      return url.replace(/SX\d+/, 'SX100');
    }
    // TMDB: w342 or w500 → w92
    if (url.includes('image.tmdb.org')) {
      return url.replace(/\/w\d+\//, '/w92/');
    }
    return url;
  }

  selectSuggestion(suggestion: SearchSuggestion) {
    this.hideSuggestions();
    if (suggestion.kind === 'person') {
      this.router.navigate(['/person', suggestion.id]);
    } else {
      this.router.navigate(['/movie', suggestion.id]);
    }
  }

  hideSuggestions() {
    // Small delay to allow clicks to register
    setTimeout(() => {
      this.showSuggestions = false;
    }, 150);
  }

  handleFocus() {
    this.isFocused = true;
    // The BMC widget sits at z-index 9999999, above every app layer, 48px at
    // bottom: calc(4.75rem + safe) — i.e. on top of the last suggestion row's
    // right-hand side, stealing the tap. Same pattern as body.nav-sheet-open,
    // separate class so the About page's own toggle is undisturbed.
    document.body.classList.add('sf-suggest-open');
    this.measureDropdown();
    this.zone.runOutsideAngular(() => {
      window.visualViewport?.addEventListener('resize', this.vvListener);
      window.visualViewport?.addEventListener('scroll', this.vvListener);
      window.addEventListener('resize', this.vvListener);
    });
    if (this.searchTerm.length >= 2) {
      // If we already have results for this term, just show them
      if (this.suggestions.length > 0 && this.lastSuggestionTerm === this.searchTerm) {
        this.showSuggestions = true;
      } else {
        this.searchTerms.next(this.searchTerm);
      }
    }
  }

  handleFocusOut() {
    this.isFocused = false;
    document.body.classList.remove('sf-suggest-open');
    this.removeViewportListeners();
    this.hideSuggestions();
  }

  private removeViewportListeners() {
    window.visualViewport?.removeEventListener('resize', this.vvListener);
    window.visualViewport?.removeEventListener('scroll', this.vvListener);
    window.removeEventListener('resize', this.vvListener);
  }

  clearSearch() {
    this.searchTerm = '';
    this.isPromptUpdated = true;
    // Must reset: without it, clear-then-retype-the-same-query leaves the submit
    // chip permanently disabled by the `=== lastSearchTerm` rule.
    this.lastSearchTerm = '';
    this.suggestions = [];
    this.showSuggestions = false;
    this.selectedSuggestionIndex = -1;
    this.searchInput?.nativeElement.focus();
  }

  /** env(safe-area-inset-bottom) is not readable from JS; a one-shot probe is. */
  private safeBottom(): number {
    if (SearchBoxComponent.safeBottomPx >= 0) return SearchBoxComponent.safeBottomPx;
    const probe = document.createElement('div');
    probe.style.cssText =
      'position:fixed;left:0;bottom:0;width:0;visibility:hidden;pointer-events:none;' +
      'height:env(safe-area-inset-bottom,0px);';
    document.body.appendChild(probe);
    SearchBoxComponent.safeBottomPx = probe.getBoundingClientRect().height;
    probe.remove();
    return SearchBoxComponent.safeBottomPx;
  }

  /**
   * Sizes the dropdown to the space actually left below the field.
   *
   * A vh/svh clamp cannot do this: the iOS layout viewport does not shrink when
   * the keyboard opens, so no viewport unit can see it. `visualViewport.offsetTop
   * + .height` and `getBoundingClientRect().bottom` are both layout-viewport
   * coordinates, so the subtraction is valid.
   */
  private measureDropdown() {
    const shell = this.shell?.nativeElement;
    if (!shell) return;
    const vv = window.visualViewport;
    const rect = shell.getBoundingClientRect();
    const viewportBottom = vv ? vv.offsetTop + vv.height : window.innerHeight;
    const keyboardOpen = !!vv && vv.height < window.innerHeight - 120;
    const isPhone = window.innerWidth < 640;
    // Tab bar: h-14 (56) + 1px top border + home-indicator inset + 8px of air.
    // Irrelevant once the keyboard has covered it.
    const reserve = keyboardOpen ? 12 : (isPhone ? 57 + this.safeBottom() + 8 : 16);
    const avail = viewportBottom - rect.bottom - 8 /* mt-2 */ - reserve;
    const max = Math.max(144, Math.min(320, Math.round(avail)));
    this.host.nativeElement.style.setProperty('--sf-dd-max', max + 'px');
  }

  /** aria-activedescendant is a lie if the row it names is scrolled out of sight. */
  private scrollActiveOptionIntoView() {
    if (this.selectedSuggestionIndex < 0) return;
    this.host.nativeElement
      .querySelector<HTMLElement>('#' + this.uid + '-opt-' + this.selectedSuggestionIndex)
      ?.scrollIntoView({ block: 'nearest' });
  }

  handleSubmit(event: any) {
    event.preventDefault();
    if (this.isPromptUpdated && !this.isLoading) {
      this.performSearch(this.searchTerm);
    }
  }

  handleKeydown(event: KeyboardEvent) {
    if (!this.showSuggestions) return;

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        this.selectedSuggestionIndex = Math.min(this.selectedSuggestionIndex + 1, this.suggestions.length - 1);
        this.scrollActiveOptionIntoView();
        break;
      case 'ArrowUp':
        event.preventDefault();
        this.selectedSuggestionIndex = Math.max(this.selectedSuggestionIndex - 1, -1);
        this.scrollActiveOptionIntoView();
        break;
      case 'Enter':
        if (this.selectedSuggestionIndex >= 0) {
          event.preventDefault();
          this.selectSuggestion(this.suggestions[this.selectedSuggestionIndex]);
        }
        break;
      case 'Escape':
        event.preventDefault();
        this.hideSuggestions();
        break;
    }
  }
}
