import { Component, inject } from '@angular/core';
import { Title, Meta } from '@angular/platform-browser';
import { ActivatedRoute } from '@angular/router';
import { NavbarComponent } from '../../components/navbar/navbar.component';
import { PosterComponent } from '../../components/poster/poster.component';
import { MovieCollectionComponent } from '../../components/movie-collection/movie-collection.component';
import { TmdbService } from '../../services/tmdb.service';
import { IMovie } from '../../interfaces/movie.interface';
import { InfiniteScrollDirective } from '../../directives/infinite-scroll.directive';

@Component({
  selector: 'app-genre',
  imports: [MovieCollectionComponent, NavbarComponent, PosterComponent, InfiniteScrollDirective],
  templateUrl: './genre.component.html',
  styleUrl: './genre.component.css',
})
export class GenreComponent {
  movies: IMovie[] = [];
  genreName = '';
  genreId = 0;
  currentPage = 1;
  totalPages = 0;
  loading = true;
  isLoadingMore = false;
  hasMore = false;

  private route = inject(ActivatedRoute);
  private tmdb = inject(TmdbService);
  private titleService = inject(Title);
  private metaService = inject(Meta);

  ngOnInit() {
    this.route.paramMap.subscribe(params => {
      this.genreId = +(params.get('id') || 0);
      this.movies = [];
      this.currentPage = 1;
      this.hasMore = false;
      this.loading = true;
      this.loadGenreName();
      this.loadMovies();
    });
  }

  loadGenreName() {
    this.tmdb.getGenres().subscribe(genres => {
      const genre = genres.find(g => g.id === this.genreId);
      this.genreName = genre ? genre.name : 'Genre';
      this.titleService.setTitle(`${this.genreName} Movies — Stream Free | Stream Fiesta`);
      this.metaService.updateTag({ name: 'description', content: `Browse popular ${this.genreName} movies and watch for free. No subscription needed.` });
      this.metaService.updateTag({ property: 'og:title', content: `${this.genreName} Movies — Stream Free | Stream Fiesta` });
      this.metaService.updateTag({ property: 'og:description', content: `Browse popular ${this.genreName} movies and watch for free. No subscription needed.` });
    });
  }

  loadMovies() {
    this.tmdb.discoverByGenre(this.genreId, this.currentPage).subscribe(result => {
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
