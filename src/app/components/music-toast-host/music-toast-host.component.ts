import { Component, DestroyRef, inject } from '@angular/core';
import { MusicPlayerService } from '../../services/music-player.service';
import { MusicSettingsService } from '../../services/music-settings.service';
import { MusicToastService } from '../../services/music-toast.service';

/**
 * Renders MusicToastService's toasts in an aria-live region (z-[70]), above
 * the bottom nav and the player bar. Also announces going offline/online.
 */
@Component({
  selector: 'app-music-toast-host',
  templateUrl: './music-toast-host.component.html',
})
export class MusicToastHostComponent {
  protected readonly toast = inject(MusicToastService);
  protected readonly player = inject(MusicPlayerService);
  protected readonly settings = inject(MusicSettingsService);

  constructor() {
    if (typeof window === 'undefined') return;
    let offlineId: number | null = null;
    const offline = () => {
      offlineId = this.toast.show({ message: "You're offline. Music will resume when you reconnect.", tone: 'warn', duration: 0 });
    };
    const online = () => {
      if (offlineId !== null) this.toast.dismiss(offlineId);
      offlineId = null;
      this.toast.show({ message: 'Back online' });
    };
    window.addEventListener('offline', offline);
    window.addEventListener('online', online);
    inject(DestroyRef).onDestroy(() => {
      window.removeEventListener('offline', offline);
      window.removeEventListener('online', online);
    });
  }
}
