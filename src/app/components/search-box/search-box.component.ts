import { Component, inject, OnDestroy } from '@angular/core';
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
  placeholder = "Enter any title...";
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
    this.placeholder = "";
    this.isFocused = true;
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
    this.placeholder = "Enter any title...";
    this.isFocused = false;
    this.hideSuggestions();
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
        break;
      case 'ArrowUp':
        event.preventDefault();
        this.selectedSuggestionIndex = Math.max(this.selectedSuggestionIndex - 1, -1);
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
