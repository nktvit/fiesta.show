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

  /** Pictures whose file failed to load; they are dropped from the mosaic instead of showing a broken tile. */
  protected readonly failed = signal<ReadonlySet<string>>(new Set());
  protected readonly list = computed(() => this.images().filter((i) => !this.failed().has(i.url)));
  protected readonly open = signal(false);
  protected readonly index = signal(0);

  /**
   * Fixed-height rows keep every tile bounded. With 5+ pictures the first is a 2x2 feature
   * tile (4 columns from `sm`); trailing tiles that would leave a short last row are hidden
   * from the mosaic (still reachable in the lightbox with next/previous). No tile stretches.
   */
  protected readonly tiles = computed(() => {
    const list = this.list();
    const n = list.length;
    const feature = n >= 5;
    // Visible counts: phones are 2 columns, `sm` and up 4.
    const mobileShown = feature ? 1 + 2 * Math.floor((n - 1) / 2) : n - (n % 2 && n > 1 ? 1 : 0);
    const smShown = feature ? 1 + 4 * Math.floor((n - 1) / 4) : n;
    return list.map((im, i) => {
      const cls: string[] = [];
      if (feature && i === 0) cls.push('col-span-2 row-span-2');
      if (i >= mobileShown && i >= smShown) cls.push('hidden');
      else if (i >= mobileShown) cls.push('hidden sm:block');
      else if (i >= smShown) cls.push('sm:hidden');
      return { image: im, cls: cls.join(' '), label: `Open photo ${i + 1} of ${n}` };
    });
  });
  protected readonly current = computed(() => this.list()[this.index()] ?? null);
  protected readonly credits = computed(() => this.list().filter((i) => i.credit));
  protected readonly sources = computed(() => [...new Set(this.list().map((i) => SOURCE_NAMES[i.source]))].join(', '));

  constructor() {
    // A different artist's gallery never keeps an old lightbox open.
    effect(() => {
      this.images();
      this.failed.set(new Set());
      this.open.set(false);
      this.index.set(0);
    });
  }

  protected drop(url: string): void {
    this.failed.update((s) => new Set(s).add(url));
  }

  protected show(i: number): void {
    this.index.set(i);
    this.open.set(true);
  }

  protected step(d: number): void {
    const n = this.list().length;
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
