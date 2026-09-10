import { Component, inject } from '@angular/core';
import { Title, Meta } from '@angular/platform-browser';
import { NavbarComponent } from '../../components/navbar/navbar.component';
import { PosterComponent } from '../../components/poster/poster.component';
import { MovieCollectionComponent } from '../../components/movie-collection/movie-collection.component';
import { TmdbService } from '../../services/tmdb.service';
import { IMovie } from '../../interfaces/movie.interface';
import { InfiniteScrollDirective } from '../../directives/infinite-scroll.directive';

@Component({
  selector: 'app-tv',
  imports: [MovieCollectionComponent, NavbarComponent, PosterComponent, InfiniteScrollDirective],
  templateUrl: './tv.component.html',
  styleUrl: './tv.component.css',
})
export class TvComponent {
  trendingTV: IMovie[] = [];
  popularTV: IMovie[] = [];
  currentPage = 1;
  totalPages = 0;
  loading = true;
  isLoadingMore = false;
  hasMore = false;

  private tmdb = inject(TmdbService);
  private titleService = inject(Title);
  private metaService = inject(Meta);

  ngOnInit() {
    this.titleService.setTitle('TV Shows — Trending & Popular | Stream Fiesta');
    this.metaService.updateTag({ name: 'description', content: 'Browse trending and popular TV shows. Watch free, no sign-up.' });
    this.tmdb.getTrendingTV().subscribe(movies => {
      this.trendingTV = movies.slice(0, 15);
    });
    this.loadPopular();
  }

  loadPopular() {
    this.tmdb.getPopularTV(this.currentPage).subscribe(result => {
      this.popularTV = [...this.popularTV, ...result.movies];
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
    this.loadPopular();
  }
}
