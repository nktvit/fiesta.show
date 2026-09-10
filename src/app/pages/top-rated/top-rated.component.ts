import { Component, inject } from '@angular/core';
import { Title, Meta } from '@angular/platform-browser';
import { NavbarComponent } from '../../components/navbar/navbar.component';
import { PosterComponent } from '../../components/poster/poster.component';
import { MovieCollectionComponent } from '../../components/movie-collection/movie-collection.component';
import { TmdbService } from '../../services/tmdb.service';
import { IMovie } from '../../interfaces/movie.interface';
import { InfiniteScrollDirective } from '../../directives/infinite-scroll.directive';

@Component({
  selector: 'app-top-rated',
  imports: [MovieCollectionComponent, NavbarComponent, PosterComponent, InfiniteScrollDirective],
  templateUrl: './top-rated.component.html',
  styleUrl: './top-rated.component.css',
})
export class TopRatedComponent {
  movies: IMovie[] = [];
  currentPage = 1;
  totalPages = 0;
  loading = true;
  isLoadingMore = false;
  hasMore = false;

  private tmdb = inject(TmdbService);
  private titleService = inject(Title);
  private metaService = inject(Meta);

  ngOnInit() {
    this.titleService.setTitle('Top Rated Movies of All Time | Stream Fiesta');
    this.metaService.updateTag({ name: 'description', content: 'The highest-rated movies of all time. Watch free, no sign-up.' });
    this.loadMovies();
  }

  loadMovies() {
    this.tmdb.getTopRatedPaginated(this.currentPage).subscribe(result => {
      this.movies = [...this.movies, ...result.movies];
      this.totalPages = result.totalPages;
      this.hasMore = this.currentPage < this.totalPages;
      this.loading = false;
      this.isLoadingMore = false;
    });
  }

  loadMore() {
    if (!this.hasMore || this.isLoadingMore) return;
    this.currentPage++;
    this.isLoadingMore = true;
    this.loadMovies();
  }
}
