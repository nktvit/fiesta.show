import { inject, Injectable, Injector } from '@angular/core';
import { MusicAudioGraphService } from './music-audio-graph.service';
import { MusicLibraryService } from './music-library.service';
import { MusicListeningTrackerService } from './music-listening-tracker.service';
import { MusicPlayerService } from './music-player.service';
import { MusicScrobblerService } from './music-scrobbler.service';
import { MusicSettingsService } from './music-settings.service';
import { MusicShortcutsService } from './music-shortcuts.service';
import { MusicToastService } from './music-toast.service';
import { MusicUiService } from './music-ui.service';

/** What `?musicdebug=1` exposes as `window.__music` for e2e scripts. */
export interface MusicDebugHandle {
  player: MusicPlayerService;
  library: MusicLibraryService;
  settings: MusicSettingsService;
  ui: MusicUiService;
  toast: MusicToastService;
}

/**
 * Boots the app-wide music services once (AppComponent.ngOnInit). Each start()
 * is isolated so one feature failing can't take the others down.
 */
@Injectable({ providedIn: 'root' })
export class MusicStartupService {
  private injector = inject(Injector);
  private started = false;

  start(): void {
    if (this.started || typeof window === 'undefined') return;
    this.started = true;
    const boot = (name: string, fn: () => void) => {
      try {
        fn();
      } catch (e) {
        console.error(`music: ${name} failed to start`, e);
      }
    };
    boot('shortcuts', () => this.injector.get(MusicShortcutsService).start());
    boot('listening tracker', () => this.injector.get(MusicListeningTrackerService).start());
    boot('scrobbler', () => this.injector.get(MusicScrobblerService).start());
    boot('audio graph', () => this.injector.get(MusicAudioGraphService).start());

    boot('debug handle', () => {
      if (!/[?&]musicdebug=1\b/.test(window.location.search)) return;
      const handle: MusicDebugHandle = {
        player: this.injector.get(MusicPlayerService),
        library: this.injector.get(MusicLibraryService),
        settings: this.injector.get(MusicSettingsService),
        ui: this.injector.get(MusicUiService),
        toast: this.injector.get(MusicToastService),
      };
      (window as unknown as { __music?: MusicDebugHandle }).__music = handle;
    });
  }
}
