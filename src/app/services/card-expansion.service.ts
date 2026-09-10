import { Injectable, signal } from '@angular/core';

export interface ExpandableCollection {
  close(): void;
}

/**
 * Keeps card expansion exclusive across the whole page.
 *
 * Each collection owns its own selection, so without a coordinator a page with
 * several shelves could hold several panels open at once. This also drives the
 * page-wide tint: every collection dims its cards while *any* collection has a
 * panel open, so the chosen card is the only bright thing on screen.
 *
 * The signal is read once per collection (a handful of components), not once
 * per card — the per-card tint is pure CSS.
 */
@Injectable({ providedIn: 'root' })
export class CardExpansionService {
  private active: ExpandableCollection | null = null;

  /** True while any collection on the page has a panel open. */
  readonly anyOpen = signal(false);

  activate(owner: ExpandableCollection) {
    if (this.active && this.active !== owner) this.active.close();
    this.active = owner;
    this.anyOpen.set(true);
  }

  deactivate(owner: ExpandableCollection) {
    if (this.active !== owner) return;
    this.active = null;
    this.anyOpen.set(false);
  }
}
