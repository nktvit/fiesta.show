import {Component, inject} from '@angular/core'
import {Title, Meta} from '@angular/platform-browser'
import {Router, RouterLink} from '@angular/router'
import {DecimalPipe} from '@angular/common'
import {NavbarComponent} from '../../components/navbar/navbar.component'
import {PosterComponent} from "../../components/poster/poster.component"
import {IMovie} from "../../interfaces/movie.interface"
import {TmdbService} from "../../services/tmdb.service"

@Component({
  selector: 'app-main',
  templateUrl: './main.component.html',
  styleUrl: './main.component.css',
  imports: [NavbarComponent, PosterComponent, DecimalPipe, RouterLink]
})
export class MainComponent {
  heroMovie: IMovie | null = null;
  trendingMovies: IMovie[] = [];
  popularMovies: IMovie[] = [];
  nowPlayingMovies: IMovie[] = [];
  topRatedMovies: IMovie[] = [];
  trendingTV: IMovie[] = [];
  genres: { id: number; name: string }[] = [];
  loading = true;

  private tmdb = inject(TmdbService);
  private router = inject(Router);
  private titleService = inject(Title);
  private metaService = inject(Meta);

  ngOnInit() {
    this.titleService.setTitle('Stream Fiesta — Watch Movies & TV Shows Free');
    this.metaService.updateTag({ name: 'description', content: 'Watch trending movies, TV shows, and series for free. No subscription, no sign-up. Just press play.' });
    this.metaService.updateTag({ property: 'og:title', content: 'Stream Fiesta — Watch Movies & TV Shows Free' });
    this.metaService.updateTag({ property: 'og:description', content: 'Watch trending movies, TV shows, and series for free. No subscription, no sign-up. Just press play.' });

    this.tmdb.getTrending().subscribe(movies => {
      if (movies.length > 0) {
        // Pick a random hero from the top 5 trending with a backdrop
        const candidates = movies.filter(m => m.Backdrop).slice(0, 5);
        this.heroMovie = candidates[Math.floor(Math.random() * candidates.length)] || movies[0];
        this.trendingMovies = movies.slice(0, 20);

        // Preload hero backdrop
        if (this.heroMovie?.Backdrop) {
          const link = document.createElement('link');
          link.rel = 'preload';
          link.as = 'image';
          link.href = this.heroMovie.Backdrop;
          document.head.appendChild(link);
        }
      }
      this.loading = false;
    });

    this.tmdb.getPopular().subscribe(movies => {
      this.popularMovies = movies.slice(0, 20);
    });

    this.tmdb.getNowPlaying().subscribe(movies => {
      this.nowPlayingMovies = movies.slice(0, 20);
    });

    this.tmdb.getTopRated().subscribe(movies => {
      this.topRatedMovies = movies.slice(0, 20);
    });

    this.tmdb.getTrendingTV().subscribe(movies => {
      this.trendingTV = movies.slice(0, 20);
    });

    this.tmdb.getGenres().subscribe(g => this.genres = g);
  }

  playHero() {
    if (this.heroMovie) {
      this.router.navigate(['/movie', this.heroMovie.imdbID || this.heroMovie.tmdbId]);
    }
  }
}
