import { Component, computed, inject, input, signal } from '@angular/core';
import { MusicLibraryService } from '../../services/music-library.service';
import { MusicToastService } from '../../services/music-toast.service';
import { MusicLibraryItem } from '../../services/music.service';

/** Heart toggle for any likeable item (track, album, artist, playlist, mix). */
@Component({
  selector: 'app-music-like-button',
  templateUrl: './music-like-button.component.html',
  host: { class: 'inline-flex' },
})
export class MusicLikeButtonComponent {
  readonly item = input.required<MusicLibraryItem>();
  readonly size = input<'sm' | 'md'>('md');
  /** Show the "Added to Liked" toast with Undo. */
  readonly notify = input(true);

  protected readonly library = inject(MusicLibraryService);
  private toast = inject(MusicToastService);

  protected readonly liked = computed(() => this.library.isFavorite(this.item()));
  protected readonly pop = signal(false);
  protected readonly name = computed(() => {
    const it = this.item();
    return it.kind === 'artist' || it.kind === 'userPlaylist' ? it.data.name : it.data.title;
  });

  protected toggle(e: Event): void {
    e.stopPropagation();
    const it = this.item();
    const nowLiked = this.library.toggleFavorite(it);
    this.pop.set(true);
    setTimeout(() => this.pop.set(false), 180);
    if (this.notify()) {
      this.toast.show({
        message: nowLiked ? 'Added to Liked' : 'Removed from Liked',
        action: { label: 'Undo', run: () => this.library.toggleFavorite(it) },
      });
    }
  }
}
