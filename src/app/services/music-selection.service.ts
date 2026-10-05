import { computed, inject, Injectable, signal } from '@angular/core';
import { NavigationEnd, Router } from '@angular/router';
import { filter } from 'rxjs';
import { MusicTrack } from './music.service';

/**
 * Multi-select state shared by every track row and the selection bar.
 * Insertion order is the order tracks were selected in.
 */
@Injectable({ providedIn: 'root' })
export class MusicSelectionService {
  private router = inject(Router);
  private readonly _items = signal<ReadonlyMap<number, MusicTrack>>(new Map());
  private anchorId: number | null = null;
  private lastPath = '';

  /** The selected tracks, in selection order. */
  readonly tracks = computed(() => [...this._items().values()]);
  readonly count = computed(() => this._items().size);
  /** True while anything is selected: rows then show their checkboxes. */
  readonly active = computed(() => this._items().size > 0);

  constructor() {
    this.lastPath = this.path(this.router.url);
    this.router.events.pipe(filter((e): e is NavigationEnd => e instanceof NavigationEnd)).subscribe((e) => {
      const path = this.path(e.urlAfterRedirects);
      // A different page is a different list; same-page query changes keep the selection.
      if (path !== this.lastPath) this.clear();
      this.lastPath = path;
    });
  }

  isSelected(track: MusicTrack): boolean {
    return this._items().has(track.id);
  }

  /** Adds or removes one track and makes it the range anchor. Returns the new state. */
  toggle(track: MusicTrack): boolean {
    const next = new Map(this._items());
    const on = !next.has(track.id);
    if (on) next.set(track.id, track);
    else next.delete(track.id);
    this._items.set(next);
    this.anchorId = on ? track.id : this.anchorId === track.id ? null : this.anchorId;
    return on;
  }

  /** Selects exactly this track (used to start select mode). */
  select(track: MusicTrack): void {
    if (this.isSelected(track)) return;
    this.toggle(track);
  }

  /**
   * Shift-click: selects everything between the anchor and `track` within
   * `list` (the list the clicked row belongs to). Without an anchor in that
   * list it behaves like a plain toggle.
   */
  selectRange(track: MusicTrack, list: readonly MusicTrack[]): void {
    const a = this.anchorId === null ? -1 : list.findIndex((t) => t.id === this.anchorId);
    const b = list.findIndex((t) => t.id === track.id);
    if (a < 0 || b < 0) {
      this.toggle(track);
      return;
    }
    const [from, to] = a <= b ? [a, b] : [b, a];
    const next = new Map(this._items());
    for (const t of list.slice(from, to + 1)) next.set(t.id, t);
    this._items.set(next);
    // The anchor stays put so repeated shift-clicks pivot around it.
  }

  clear(): void {
    if (!this._items().size && this.anchorId === null) return;
    this._items.set(new Map());
    this.anchorId = null;
  }

  private path(url: string): string {
    return url.split(/[?#]/)[0];
  }
}
