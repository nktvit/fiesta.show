import { A11yModule } from '@angular/cdk/a11y';
import { Component, DestroyRef, effect, inject, input, model } from '@angular/core';
import { MusicSettingsService } from '../../services/music-settings.service';
import { musicScrollLock } from '../../utils/music-scroll-lock';

let nextId = 0;

/**
 * Centered modal shell (z-[60]) with the same accessibility as the side panel:
 * role=dialog, aria-modal, focus trap, Escape and backdrop close, focus back
 * to the opener, page scroll locked, safe-area padding.
 *
 *   <app-music-dialog title="Add to playlist" [(open)]="isOpen" size="md">
 *     ...content...
 *     <div dialogFooter>...buttons...</div>   (optional)
 *   </app-music-dialog>
 */
@Component({
  selector: 'app-music-dialog',
  imports: [A11yModule],
  templateUrl: './music-dialog.component.html',
})
export class MusicDialogComponent {
  readonly title = input.required<string>();
  readonly open = model(false);
  readonly size = input<'sm' | 'md' | 'lg'>('md');

  protected readonly settings = inject(MusicSettingsService);
  protected readonly titleId = `music-dialog-title-${++nextId}`;
  private release: (() => void) | null = null;

  constructor() {
    effect(() => {
      if (this.open()) this.release ??= musicScrollLock.lock();
      else this.unlock();
    });
    inject(DestroyRef).onDestroy(() => this.unlock());
  }

  close(): void {
    this.open.set(false);
  }

  protected onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.stopPropagation();
      this.close();
    }
  }

  protected widthClass(): string {
    return this.size() === 'sm' ? 'max-w-sm' : this.size() === 'lg' ? 'max-w-2xl' : 'max-w-md';
  }

  private unlock(): void {
    this.release?.();
    this.release = null;
  }
}
