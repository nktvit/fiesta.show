import { Component, inject } from '@angular/core';
import { NavigationEnd, Router, RouterOutlet } from '@angular/router';
import { filter } from 'rxjs';
import { NavigationService } from './services/navigation.service';
import { FooterComponent } from './components/footer/footer.component';
import { BottomNavComponent } from './components/bottom-nav/bottom-nav.component';
import { computeRoute, injectSpeedInsights } from '@vercel/speed-insights';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, FooterComponent, BottomNavComponent],
  templateUrl: './app.component.html',
  styleUrl: './app.component.css',
  host: { class: 'block min-h-screen' },
})
export class AppComponent {
  private nav = inject(NavigationService);
  private router = inject(Router);

  ngOnInit() {
    this.nav.init();

    // Angular is a client-routed SPA, so without this every Speed Insights
    // vital would be attributed to whichever route happened to be loaded
    // first — setRoute() re-tags each navigation with its own (normalized)
    // route instead.
    const speedInsights = injectSpeedInsights();
    this.router.events.pipe(filter((e): e is NavigationEnd => e instanceof NavigationEnd)).subscribe((event) => {
      const pathname = event.urlAfterRedirects.split(/[?#]/)[0];
      speedInsights?.setRoute(computeRoute(pathname, this.routeParams()));
    });
  }

  private routeParams(): Record<string, string> {
    const params: Record<string, string> = {};
    let route = this.router.routerState.snapshot.root;
    while (route) {
      Object.assign(params, route.params);
      if (!route.firstChild) break;
      route = route.firstChild;
    }
    return params;
  }
}
