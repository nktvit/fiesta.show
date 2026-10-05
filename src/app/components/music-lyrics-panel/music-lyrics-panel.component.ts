import { Component, inject } from '@angular/core';
import { MusicUiService } from '../../services/music-ui.service';
import { MusicLyricsViewComponent } from '../music-lyrics-view/music-lyrics-view.component';
import { MusicSidePanelComponent } from '../music-side-panel/music-side-panel.component';

/** The lyrics drawer/sheet. Visible when ui.panel() === 'lyrics'. Owned by package P3 (F0 stub). */
@Component({
  selector: 'app-music-lyrics-panel',
  imports: [MusicSidePanelComponent, MusicLyricsViewComponent],
  templateUrl: './music-lyrics-panel.component.html',
})
export class MusicLyricsPanelComponent {
  protected readonly ui = inject(MusicUiService);
}
