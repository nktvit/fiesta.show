import { Component, computed, inject } from '@angular/core';
import { MusicLibraryService, MUSIC_PIN_LIMIT, musicItemKey } from '../../services/music-library.service';
import { MusicToastService } from '../../services/music-toast.service';
import { MusicLibraryItem } from '../../services/music.service';
import { MusicAlbumCardComponent } from '../music-album-card/music-album-card.component';
import { MusicArtistCardComponent } from '../music-artist-card/music-artist-card.component';
import { MusicPlaylistCardComponent } from '../music-playlist-card/music-playlist-card.component';

export function musicItemName(it: MusicLibraryItem): string {
  return it.kind === 'artist' || it.kind === 'userPlaylist' ? it.data.name : it.data.title;
}

/**
 * Pins or unpins an item (max 3). When the row is full it shows a toast
 * instead. Returns whether the item is pinned afterwards.
 */
export function togglePinWithToast(library: MusicLibraryService, toast: MusicToastService, it: MusicLibraryItem): boolean {
  if (library.isPinned(it)) {
    library.togglePin(it);
    toast.show({ message: `Unpinned ${musicItemName(it)}`, action: { label: 'Undo', run: () => void library.togglePin(it) } });
    return false;
  }
  if (library.pins().length >= MUSIC_PIN_LIMIT) {
    toast.show({ message: `You can pin up to ${MUSIC_PIN_LIMIT} items. Unpin one first.`, tone: 'warn' });
    return false;
  }
  library.togglePin(it);
  toast.show({ message: `Pinned ${musicItemName(it)}` });
  return true;
}

/** library.pins() (max 3) as one row of cards with an Unpin button; renders nothing when empty. */
@Component({
  selector: 'app-music-pins-row',
  imports: [MusicAlbumCardComponent, MusicArtistCardComponent, MusicPlaylistCardComponent],
  templateUrl: './music-pins-row.component.html',
})
export class MusicPinsRowComponent {
  protected readonly library = inject(MusicLibraryService);
  private toast = inject(MusicToastService);

  /** Pins with live user playlists (pins store them without tracks); blocked or deleted ones are dropped. */
  protected readonly pins = computed<{ key: string; item: MusicLibraryItem }[]>(() => {
    const out: { key: string; item: MusicLibraryItem }[] = [];
    for (const p of this.library.pins()) {
      if (this.library.isBlocked(p)) continue;
      let item = p;
      if (p.kind === 'userPlaylist') {
        const live = this.library.playlists().find((x) => x.id === p.data.id);
        if (!live) continue;
        item = { kind: 'userPlaylist', data: live };
      }
      out.push({ key: musicItemKey(p), item });
    }
    return out;
  });

  protected name = musicItemName;

  protected unpin(it: MusicLibraryItem): void {
    togglePinWithToast(this.library, this.toast, it);
  }
}
