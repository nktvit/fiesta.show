import { A11yModule } from '@angular/cdk/a11y';
import { Component, computed, DestroyRef, effect, inject, input, model, signal } from '@angular/core';
import { MusicSettingsService } from '../../services/music-settings.service';
import { musicScrollLock } from '../../utils/music-scroll-lock';

const MIN_WIDTH = 320;
const MAX_WIDTH = 640;
let nextId = 0;

function measureBar(): number {
  if (typeof document === 'undefined') return 0;
  const bar = document.querySelector('app-music-player-bar section');
  return bar ? Math.round(bar.getBoundingClientRect().height) : 0;
}

/**
 * Shared shell for the queue and lyrics panels: a resizable right drawer on
 * desktop (width persisted in settings.panelWidth), a bottom sheet on phones
 * (drag the handle down to close). Modal: focus trap, Escape closes, focus
 * returns to the opener, page scroll locked, safe-area padding.
 *
 *   <app-music-side-panel title="Queue" [(open)]="isOpen">
 *     <button panelActions ...>Clear</button>   (optional, next to the title)
 *     ...content...
 *   </app-music-side-panel>
 */
@Component({
  selector: 'app-music-side-panel',
  imports: [A11yModule],
  templateUrl: './music-side-panel.component.html',
})
export class MusicSidePanelComponent {
  readonly title = input.required<string>();
  readonly open = model(false);
  readonly side = input<'right'>('right');

  protected readonly settings = inject(MusicSettingsService);
  protected readonly titleId = `music-panel-title-${++nextId}`;
  protected readonly isDesktop = signal(typeof window !== 'undefined' && window.matchMedia('(min-width: 640px)').matches);
  /** Live width while dragging; settings.panelWidth otherwise. */
  private readonly dragWidth = signal<number | null>(null);
  protected readonly width = computed(() => this.dragWidth() ?? this.settings.panelWidth());
  protected readonly dragY = signal(0);
  protected readonly minWidth = MIN_WIDTH;
  protected readonly maxWidth = MAX_WIDTH;
  /** Desktop: height of the fixed mini player, so the drawer ends above it and the bar stays usable. */
  protected readonly barInset = signal(0);

  private release: (() => void) | null = null;

  constructor() {
    effect(() => {
      if (this.open()) {
        this.release ??= musicScrollLock.lock();
        this.barInset.set(measureBar());
      } else this.unlock();
    });
    if (typeof window !== 'undefined') {
      const mq = window.matchMedia('(min-width: 640px)');
      const onChange = () => {
        this.isDesktop.set(mq.matches);
        if (this.open()) this.barInset.set(measureBar());
      };
      mq.addEventListener('change', onChange);
      inject(DestroyRef).onDestroy(() => mq.removeEventListener('change', onChange));
    }
    inject(DestroyRef).onDestroy(() => this.unlock());
  }

  close(): void {
    this.dragY.set(0);
    this.open.set(false);
  }

  protected onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.stopPropagation();
      this.close();
    }
  }

  // Desktop: drag the left edge to resize.
  protected startResize(e: PointerEvent): void {
    const handle = e.currentTarget as HTMLElement;
    handle.setPointerCapture?.(e.pointerId);
    const startX = e.clientX;
    const startW = this.width();
    const move = (ev: PointerEvent) => this.dragWidth.set(this.clamp(startW + (startX - ev.clientX)));
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      const w = this.dragWidth();
      if (w !== null) this.settings.panelWidth.set(w);
      this.dragWidth.set(null);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
    e.preventDefault();
  }

  protected resizeKey(e: KeyboardEvent): void {
    const step = e.shiftKey ? 64 : 16;
    if (e.key === 'ArrowLeft') this.settings.panelWidth.set(this.clamp(this.width() + step));
    else if (e.key === 'ArrowRight') this.settings.panelWidth.set(this.clamp(this.width() - step));
    else return;
    e.preventDefault();
  }

  // Phone: drag the sheet handle down to dismiss.
  protected startDrag(e: PointerEvent): void {
    const handle = e.currentTarget as HTMLElement;
    handle.setPointerCapture?.(e.pointerId);
    const startY = e.clientY;
    const move = (ev: PointerEvent) => this.dragY.set(Math.max(0, ev.clientY - startY));
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      if (this.dragY() > 120) this.close();
      else this.dragY.set(0);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  }

  private clamp(w: number): number {
    return Math.round(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, w)));
  }

  private unlock(): void {
    this.release?.();
    this.release = null;
  }
}
