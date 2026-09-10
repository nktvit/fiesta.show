import { Component, inject } from '@angular/core';
import { Title, Meta } from '@angular/platform-browser';
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
  imports: [PosterComponent, MovieCollectionComponent, NavbarComponent, NotfoundComponent, InfiniteScrollDirective, RouterLink],
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

  private movieService = inject(MovieService);
  private tmdbService = inject(TmdbService);
  private route = inject(ActivatedRoute);
  private logger = inject(LoggerService);
  private titleService = inject(Title);
  private metaService = inject(Meta);

  ngOnInit(): void {
    this.route.queryParams.subscribe(params => {
      const query = params['query'];
      if (query) {
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
