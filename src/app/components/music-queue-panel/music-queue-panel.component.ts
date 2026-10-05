import { CdkDrag, CdkDragDrop, CdkDragHandle, CdkDropList } from '@angular/cdk/drag-drop';
import { Component, computed, inject, signal } from '@angular/core';
import { MusicPlayerService } from '../../services/music-player.service';
import { MusicUiService } from '../../services/music-ui.service';
import { MusicTrack } from '../../services/music.service';
import { time } from '../../utils/music-format';
import { MusicSidePanelComponent } from '../music-side-panel/music-side-panel.component';

const PAGE = 100;

/** One row of the queue, with its real position in player.queue(). */
interface QueueRow { track: MusicTrack; index: number }

/**
 * The queue drawer/sheet. Visible when ui.panel() === 'queue'.
 * Sections: now playing, next up (play order, so it honours shuffle; drag or
 * Alt+Arrow to reorder), recently played in this session (collapsed).
 */
@Component({
  selector: 'app-music-queue-panel',
  imports: [MusicSidePanelComponent, CdkDropList, CdkDrag, CdkDragHandle],
  templateUrl: './music-queue-panel.component.html',
})
export class MusicQueuePanelComponent {
  protected readonly ui = inject(MusicUiService);
  protected readonly player = inject(MusicPlayerService);
  protected readonly time = time;

  /** How many upcoming rows are rendered (long queues load in pages). */
  protected readonly limit = signal(PAGE);

  protected readonly current = computed<QueueRow | null>(() => {
    const track = this.player.track();
    return track ? { track, index: this.player.index() } : null;
  });

  private readonly allUpcoming = computed<QueueRow[]>(() => {
    const base = this.player.index() + 1;
    return this.player.queue().slice(base).map((track, k) => ({ track, index: base + k }));
  });
  protected readonly upcoming = computed(() => this.allUpcoming().slice(0, this.limit()));
  protected readonly hiddenCount = computed(() => Math.max(0, this.allUpcoming().length - this.limit()));

  /** Most recent first. */
  protected readonly history = computed<QueueRow[]>(() => {
    const q = this.player.queue();
    const out: QueueRow[] = [];
    for (let i = Math.min(this.player.index(), q.length) - 1; i >= 0; i--) out.push({ track: q[i], index: i });
    return out;
  });

  protected readonly contextLabel = computed(() => this.player.context()?.label || 'Queue');

  protected onOpenChange(open: boolean): void {
    if (!open) {
      this.ui.closePanel();
      this.limit.set(PAGE);
    }
  }

  protected drop(e: CdkDragDrop<unknown>): void {
    if (e.previousIndex === e.currentIndex) return;
    const base = this.player.index() + 1;
    this.player.move(base + e.previousIndex, base + e.currentIndex);
  }

  /** Alt+ArrowUp/Down on a row or its handle moves it; focus follows the row. */
  protected onRowKey(e: KeyboardEvent, row: QueueRow): void {
    if (!e.altKey || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return;
    e.preventDefault();
    this.shift(row.index, e.key === 'ArrowDown' ? 1 : -1, e.currentTarget as HTMLElement);
  }

  protected shift(index: number, delta: number, from?: HTMLElement): void {
    const to = index + delta;
    if (to <= this.player.index() || to >= this.player.queue().length) return;
    const list = from?.closest('ol');
    this.player.move(index, to);
    // Rows are tracked by index, so the same element now shows the neighbour: move focus to the moved row.
    setTimeout(() => {
      const rows = list?.querySelectorAll<HTMLElement>('[data-row]');
      rows?.[to - (this.player.index() + 1)]?.querySelector<HTMLElement>('[data-handle]')?.focus();
    });
  }

  protected remove(row: QueueRow, e: Event): void {
    const dialog = (e.currentTarget as HTMLElement).closest<HTMLElement>('[role=dialog]');
    this.player.removeAt(row.index);
    this.restoreFocus(dialog);
  }

  protected playRow(row: QueueRow, e: Event): void {
    const dialog = (e.currentTarget as HTMLElement).closest<HTMLElement>('[role=dialog]');
    this.player.playAt(row.index);
    this.restoreFocus(dialog);
  }

  /**
   * Acting on a row re-renders the list (rows are tracked by position), which can
   * drop focus to <body> where Escape no longer reaches the panel. Put it back
   * on a control inside the dialog.
   */
  private restoreFocus(dialog: HTMLElement | null): void {
    setTimeout(() => {
      if (!dialog?.isConnected || dialog.contains(document.activeElement)) return;
      (dialog.querySelector<HTMLElement>('[data-row] [data-handle]') ?? dialog.querySelector<HTMLElement>('button[aria-label="Close"]'))?.focus();
    });
  }

  protected more(e: MouseEvent, t: MusicTrack): void {
    this.ui.openContextMenu({ kind: 'track', data: t }, e, [t], 'queue');
  }

  protected clear(e: Event): void {
    const dialog = (e.currentTarget as HTMLElement).closest<HTMLElement>('[role=dialog]');
    this.player.clearUpcoming();
    this.restoreFocus(dialog);
  }

  protected saveAsPlaylist(): void {
    this.ui.openAddToPlaylist(this.player.queue());
  }
}
