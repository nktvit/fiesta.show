import { Component, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MusicLibraryService } from '../../services/music-library.service';
import { MusicToastService } from '../../services/music-toast.service';
import { MusicUiService } from '../../services/music-ui.service';
import { filterByName } from '../../utils/music-library-sort';
import { MusicDialogComponent } from '../music-dialog/music-dialog.component';

/** "Add to playlist" for the tracks in ui.addToPlaylist(): pick a playlist or make a new one inline. */
@Component({
  selector: 'app-music-add-to-playlist-dialog',
  imports: [MusicDialogComponent, FormsModule],
  templateUrl: './music-add-to-playlist-dialog.component.html',
})
export class MusicAddToPlaylistDialogComponent {
  protected readonly ui = inject(MusicUiService);
  protected readonly library = inject(MusicLibraryService);
  private toast = inject(MusicToastService);

  protected readonly filter = signal('');
  protected readonly creating = signal(false);
  protected newName = '';

  protected readonly count = computed(() => this.ui.addToPlaylist()?.length ?? 0);
  protected readonly visible = computed(() => filterByName(this.library.playlists(), this.filter(), (p) => p.name));

  constructor() {
    // A fresh dialog each time it opens.
    effect(() => {
      if (this.ui.addToPlaylist() !== null) {
        this.filter.set('');
        this.creating.set(false);
        this.newName = '';
      }
    });
  }

  protected add(id: string, name: string): void {
    const tracks = this.ui.addToPlaylist() ?? [];
    const n = this.library.addToPlaylist(id, tracks);
    this.toast.show({ message: n ? `Added ${n} ${n === 1 ? 'track' : 'tracks'} to ${name}` : `Already in ${name}` });
    this.ui.closeAddToPlaylist();
  }

  protected create(): void {
    const name = this.newName.trim();
    if (!name) return;
    const tracks = this.ui.addToPlaylist() ?? [];
    const p = this.library.createPlaylist(name, tracks);
    const n = p.tracks.length;
    this.toast.show({ message: `Added ${n} ${n === 1 ? 'track' : 'tracks'} to ${p.name}` });
    this.ui.closeAddToPlaylist();
  }
}
