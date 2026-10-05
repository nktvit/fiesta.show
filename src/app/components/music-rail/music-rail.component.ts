import { Component, ElementRef, input, viewChild } from '@angular/core';
import { RouterLink } from '@angular/router';

/**
 * A titled, horizontally scrolling row of cards (snap scrolling; prev/next
 * buttons on desktop). Project the cards; each child becomes a fixed-width slot.
 *
 *   <app-music-rail title="More by Daft Punk" [link]="['/music/artist', id]">
 *     @for (a of albums; track a.id) { <app-music-album-card [album]="a" /> }
 *   </app-music-rail>
 */
@Component({
  selector: 'app-music-rail',
  imports: [RouterLink],
  templateUrl: './music-rail.component.html',
  host: { class: 'block' },
})
export class MusicRailComponent {
  readonly title = input.required<string>();
  /** "See all" target; omit for none. */
  readonly link = input<string | unknown[] | null>(null);
  readonly linkLabel = input('See all');

  private readonly scroller = viewChild.required<ElementRef<HTMLElement>>('scroller');

  protected scroll(dir: -1 | 1): void {
    const el = this.scroller().nativeElement;
    const reduce = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollBy({ left: dir * el.clientWidth * 0.8, behavior: reduce ? 'auto' : 'smooth' });
  }

  protected linkCommands(): string | unknown[] {
    return this.link() ?? [];
  }
}
