import { Component, inject } from '@angular/core';
import { MusicDownloadService } from '../../services/music-download.service';
import { MusicLibraryService } from '../../services/music-library.service';
import { MusicPlayerService } from '../../services/music-player.service';
import { MusicSelectionService } from '../../services/music-selection.service';
import { MusicSettingsService } from '../../services/music-settings.service';
import { MusicToastService } from '../../services/music-toast.service';
import { MusicUiService } from '../../services/music-ui.service';

/** Multi-select action bar (global host): appears while any track is selected. */
@Component({
  selector: 'app-music-selection-bar',
  templateUrl: './music-selection-bar.component.html',
})
export class MusicSelectionBarComponent {
  protected readonly selection = inject(MusicSelectionService);
  protected readonly player = inject(MusicPlayerService);
  protected readonly settings = inject(MusicSettingsService);
  protected readonly downloads = inject(MusicDownloadService);
  private library = inject(MusicLibraryService);
  private toast = inject(MusicToastService);
  private ui = inject(MusicUiService);

  protected play(): void {
    const tracks = this.selection.tracks();
    if (!tracks.length) return;
    void this.player.play(tracks[0], tracks, { context: { type: 'queue', label: 'Selection' } });
    this.selection.clear();
  }

  protected playNext(): void {
    const tracks = this.selection.tracks();
    this.player.playNext(tracks);
    this.toast.show({ message: `${tracks.length} ${tracks.length === 1 ? 'track' : 'tracks'} will play next` });
    this.selection.clear();
  }

  protected addToQueue(): void {
    const tracks = this.selection.tracks();
    this.player.addToQueue(tracks);
    this.toast.show({ message: `Added ${tracks.length} ${tracks.length === 1 ? 'track' : 'tracks'} to queue` });
    this.selection.clear();
  }

  protected like(): void {
    const n = this.library.addFavorites(this.selection.tracks().map((data) => ({ kind: 'track' as const, data })));
    this.toast.show({ message: n ? `Liked ${n} ${n === 1 ? 'track' : 'tracks'}` : 'Already liked' });
    this.selection.clear();
  }

  protected addToPlaylist(): void {
    this.ui.openAddToPlaylist(this.selection.tracks());
  }

  protected download(): void {
    void this.downloads.downloadTracks(this.selection.tracks(), { name: 'Selection', kind: 'selection' });
    this.selection.clear();
  }
}
