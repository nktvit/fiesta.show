import { Component, effect, inject } from '@angular/core';
import { Router, RouterOutlet } from '@angular/router';
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
  }

  ngOnInit() {
    this.nav.init();
    this.musicStartup.start();
  }
}
