import { Component, computed, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { MusicPlayerService } from '../../services/music-player.service';
import { MusicToastService } from '../../services/music-toast.service';
import { MusicArtist, MusicLibraryItem, MusicService } from '../../services/music.service';
import { MusicCardMenuButtonComponent } from '../music-card-menu-button/music-card-menu-button.component';

/** Artist grid/rail card: round picture and name; a hover Play (top tracks) button and the card menu. */
@Component({
  selector: 'app-music-artist-card',
  imports: [RouterLink, MusicCardMenuButtonComponent],
  templateUrl: './music-artist-card.component.html',
  host: { class: 'block' },
})
export class MusicArtistCardComponent {
  readonly artist = input.required<MusicArtist>();

  private music = inject(MusicService);
  private player = inject(MusicPlayerService);
  private toast = inject(MusicToastService);

  protected readonly busy = signal(false);
  protected readonly item = computed<MusicLibraryItem>(() => ({ kind: 'artist', data: this.artist() }));

  protected async play(): Promise<void> {
    const a = this.artist();
    this.busy.set(true);
    try {
      const { topTracks } = await firstValueFrom(this.music.artist(a.id));
      if (!topTracks.length) throw new Error('empty');
      await this.player.play(topTracks[0], topTracks, { context: { type: 'artist', id: a.id, label: a.name } });
    } catch {
      this.toast.show({ message: `Couldn't play ${a.name}`, tone: 'warn' });
    } finally {
      this.busy.set(false);
    }
  }
}
