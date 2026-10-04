import { Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MusicPlayerService } from '../../services/music-player.service';

/** Persistent mini player. Sits above the mobile tab bar, flush to the bottom on desktop. */
@Component({
  selector: 'app-music-player-bar',
  imports: [RouterLink],
  templateUrl: './music-player-bar.component.html',
})
export class MusicPlayerBarComponent {
  protected readonly player = inject(MusicPlayerService);

  protected readonly badge = computed(() => {
    if (this.player.presentation() === 'PREVIEW') return 'Preview';
    const q = this.player.quality();
    return q === 'LOSSLESS' ? 'Lossless' : q === 'HI_RES_LOSSLESS' ? 'Hi-Res' : q ? 'AAC' : '';
  });

  protected readonly message = computed(() => {
    switch (this.player.error()) {
      case 'session_expired': return 'TIDAL session expired';
      case 'unsupported': return "This browser can't play this audio format";
      case 'network': return 'Network problem - check your connection';
      case 'unavailable': return "Couldn't play this track";
      default: return null;
    }
  });

  protected onSeek(event: Event): void {
    this.player.seek(+(event.target as HTMLInputElement).value);
  }

  protected time(s: number): string {
    return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  }
}
