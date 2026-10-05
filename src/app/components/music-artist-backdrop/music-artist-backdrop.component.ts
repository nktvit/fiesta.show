import { Component, computed, DestroyRef, effect, inject, input, signal } from '@angular/core';

const ROTATE_MS = 9000;

/**
 * Blurred, slightly saturated photo backdrop behind the artist hero. Up to three
 * pictures cross-fade (and drift slowly); the first loads at high priority, the
 * others are only requested when it is their turn. Under prefers-reduced-motion
 * it stays on the first picture with no animation. Decorative: aria-hidden.
 */
@Component({
  selector: 'app-music-artist-backdrop',
  templateUrl: './music-artist-backdrop.component.html',
  host: { class: 'pointer-events-none absolute inset-x-0 top-0 -z-10 block h-[26rem] overflow-hidden md:h-[30rem]', 'aria-hidden': 'true' },
})
export class MusicArtistBackdropComponent {
  readonly urls = input<string[]>([]);

  protected readonly list = computed(() => this.urls().slice(0, 3));
  /** Changes only for a different artist, not when more pictures join the rotation. */
  private readonly first = computed(() => this.urls()[0] ?? '');
  protected readonly active = signal(0);
  /** Layers that exist in the DOM (the next one is added just before it fades in). */
  protected readonly rendered = signal(1);
  protected readonly loaded = signal<ReadonlySet<number>>(new Set());
  private pending = -1;

  constructor() {
    // A new artist starts again from the first picture.
    effect(() => {
      this.first();
      this.active.set(0);
      this.rendered.set(1);
      this.loaded.set(new Set());
      this.pending = -1;
    });
    const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (typeof window === 'undefined' || reduce) return;
    const id = window.setInterval(() => this.tick(), ROTATE_MS);
    inject(DestroyRef).onDestroy(() => window.clearInterval(id));
  }

  private tick(): void {
    const n = this.list().length;
    if (n < 2 || document.hidden) return;
    const next = (this.active() + 1) % n;
    if (this.loaded().has(next)) {
      this.active.set(next);
    } else {
      this.pending = next;
      this.rendered.update((r) => Math.max(r, next + 1));
    }
  }

  protected onLoad(i: number): void {
    this.loaded.update((s) => new Set(s).add(i));
    if (this.pending === i) {
      this.pending = -1;
      this.active.set(i);
    }
  }

  protected layers(): number[] {
    return Array.from({ length: Math.min(this.rendered(), this.list().length) }, (_, i) => i);
  }
}
