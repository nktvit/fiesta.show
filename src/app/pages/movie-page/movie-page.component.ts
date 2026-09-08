import {Component, inject, PLATFORM_ID, OnDestroy} from '@angular/core';
import {isPlatformBrowser, NgClass} from '@angular/common';
import {MovieService} from '../../services/movie.service';
import {ActivatedRoute, Router, RouterLink} from '@angular/router';
import {DomSanitizer, SafeResourceUrl} from '@angular/platform-browser';
import {NavbarComponent} from '../../components/navbar/navbar.component';
import {BackButtonComponent} from '../../components/back-button/back-button.component';
import {MoviePlayerComponent} from "../../components/movie-player/movie-player.component";
import {LikesCommentsComponent} from "../../components/likes-comments/likes-comments.component";
import {catchError, of, switchMap, tap} from "rxjs";
import {PosterComponent} from "../../components/poster/poster.component";
import {LoggerService} from "../../services/logger.service";
import {TmdbService, CastMember, CrewMember} from "../../services/tmdb.service";
import {IMovie} from "../../interfaces/movie.interface";
import {environment} from "../../../environments/environment";
import {Title, Meta} from '@angular/platform-browser';

interface EpisodeInfo {
  number: number;
  title: string;
  rating: string | null;
  airDate: string | null;
  still: string | null;
}

@Component({
  selector: 'app-movie-page',
  imports: [NavbarComponent, BackButtonComponent, NgClass, MoviePlayerComponent, LikesCommentsComponent, PosterComponent, RouterLink],
  templateUrl: './movie-page.component.html',
  styleUrl: './movie-page.component.css'
})
export class MoviePageComponent implements OnDestroy {
  private jsonLdElement: HTMLScriptElement | null = null;
  private platformId = inject(PLATFORM_ID);
  isLoading = true;
  invalidResponse: boolean = false;
  isFullPlot = false;
  shouldClamp = false;
  isPlotLong = false;
  adjustedPlot = '';
  movieId: string = "";
  movieDetails: any = {};
  movieDetailsArray: any[] = [];
  protected type: string = 'movie';
  protected imdbId: any;
  protected season: number | null = null;
  protected episode: number | null = null;
  protected totalSeasons: number = 0;
  protected seasonNumbers: number[] = [];
  protected episodes: EpisodeInfo[] = [];
  protected loadingEpisodes = false;
  protected server: number = 0;
  protected recommendations: IMovie[] = [];
  protected seasonNames: Map<number, string> = new Map();
  protected trailerKey: string | null = null;
  protected showTrailer = false;
  private originalRouteId: string = '';
  protected tmdbId: number | null = null;
  protected backdropUrl: string | null = null;
  protected cast: CastMember[] = [];
  protected directors: CrewMember[] = [];

