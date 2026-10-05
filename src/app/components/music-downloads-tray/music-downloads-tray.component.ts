import { Component, inject, signal } from '@angular/core';
import { MusicDownloadService, MusicDownloadTask } from '../../services/music-download.service';
import { MusicSettingsService } from '../../services/music-settings.service';
import { MusicDialogComponent } from '../music-dialog/music-dialog.component';

/**
 * Download progress tray (global host, z-[60]): one card per download with
 * progress, Cancel and Retry, plus the "download N albums?" confirm dialog.
 * Renders nothing while MUSIC_DOWNLOADS_ENABLED is false. Owned by package P12.
 */
@Component({
  selector: 'app-music-downloads-tray',
  imports: [MusicDialogComponent],
  templateUrl: './music-downloads-tray.component.html',
})
export class MusicDownloadsTrayComponent {
  protected readonly downloads = inject(MusicDownloadService);
  protected readonly settings = inject(MusicSettingsService);
  protected readonly collapsed = signal(false);

  constructor() {
    // e2e handle: ?musicdebug=1 builds window.__music at startup; add the download service to it.
    if (typeof window === 'undefined') return;
    const attach = () => {
      const handle = (window as unknown as { __music?: Record<string, unknown> }).__music;
      if (handle) handle['downloads'] = this.downloads;
      return !!handle;
    };
    if (!attach()) setTimeout(attach, 500);
  }

  protected percent(t: MusicDownloadTask): number {
    return Math.round(t.progress * 100);
  }

  protected active(): number {
    return this.downloads.tasks().filter((t) => t.status === 'running' || t.status === 'queued').length;
  }

  protected label(t: MusicDownloadTask): string {
    switch (t.status) {
      case 'running': return `Downloading ${t.name} ${this.percent(t)} %`;
      case 'queued': return `Queued ${t.name}`;
      case 'done': return `Saved ${t.name}`;
      case 'error': return `Failed ${t.name}`;
      default: return `Cancelled ${t.name}`;
    }
  }

  protected finished(): boolean {
    return this.downloads.tasks().some((t) => t.status === 'done' || t.status === 'cancelled');
  }
}
