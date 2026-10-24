import { Component, computed, input } from '@angular/core';

/**
 * A thin strip along the bottom of a seek bar: the parts of the track that are already
 * loaded, plus a sliding marker while the player is waiting for data (a seek outside the
 * buffer, a stall). The parent must be `position: relative`.
 */
@Component({
  selector: 'app-music-buffer-strip',
  template: `
    <div class="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 overflow-hidden rounded-full bg-white/10" aria-hidden="true" data-buffer-strip>
      @for (r of segments(); track r.left) {
        <span class="absolute inset-y-0 bg-white/40" [style.left.%]="r.left" [style.width.%]="r.width"></span>
      }
      @if (busy()) {
        <span class="busy absolute inset-y-0 w-1/4 bg-indigo-400"></span>
      }
    </div>
  `,
  styles: `
    .busy { animation: buffer-slide 1.1s ease-in-out infinite; }
    @keyframes buffer-slide { from { left: -25%; } to { left: 100%; } }
    @media (prefers-reduced-motion: reduce) { .busy { animation: none; left: 0; width: 100%; opacity: 0.6; } }
  `,
})
export class MusicBufferStripComponent {
  readonly ranges = input<readonly (readonly [number, number])[]>([]);
  readonly duration = input(0);
  readonly busy = input(false);

  protected readonly segments = computed(() => {
    const d = this.duration();
    if (!(d > 0)) return [];
    return this.ranges().map(([s, e]) => ({ left: Math.max(0, (s / d) * 100), width: Math.max(0.3, ((Math.min(e, d) - s) / d) * 100) }));
  });
}