  private movieService = inject(MovieService);
  private tmdbService = inject(TmdbService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private logger = inject(LoggerService);
  private sanitizer = inject(DomSanitizer);
  private titleService = inject(Title);
  private metaService = inject(Meta);

  ngOnInit() {
    this.isLoading = true;

    this.route.queryParams.subscribe(params => {
      this.season = params['s'] ? +params['s'] : null;
      this.episode = params['e'] ? +params['e'] : null;
      this.server = params['srv'] ? +params['srv'] : 0;
    });

    this.route.paramMap.pipe(
      switchMap(params => {
        const id = params.get('id');
        if (id === null) return of(null);

        // Reset state for new movie
        this.isLoading = true;
        this.invalidResponse = false;
        this.movieDetails = {};
        this.movieDetailsArray = [];
        this.adjustedPlot = '';
        this.isFullPlot = false;
        this.imdbId = null;
        this.type = 'movie';
        // Preserve the episode from the URL across a refresh / deep link; only the
        // TV default below fills these when the query params are genuinely absent.
        this.season = this.route.snapshot.queryParams['s'] ? +this.route.snapshot.queryParams['s'] : null;
        this.episode = this.route.snapshot.queryParams['e'] ? +this.route.snapshot.queryParams['e'] : null;
        this.totalSeasons = 0;
        this.seasonNumbers = [];
        this.episodes = [];
        this.recommendations = [];
        this.trailerKey = null;
        this.showTrailer = false;
        this.tmdbId = null;
        this.backdropUrl = null;
        this.cast = [];
        this.directors = [];
        this.originalRouteId = id;
        window.scrollTo({ top: 0 });

        // If numeric ID, it's a TMDB ID — resolve to IMDB ID and redirect
        if (/^\d+$/.test(id)) {
          const tmdbId = +id;
          const typeHint = this.route.snapshot.queryParams['type'] as 'movie' | 'tv' | undefined;
          this.tmdbService.getImdbId(tmdbId, typeHint).subscribe(imdbId => {
            if (imdbId) {
              this.router.navigate(['/movie', imdbId], {
                replaceUrl: true,
                queryParams: { tmdb: tmdbId, type: typeHint || null },
                queryParamsHandling: 'merge',
              });
            } else {
              this.invalidResponse = true;
              this.isLoading = false;
            }
          });
          return of(null);
        }

        // Standard IMDB ID
        this.movieId = id;
        return this.movieService.getMovieDetails(id).pipe(
          catchError(error => {
            this.logger.error('Error fetching movie details: ', error);
            this.invalidResponse = true;
            this.isLoading = false;
            return of(null);
          })
        );
      }),
      tap(details => {
        if (details === null) return; // Skip — either redirecting or no data yet
        if (details) {
          this.invalidResponse = false;
          this.movieDetails = details;
          this.logger.log('Movie details: ', details);

          // In production, _tmdbId / _backdrop come from the enriched /api/movie response
          if (details._tmdbId) {
            this.tmdbId = details._tmdbId;
          }
          if (details._backdrop) {
            this.backdropUrl = details._backdrop;
          }

          if (details.Plot && details.Plot !== 'N/A') {
            this.adjustedPlot = this.adjustPlot(details.Plot);
            this.isPlotLong = this.adjustedPlot.length > 400;
            this.shouldClamp = !this.isFullPlot && this.isPlotLong;
          }

          this.movieDetailsArray = this.movieService.formatMovieDetailsArray(details);
          this.imdbId = this.movieService.getImdbId(details);
          this.type = this.movieService.getMediaType(details);

          // Update page title, meta tags, and JSON-LD
          this.updatePageMeta();

          // In production, gap-filling is done server-side; in dev, do it client-side
          if (!environment.production) {
            this.fillMissingFromTmdb(details);
          }

          if (this.type === 'tv') {
            if (!this.season) this.season = 1;
            if (!this.episode) this.episode = 1;
            this.resolveTmdbId();
          }
        }
        this.isLoading = false;
        this.loadRecommendations();
        this.loadTrailer();
        this.loadBackdrop();
        this.loadCredits();
      })
    ).subscribe();
  }

  private fillMissingFromTmdb(details: any) {
    const na = (v: any) => !v || v === 'N/A';
    const needsPoster = na(details.Poster);
    const needsPlot = na(details.Plot);
    const needsRating = na(details.imdbRating) && (!details.Ratings || details.Ratings.length === 0);
    const needsYear = na(details.Year);

    if (!needsPoster && !needsPlot && !needsRating && !needsYear) return;

    this.tmdbService.findByImdbId(this.imdbId).subscribe(tmdb => {
      if (!tmdb) return;
      if (tmdb.backdrop) this.backdropUrl = tmdb.backdrop;
      const patch: any = {};

      if (needsPoster && tmdb.poster) patch.Poster = tmdb.poster;
      if (needsYear && tmdb.releaseDate) patch.Year = tmdb.releaseDate.substring(0, 4);
      if (needsRating && tmdb.rating) {
        patch.imdbRating = tmdb.rating.toFixed(1);
        patch.Ratings = [{ Source: 'TMDB', Value: `${tmdb.rating.toFixed(1)}/10` }];
      }

      if (Object.keys(patch).length > 0) {
        this.movieDetails = { ...this.movieDetails, ...patch };
        this.movieDetailsArray = this.movieService.formatMovieDetailsArray(this.movieDetails);
      }

      if (needsPlot && tmdb.overview) {
        this.adjustedPlot = this.adjustPlot(tmdb.overview);
        this.isPlotLong = this.adjustedPlot.length > 400;
        this.shouldClamp = !this.isFullPlot && this.isPlotLong;
      }

      this.updatePageMeta();
    });
  }

  private updatePageMeta() {
    const title = this.movieDetails?.Title;
    const year = this.movieDetails?.Year;
    const plot = this.adjustedPlot;

    if (!title || title === 'N/A') return;

    const yearSuffix = year && year !== 'N/A' ? ` (${year})` : '';
    const pageTitle = `${title}${yearSuffix} — Stream Free | Stream Fiesta`;
    const desc = plot
      ? `Watch ${title}${yearSuffix} online for free. ${plot.substring(0, 120)}...`
      : `Watch ${title}${yearSuffix} online for free on Stream Fiesta. No subscription, no sign-up.`;

    this.titleService.setTitle(pageTitle);
    this.metaService.updateTag({ name: 'description', content: desc });
    this.metaService.updateTag({ property: 'og:title', content: pageTitle });
    this.metaService.updateTag({ property: 'og:description', content: desc });

    this.updateJsonLd();
  }

  private updateJsonLd() {
    if (!isPlatformBrowser(this.platformId)) return;

    const d = this.movieDetails;
    if (!d?.Title || d.Title === 'N/A') return;

    const isTV = this.type === 'tv';
    const schema: any = {
      '@context': 'https://schema.org',
      '@type': isTV ? 'TVSeries' : 'Movie',
      name: d.Title,
      url: `https://fiesta.show/movie/${this.imdbId || this.originalRouteId}`,
    };

    if (d.Released && d.Released !== 'N/A') {
      schema.datePublished = d.Released;
    } else if (d.Year && d.Year !== 'N/A') {
      schema.datePublished = d.Year;
    }
    if (this.adjustedPlot) {
      schema.description = this.adjustedPlot.substring(0, 400);
    }
    if (d.Poster && d.Poster !== 'N/A') {
      schema.image = d.Poster;
    }
    if (d.Director && d.Director !== 'N/A') {
      schema.director = d.Director.split(', ').map((name: string) => ({ '@type': 'Person', name }));
    }
    if (d.Genre && d.Genre !== 'N/A') {
      schema.genre = d.Genre.split(', ');
    }
    if (d.imdbRating && d.imdbRating !== 'N/A') {
      schema.aggregateRating = {
        '@type': 'AggregateRating',
        ratingValue: d.imdbRating,
        bestRating: '10',
        ratingCount: d.imdbVotes?.replace(/,/g, '') || undefined,
      };
    }
    if (d.Actors && d.Actors !== 'N/A') {
      schema.actor = d.Actors.split(', ').map((name: string) => ({ '@type': 'Person', name }));
    }
    if (d.Rated && d.Rated !== 'N/A') {
      schema.contentRating = d.Rated;
    }
    if (d.Runtime && d.Runtime !== 'N/A') {
      const mins = parseInt(d.Runtime, 10);
      if (!isNaN(mins)) {
        const h = Math.floor(mins / 60);
        const m = mins % 60;
        schema.duration = h > 0 ? `PT${h}H${m > 0 ? m + 'M' : ''}` : `PT${m}M`;
      }
    }
    if (d.Production && d.Production !== 'N/A') {
      schema.productionCompany = { '@type': 'Organization', name: d.Production };
    }
    if (d.Country && d.Country !== 'N/A') {
      schema.countryOfOrigin = d.Country.split(', ').map((c: string) => ({ '@type': 'Country', name: c }));
    }
    if (d.Language && d.Language !== 'N/A') {
      schema.inLanguage = d.Language.split(', ');
    }
    if (d.Awards && d.Awards !== 'N/A') {
      schema.award = d.Awards;
    }
    if (isTV && this.totalSeasons > 0) {
      schema.numberOfSeasons = this.totalSeasons;
    }
    if (this.trailerKey) {
      schema.trailer = {
        '@type': 'VideoObject',
        name: `${d.Title} — Official Trailer`,
        embedUrl: `https://www.youtube.com/embed/${this.trailerKey}`,
      };
    }

    // Remove old element if exists
    if (this.jsonLdElement) {
      this.jsonLdElement.remove();
    }

    this.jsonLdElement = document.createElement('script');
    this.jsonLdElement.type = 'application/ld+json';
    this.jsonLdElement.text = JSON.stringify(schema);
    document.head.appendChild(this.jsonLdElement);
  }

  ngOnDestroy() {
    if (this.jsonLdElement) {
      this.jsonLdElement.remove();
      this.jsonLdElement = null;
    }
    if (this.showTrailer && isPlatformBrowser(this.platformId)) {
      document.body.style.overflow = '';
    }
  }

  private loadRecommendations() {
    const tmdbParam = this.route.snapshot.queryParams['tmdb'];
    const resolvedId = this.tmdbId
      || (tmdbParam ? +tmdbParam : null)
      || (/^\d+$/.test(this.originalRouteId) ? +this.originalRouteId : null);

    if (resolvedId) {
      this.fetchRecommendations(resolvedId);
    } else if (this.imdbId) {
      // Fallback: resolve via API (dev mode, or if enriched response didn't include tmdbId)
      this.tmdbService.findTmdbId(this.imdbId).subscribe(id => {
        if (id) this.fetchRecommendations(id);
      });
    }
  }

  private fetchRecommendations(tmdbId: number) {
    this.tmdbService.getRecommendations(tmdbId, this.type).subscribe(movies => {
      this.recommendations = movies.slice(0, 15);
    });
  }

  private loadTrailer() {
    const resolvedId = this.tmdbId
      || +(this.route.snapshot.queryParams['tmdb'] || 0)
      || (/^\d+$/.test(this.originalRouteId) ? +this.originalRouteId : 0);

    if (resolvedId) {
      this.tmdbService.getTrailerKey(resolvedId, this.type).subscribe(key => {
        this.trailerKey = key;
      });
    } else if (this.imdbId) {
      this.tmdbService.findTmdbId(this.imdbId).subscribe(id => {
        if (id) {
          this.tmdbService.getTrailerKey(id, this.type).subscribe(key => {
            this.trailerKey = key;
          });
        }
      });
    }
  }

  private loadCredits() {
    const resolvedId = this.tmdbId
      || +(this.route.snapshot.queryParams['tmdb'] || 0)
      || (/^\d+$/.test(this.originalRouteId) ? +this.originalRouteId : 0);

    if (resolvedId) {
      this.tmdbService.getCredits(resolvedId, this.type).subscribe(({cast, directors}) => {
        this.cast = cast;
        this.directors = directors;
      });
    } else if (this.imdbId) {
      this.tmdbService.findTmdbId(this.imdbId).subscribe(id => {
        if (id) {
          this.tmdbService.getCredits(id, this.type).subscribe(({cast, directors}) => {
            this.cast = cast;
            this.directors = directors;
          });
        }
      });
    }
  }

  private loadBackdrop() {
    if (this.imdbId) {
      this.tmdbService.findByImdbId(this.imdbId).subscribe(result => {
        this.backdropUrl = result?.backdrop ?? null;
      });
    }
  }

  // Memoized: a getter re-evaluated every change-detection cycle would call
  // bypassSecurityTrustResourceUrl() again each time, returning a new object
  // even though the URL is unchanged — Angular then sees the iframe's [src]
  // as "changed" and reloads it, which is what caused the trailer to visibly
  // blink/refresh while open.
  private trailerUrlCache: { key: string; url: SafeResourceUrl } | null = null;

  get trailerUrl(): SafeResourceUrl | null {
    if (!this.trailerKey) return null;
    if (this.trailerUrlCache?.key !== this.trailerKey) {
      this.trailerUrlCache = {
        key: this.trailerKey,
        url: this.sanitizer.bypassSecurityTrustResourceUrl(
          `https://www.youtube.com/embed/${this.trailerKey}?autoplay=1`
        ),
      };
    }
    return this.trailerUrlCache.url;
  }

  openTrailer() {
    this.showTrailer = true;
    if (isPlatformBrowser(this.platformId)) document.body.style.overflow = 'hidden';
  }

  closeTrailer() {
    this.showTrailer = false;
    if (isPlatformBrowser(this.platformId)) document.body.style.overflow = '';
  }

  private resolveTmdbId() {
    if (!this.tmdbId) {
      const tmdbParam = this.route.snapshot.queryParams['tmdb'];
      this.tmdbId = tmdbParam ? +tmdbParam : (/^\d+$/.test(this.originalRouteId) ? +this.originalRouteId : null);
    }

    if (this.tmdbId) {
      // Use TMDB for season/episode data (more accurate, especially for anime)
      this.tmdbService.getTVDetails(this.tmdbId).subscribe(details => {
        this.totalSeasons = details.totalSeasons;
        this.seasonNumbers = details.seasons.map(s => s.number);
        details.seasons.forEach(s => this.seasonNames.set(s.number, s.name));
        this.loadEpisodes(this.season!);
      });
    } else {
      // Fall back to OMDB
      const omdbSeasons = this.movieDetails.totalSeasons;
      if (omdbSeasons && omdbSeasons !== 'N/A') {
        this.totalSeasons = +omdbSeasons;
        this.seasonNumbers = Array.from({length: this.totalSeasons}, (_, i) => i + 1);
        this.loadEpisodes(this.season!);
      }
    }
  }

  loadEpisodes(season: number) {
    this.loadingEpisodes = true;

    if (this.tmdbId) {
      // TMDB episodes
      this.tmdbService.getTVSeasonEpisodes(this.tmdbId, season).subscribe(episodes => {
        this.episodes = episodes;
        this.loadingEpisodes = false;
      });
    } else {
      // OMDB episodes (fallback)
      this.movieService.getSeasonEpisodes(this.imdbId, season).subscribe(episodes => {
        this.episodes = episodes.map((ep: any) => ({
          number: +ep.Episode,
          title: ep.Title,
          rating: ep.imdbRating !== 'N/A' ? ep.imdbRating : null,
          airDate: ep.Released !== 'N/A' ? ep.Released : null,
          still: null,
        }));
        this.loadingEpisodes = false;
      });
    }
  }

  goToEpisode(season: number, episode: number) {
    if (episode < 1) episode = 1;
    if (this.episodes.length > 0 && episode > this.episodes.length) {
      episode = this.episodes.length;
    }
    this.season = season;
    this.episode = episode;
    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: {s: season, e: episode},
      queryParamsHandling: 'merge',
    });
  }

  prevEpisode() {
    if (this.episode && this.episode > 1) {
      this.goToEpisode(this.season!, this.episode - 1);
    }
  }

  nextEpisode() {
    if (this.episode && this.episodes.length > 0 && this.episode >= this.episodes.length) return;
    this.goToEpisode(this.season!, (this.episode || 0) + 1);
  }

  onSeasonChange(seasonNum: number) {
    this.loadEpisodes(seasonNum);
    this.goToEpisode(seasonNum, 1);
  }

  onServerChange(index: number) {
    this.server = index;
    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { srv: index || null },
      queryParamsHandling: 'merge',
    });
  }

  // Image shown on the player before playback: the current episode's still for
  // series, otherwise the movie backdrop (falling back to the poster).
  get playerPoster(): string | null {
    if (this.type === 'tv') {
      const ep = this.episodes.find(e => e.number === this.episode);
      if (ep?.still) return ep.still;
    }
    if (this.backdropUrl) return this.backdropUrl;
    const p = this.movieDetails?.Poster;
    return p && p !== 'N/A' ? p : null;
  }

  get showMetascoreFallback(): boolean {
    return this.movieDetails?.Metascore &&
      this.movieDetails.Metascore !== 'N/A' &&
      !this.movieDetails.Ratings?.some((r: any) => r.Source === 'Metacritic');
  }

  togglePlot() {
    this.isFullPlot = !this.isFullPlot;
    this.shouldClamp = !this.isFullPlot && this.isPlotLong;
  }

  adjustPlot(plot: string): string {
    if (!plot || plot === 'N/A') {
      return '';
    }
    return plot.trim().replace(/,\s*$/, '');
  }
}
