import { Component, computed, inject } from '@angular/core';
import { Router } from '@angular/router';
import {
  formatBindingParts, isMacPlatform, MUSIC_SHORTCUT_GROUPS, MusicShortcutsService,
} from '../../services/music-shortcuts.service';
import { MusicUiService } from '../../services/music-ui.service';
import { MusicDialogComponent } from '../music-dialog/music-dialog.component';

/** Keyboard shortcuts help (?). Visible when ui.shortcutsHelpOpen(). Reads the live (possibly rebound) keys. */
@Component({
  selector: 'app-music-shortcuts-help',
  imports: [MusicDialogComponent],
  templateUrl: './music-shortcuts-help.component.html',
})
export class MusicShortcutsHelpComponent {
  protected readonly ui = inject(MusicUiService);
  private shortcuts = inject(MusicShortcutsService);
  private router = inject(Router);
  private readonly mac = isMacPlatform();

  protected readonly groups = computed(() =>
    MUSIC_SHORTCUT_GROUPS.map((g) => ({
      name: g,
      rows: this.shortcuts.defs
        .filter((d) => d.group === g)
        .map((d) => ({ id: d.id, label: d.label, keys: formatBindingParts(this.shortcuts.binding(d.id), this.mac) })),
    })).filter((g) => g.rows.length),
  );

  protected customize(): void {
    this.ui.closeShortcutsHelp();
    // Wait for the Back-button history entry of the dialog to unwind before navigating.
    setTimeout(() => void this.router.navigate(['/music/settings'], { queryParams: { tab: 'shortcuts' } }), 100);
  }
}
