import { afterNextRender, Component, effect, inject } from '@angular/core';
import { NavigationEnd, Router, RouterOutlet } from '@angular/router';
import { filter } from 'rxjs';
import { NavigationService } from './services/navigation.service';
import { FooterComponent } from './components/footer/footer.component';
import { BottomNavComponent } from './components/bottom-nav/bottom-nav.component';
import { MusicPlayerBarComponent } from './components/music-player-bar/music-player-bar.component';
import { MusicPlayerService } from './services/music-player.service';
import { MusicStartupService } from './services/music-startup.service';
import { MusicUiService } from './services/music-ui.service';
import { MusicToastHostComponent } from './components/music-toast-host/music-toast-host.component';
import { MusicQueuePanelComponent } from './components/music-queue-panel/music-queue-panel.component';
import { MusicLyricsPanelComponent } from './components/music-lyrics-panel/music-lyrics-panel.component';
import { MusicNowPlayingComponent } from './components/music-now-playing/music-now-playing.component';
import { MusicCommandPaletteComponent } from './components/music-command-palette/music-command-palette.component';
import { MusicShortcutsHelpComponent } from './components/music-shortcuts-help/music-shortcuts-help.component';
import { MusicTrackInfoComponent } from './components/music-track-info/music-track-info.component';
import { MusicContextMenuComponent } from './components/music-context-menu/music-context-menu.component';
import { MusicAddToPlaylistDialogComponent } from './components/music-add-to-playlist-dialog/music-add-to-playlist-dialog.component';
import { MusicImportDialogComponent } from './components/music-import-dialog/music-import-dialog.component';
import { MusicSelectionBarComponent } from './components/music-selection-bar/music-selection-bar.component';
import { MusicDownloadsTrayComponent } from './components/music-downloads-tray/music-downloads-tray.component';
import { computeRoute, injectSpeedInsights } from '@vercel/speed-insights';

/** Injects the Buy Me a Coffee widget, with the same config the old inline tag had. */
function loadBmcWidget(): void {
  if (document.querySelector('script[data-name="BMC-Widget"]')) return;
  const s = document.createElement('script');
  s.async = true;
  s.src = 'https://cdnjs.buymeacoffee.com/1.0.0/widget.prod.min.js';
  const data: Record<string, string> = {
    name: 'BMC-Widget', cfasync: 'false', id: 'nktvit',
    description: 'Support me on Buy me a coffee!',
    message: "Don't forget to grab some popcorn and friends. Happy watching!",
    color: '#FFDD00', position: 'Right', x_margin: '18', y_margin: '18',
  };
  for (const [k, v] of Object.entries(data)) s.setAttribute('data-' + k, v);
  // The widget boots on DOMContentLoaded / load, both long gone by now.
  s.onload = () => {
    window.dispatchEvent(new Event('DOMContentLoaded'));
    window.dispatchEvent(new Event('load'));
  };
  document.body.appendChild(s);
}

@Component({
  selector: 'app-root',
  imports: [
    RouterOutlet, FooterComponent, BottomNavComponent, MusicPlayerBarComponent, MusicToastHostComponent,
    // Only referenced inside @defer blocks, so each lands in its own lazy chunk.
    MusicQueuePanelComponent, MusicLyricsPanelComponent, MusicNowPlayingComponent, MusicCommandPaletteComponent,
    MusicShortcutsHelpComponent, MusicTrackInfoComponent, MusicContextMenuComponent, MusicAddToPlaylistDialogComponent,
    MusicImportDialogComponent, MusicSelectionBarComponent, MusicDownloadsTrayComponent,
  ],
  templateUrl: './app.component.html',
  styleUrl: './app.component.css',
  host: { class: 'block min-h-screen' },
})
export class AppComponent {
  private nav = inject(NavigationService);
  private router = inject(Router);
  protected readonly player = inject(MusicPlayerService);
  protected readonly ui = inject(MusicUiService);
  private musicStartup = inject(MusicStartupService);

  constructor() {
    // Lets styles.css lift the donation widget clear of the mini player.
    effect(() => document.body.classList.toggle('has-music-bar', !!this.player.track()));

    // The Buy Me a Coffee widget used to be a synchronous <script> in index.html,
    // which made Angular's module scripts wait on a third-party download. Load it
    // after the first render instead. (requestIdleCallback is missing on Safari,
    // so a plain timeout it is.)
    afterNextRender(() => setTimeout(loadBmcWidget, 1500));
  }

  ngOnInit() {
    this.nav.init();
    this.musicStartup.start();

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
