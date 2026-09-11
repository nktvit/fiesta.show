import { Component, inject } from '@angular/core';
import { Title, Meta } from '@angular/platform-browser';
import { DecimalPipe } from '@angular/common';
import { SearchBoxComponent } from '../../components/search-box/search-box.component';
import { PosterComponent } from '../../components/poster/poster.component';
import { MovieCollectionComponent } from '../../components/movie-collection/movie-collection.component';
import { MovieService } from '../../services/movie.service';
import { PersonSearchResult, TmdbService } from '../../services/tmdb.service';
import { NavbarComponent } from '../../components/navbar/navbar.component';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { NotfoundComponent } from '../../components/notfound/notfound.component';
import { IMovie } from "../../interfaces/movie.interface";
import { LoggerService } from "../../services/logger.service";
import { InfiniteScrollDirective } from '../../directives/infinite-scroll.directive';

@Component({
  selector: 'app-search-page',
  imports: [PosterComponent, MovieCollectionComponent, NavbarComponent, NotfoundComponent, InfiniteScrollDirective, RouterLink, SearchBoxComponent, DecimalPipe],
  templateUrl: './search-page.component.html',
  styleUrl: './search-page.component.css'
})
export class SearchPageComponent {
  movies: IMovie[] = [];
  people: PersonSearchResult[] = [];
  totalResults = 0;
  currentPage = 1;
  hasMore = false;
  isLoading = false;
  isLoadingMore = false;
  /** False until a query arrives. The bottom nav's Search tab lands here with
      no query at all, and "no results found" is the wrong thing to greet it
      with — that's a failed search, not an empty one. */
  hasQuery = false;
  /** Bound by the h1. Only ever a const inside the subscription before, which
      strictTemplates rejects. */
  query = '';
  genres: { id: number; name: string }[] = [];

  private movieService = inject(MovieService);
  private tmdbService = inject(TmdbService);
  private route = inject(ActivatedRoute);
  private logger = inject(LoggerService);
  private titleService = inject(Title);
  private metaService = inject(Meta);

  ngOnInit(): void {
    // shareReplay(1) in TmdbService, and the navbar already fetches it on every
    // page — a cache hit, not a new request.
    this.tmdbService.getGenres().subscribe(g => this.genres = g.slice(0, 10));

    this.route.queryParams.subscribe(params => {
      const query = params['query'];
      this.hasQuery = !!query;
      if (query) {
        this.query = query;
        this.titleService.setTitle(`Search "${query}" | Stream Fiesta`);
        this.metaService.updateTag({ name: 'description', content: `Search results for "${query}" — watch free on Stream Fiesta.` });
        this.movies = [];
        this.people = [];
        this.currentPage = 1;
        this.hasMore = false;
        this.fetchMovies(query, 1, false);
        this.tmdbService.searchPeople(query).subscribe(people => {
          this.people = people;
        });
      } else {
        // `/search?query=dune` -> `/search` is a queryParams-only change on the
        // same route config, so the component is reused and ngOnInit does not
        // re-run. Without this reset, tapping the bottom nav's Search tab left
        // the previous query's People row and 20 posters standing under a
        // "Search Stream Fiesta" header. The old markup hid that by accident,
        // because its prompt was gated on `movies.length === 0`.
        this.query = '';
        this.titleService.setTitle('Search | Stream Fiesta');
        this.metaService.updateTag({ name: 'description', content: 'Search movies, shows and people on Stream Fiesta.' });
        this.movies = [];
        this.people = [];
        this.totalResults = 0;
        this.currentPage = 1;
        this.hasMore = false;
        this.isLoading = false;
        this.isLoadingMore = false;
        // provideRouter has no withInMemoryScrolling, so scrollPositionRestoration
        // defaults to 'disabled' and a forward pushState leaves scrollY alone —
        // the Search tab would otherwise land you far down a page that is now
        // empty. Scoped here rather than changed globally.
        window.scrollTo({ top: 0 });
      }
    });
  }

  private fetchMovies(query: string, page: number, append: boolean) {
    if (append) {
      this.isLoadingMore = true;
    } else {
      this.isLoading = true;
    }

    this.movieService.searchMovies(query, page).subscribe({
      next: (response) => {
        if (response?.Search) {
          const newMovies: IMovie[] = response.Search;
          this.movies = append ? [...this.movies, ...newMovies] : newMovies;
          this.totalResults = parseInt(response.totalResults) || 0;
          this.hasMore = this.movies.length < this.totalResults;
        } else {
          if (!append) this.movies = [];
          this.hasMore = false;
        }
        this.isLoading = false;
        this.isLoadingMore = false;
      },
      error: (error) => {
        this.logger.error('Error during search:', error);
        this.isLoading = false;
        this.isLoadingMore = false;
      }
    });
  }

  loadMore(): void {
    if (!this.hasMore || this.isLoadingMore || this.isLoading) return;
    this.currentPage++;
    this.fetchMovies(this.movieService.currentQuery, this.currentPage, true);
  }
}
