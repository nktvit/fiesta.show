import { Component, computed, inject, input } from '@angular/core';
import { musicItemKey } from '../../services/music-library.service';
import { MusicUiService } from '../../services/music-ui.service';
import { MusicLibraryItem } from '../../services/music.service';

/**
 * Kebab button on cards that opens the card context menu via
 * ui.openContextMenu(...). Sits in the card's top-right corner; on hover
 * devices it fades in with the card (always reachable by keyboard focus).
 */
@Component({
  selector: 'app-music-card-menu-button',
  templateUrl: './music-card-menu-button.component.html',
  host: { class: 'inline-flex' },
})
export class MusicCardMenuButtonComponent {
  readonly item = input.required<MusicLibraryItem>();
  protected readonly ui = inject(MusicUiService);

  protected readonly name = computed(() => {
    const it = this.item();
    return it.kind === 'artist' || it.kind === 'userPlaylist' ? it.data.name : it.data.title;
  });

  protected readonly open = computed(() => {
    const m = this.ui.contextMenu();
    return !!m && m.source === 'card' && musicItemKey(m.item) === musicItemKey(this.item());
  });

  protected openMenu(e: MouseEvent): void {
    e.preventDefault();
    e.stopPropagation();
    this.ui.openContextMenu(this.item(), e, undefined, 'card');
  }
}
