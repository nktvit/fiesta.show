import { Component, inject, input, HostListener } from '@angular/core';
import { SearchBoxComponent } from '../search-box/search-box.component';
import { RouterLink, Router, NavigationEnd } from '@angular/router';
import { NgClass } from '@angular/common';
import { filter } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { LoggerService } from "../../services/logger.service";
import { TmdbService } from "../../services/tmdb.service";

@Component({
  selector: 'app-navbar',
  imports: [SearchBoxComponent, RouterLink, NgClass],
  templateUrl: './navbar.component.html',
  styleUrl: './navbar.component.css'
})
export class NavbarComponent {
  readonly showSearchBox = input<boolean>(false);
  readonly transparent = input<boolean>(false);
  /** Pages whose whole job is search (`/search`) keep the box on mobile too;
      everywhere else mobile search lives in the bottom nav's Search tab. */
  readonly mobileSearch = input<boolean>(false);
  isGenreOpen = false;
  currentPage = "/";
  scrolled = false;
  genres: { id: number; name: string }[] = [];

  private router = inject(Router);
  private logger = inject(LoggerService);
  private tmdb = inject(TmdbService);

  constructor() {
    // Reading router.url once in ngOnInit froze the active-link highlight on
    // whatever route loaded first — this is a client-routed SPA, so the URL
    // changes without the component being re-created.
    this.router.events.pipe(
      filter((e): e is NavigationEnd => e instanceof NavigationEnd),
      takeUntilDestroyed(),
    ).subscribe(e => {
      this.currentPage = e.urlAfterRedirects.split(/[?#]/)[0];
      this.isGenreOpen = false;
    });
  }

  ngOnInit(): void {
    this.currentPage = this.router.url.split(/[?#]/)[0];
    this.logger.log(this.currentPage);
    this.tmdb.getGenres().subscribe(g => this.genres = g);
  }

  @HostListener('window:scroll')
  onScroll() {
    this.scrolled = window.scrollY > 50;
  }

  @HostListener('document:click', ['$event'])
  onDocumentClick(event: Event) {
    if (this.isGenreOpen && !(event.target as HTMLElement).closest('.genre-dropdown')) {
      this.isGenreOpen = false;
    }
  }
}
