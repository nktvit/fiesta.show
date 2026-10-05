import { Component, computed, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { MusicPlayerService } from '../../services/music-player.service';
import { MusicToastService } from '../../services/music-toast.service';
import { MusicAlbum, MusicLibraryItem, MusicService } from '../../services/music.service';
import { MusicCardMenuButtonComponent } from '../music-card-menu-button/music-card-menu-button.component';

/** Album grid/rail card: cover, title, artist · year; a hover Play button and the card menu. */
@Component({
  selector: 'app-music-album-card',
  imports: [RouterLink, MusicCardMenuButtonComponent],
  templateUrl: './music-album-card.component.html',
  host: { class: 'block' },
})
export class MusicAlbumCardComponent {
  readonly album = input.required<MusicAlbum>();
  /** Replaces "artist · year" under the title. */
  readonly subtitle = input<string | null>(null);

  private music = inject(MusicService);
  private player = inject(MusicPlayerService);
  private toast = inject(MusicToastService);

  protected readonly busy = signal(false);
  protected readonly item = computed<MusicLibraryItem>(() => ({ kind: 'album', data: this.album() }));
  protected readonly line = computed(() => {
    const a = this.album();
    return this.subtitle() ?? (a.year ? `${a.artist} · ${a.year}` : a.artist);
  });

  protected async play(): Promise<void> {
    const a = this.album();
    this.busy.set(true);
    try {
      const { tracks } = await firstValueFrom(this.music.album(a.id));
      if (!tracks.length) throw new Error('empty');
      await this.player.play(tracks[0], tracks, { context: { type: 'album', id: a.id, label: a.title } });
    } catch {
      this.toast.show({ message: `Couldn't play ${a.title}`, tone: 'warn' });
    } finally {
      this.busy.set(false);
    }
  }
}
