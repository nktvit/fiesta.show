import { Component, ElementRef, computed, inject, input, output, signal, DestroyRef } from '@angular/core';
import { time } from '../../utils/music-format';
import { MusicWaveformComponent } from '../music-waveform/music-waveform.component';

/**
 * Native range seek bar with a hover-time tooltip. While the pointer is down
 * the thumb follows the pointer but nothing seeks; the seek is committed on
 * pointerup. Keyboard (and programmatic input events) seek immediately, in
 * 5 s steps for the arrow keys.
 */
@Component({
  selector: 'app-music-seek-bar',
  imports: [MusicWaveformComponent],
  templateUrl: './music-seek-bar.component.html',
  host: { class: 'block min-w-0 flex-1' },
})
export class MusicSeekBarComponent {
  readonly position = input(0);
  readonly duration = input(0);
  readonly trackId = input<number | null>(null);
  readonly showWaveform = input(false);
  /** Committed seek target in seconds. */
  readonly seekTo = output<number>();

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  protected readonly dragging = signal(false);
  protected readonly dragValue = signal(0);
  protected readonly hover = signal<{ x: number; t: number } | null>(null);

  protected readonly shown = computed(() => (this.dragging() ? this.dragValue() : this.position()));
  protected readonly progress = computed(() => (this.duration() > 0 ? Math.min(1, Math.max(0, this.shown() / this.duration())) : 0));
  protected readonly tooltip = computed(() => {
    const h = this.hover();
    return h ? { left: h.x, text: time(h.t) } : null;
  });
  protected readonly time = time;

  private readonly stopListening: (() => void)[] = [];

  constructor() {
    inject(DestroyRef).onDestroy(() => this.unlisten());
  }

  protected onPointerDown(e: PointerEvent): void {
    if (e.button !== undefined && e.button > 0) return;
    this.dragging.set(true);
    this.dragValue.set(this.position());
    this.unlisten();
    const end = (): void => {
      if (!this.dragging()) return;
      const v = this.dragValue();
      this.dragging.set(false);
      this.unlisten();
      this.seekTo.emit(v);
    };
    const cancel = (): void => {
      this.dragging.set(false);
      this.unlisten();
    };
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', cancel);
    this.stopListening.push(() => window.removeEventListener('pointerup', end), () => window.removeEventListener('pointercancel', cancel));
  }

  protected onInput(e: Event): void {
    const v = +(e.target as HTMLInputElement).value;
    if (this.dragging()) this.dragValue.set(v);
    else this.seekTo.emit(v);
  }

  protected onKeydown(e: KeyboardEvent): void {
    const dir = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : 0;
    if (!dir || e.altKey || e.ctrlKey || e.metaKey) return;
    e.preventDefault();
    const max = this.duration() || 0;
    this.seekTo.emit(Math.min(max, Math.max(0, this.position() + dir * 5)));
  }

  protected onMove(e: PointerEvent): void {
    const dur = this.duration();
    const box = this.host.nativeElement.querySelector('[data-seek-track]')?.getBoundingClientRect();
    if (!dur || !box || !box.width) return;
    const x = Math.min(box.width, Math.max(0, e.clientX - box.left));
    this.hover.set({ x, t: (x / box.width) * dur });
  }

  protected onLeave(): void {
    this.hover.set(null);
  }

  private unlisten(): void {
    for (const f of this.stopListening.splice(0)) f();
  }
}
