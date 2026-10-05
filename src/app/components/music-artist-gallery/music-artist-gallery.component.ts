import { Component, computed, effect, input, signal } from '@angular/core';
import { MusicArtistImage } from '../../services/music-catalog.service';
import { MusicDialogComponent } from '../music-dialog/music-dialog.component';

const SOURCE_NAMES: Record<MusicArtistImage['source'], string> = {
  tidal: 'TIDAL', deezer: 'Deezer', wikimedia: 'Wikimedia Commons', fanart: 'fanart.tv',
};

/**
 * Wrapping photo mosaic of the artist (never a horizontal scroller). A tap opens a
 * lightbox in the music dialog shell with previous/next, the credit and licence for
 * Wikimedia Commons photos.
 */
@Component({
  selector: 'app-music-artist-gallery',
  imports: [MusicDialogComponent],
  templateUrl: './music-artist-gallery.component.html',
  host: { class: 'block', '(document:keydown)': 'onKey($event)' },
})
export class MusicArtistGalleryComponent {
  readonly images = input<MusicArtistImage[]>([]);
  readonly name = input('');

  protected readonly open = signal(false);
  protected readonly index = signal(0);

  protected readonly tiles = computed(() => {
    const list = this.images();
    const n = list.length;
    const rest = n - 1;
    // With 5+ pictures the first one is a 2x2 feature tile on the 4-column layout; a short
    // last row is filled by stretching the final tile. Two columns on phones, same idea.
    const lastSm = n >= 5 ? ((rest - 4) % 4 === 0 ? '' : (rest - 4) % 4 === 1 ? 'sm:col-span-4' : (rest - 4) % 4 === 2 ? 'sm:col-span-3' : 'sm:col-span-2') : '';
    return list.map((im, i) => {
      let cls = '';
      if (i === 0) cls = n >= 5 ? 'col-span-2 row-span-2' : n >= 3 ? 'col-span-2 sm:col-span-1' : '';
      else if (i === n - 1) cls = `${rest % 2 === 1 ? 'col-span-2' : ''} ${lastSm || (rest % 2 === 1 ? 'sm:col-span-1' : '')}`.trim();
      return { image: im, cls, label: `Open photo ${i + 1} of ${n}` };
    });
  });
  protected readonly current = computed(() => this.images()[this.index()] ?? null);
  protected readonly credits = computed(() => this.images().filter((i) => i.credit));
  protected readonly sources = computed(() => [...new Set(this.images().map((i) => SOURCE_NAMES[i.source]))].join(', '));

  constructor() {
    // A different artist's gallery never keeps an old lightbox open.
    effect(() => {
      this.images();
      this.open.set(false);
      this.index.set(0);
    });
  }

  protected show(i: number): void {
    this.index.set(i);
    this.open.set(true);
  }

  protected step(d: number): void {
    const n = this.images().length;
    if (n) this.index.update((i) => (i + d + n) % n);
  }

  protected onKey(e: KeyboardEvent): void {
    if (!this.open()) return;
    if (e.key === 'ArrowRight') { this.step(1); e.preventDefault(); }
    else if (e.key === 'ArrowLeft') { this.step(-1); e.preventDefault(); }
  }

  protected sourceName(i: MusicArtistImage): string {
    return SOURCE_NAMES[i.source];
  }
}
