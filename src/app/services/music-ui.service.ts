import { DestroyRef, inject, Injectable, signal } from '@angular/core';
import { NavigationEnd, Router } from '@angular/router';
import { filter } from 'rxjs';
import { MusicSettingsService } from './music-settings.service';
import { MusicLibraryItem, MusicTrack } from './music.service';

export type MusicPanel = 'queue' | 'lyrics';

export type MusicOverlay =
  | 'nowPlaying' | 'panel' | 'palette' | 'shortcutsHelp' | 'sleepTimer' | 'import' | 'addToPlaylist' | 'trackInfo'
  | 'contextMenu';

export interface MusicContextMenuState {
  item: MusicLibraryItem;
  /** The tracks the action applies to (a card's album tracks, a selection). */
  tracks?: MusicTrack[];
  /** Viewport coordinates to anchor the menu at. */
  x: number;
  y: number;
  /** Where it was opened from ('row', 'card', 'queue', 'nowPlaying', ...). */
  source?: string;
}

/** Overlays that a Back press closes (menus don't add history entries). */
const HISTORY_OVERLAYS: ReadonlySet<MusicOverlay> = new Set([
  'nowPlaying', 'panel', 'palette', 'shortcutsHelp', 'sleepTimer', 'import', 'addToPlaylist', 'trackInfo',
]);

/**
 * Which music overlay is open. Every overlay component reads its own signal
 * here and shows/hides itself; open and close only through these methods.
 *
 * Navigation to another page closes everything (settings.closeOverlaysOnNavigate).
 * With settings.backClosesOverlays, opening an overlay adds a history entry so
 * the browser/Android Back button closes it instead of leaving the page.
 */
@Injectable({ providedIn: 'root' })
export class MusicUiService {
  private settings = inject(MusicSettingsService);
  private router = inject(Router);

  private readonly _nowPlayingOpen = signal(false);
  private readonly _panel = signal<MusicPanel | null>(null);
  private readonly _paletteOpen = signal(false);
  private readonly _shortcutsHelpOpen = signal(false);
  private readonly _sleepTimerOpen = signal(false);
  private readonly _importOpen = signal(false);
  private readonly _addToPlaylist = signal<MusicTrack[] | null>(null);
  private readonly _trackInfo = signal<MusicTrack | null>(null);
  private readonly _contextMenu = signal<MusicContextMenuState | null>(null);

  readonly nowPlayingOpen = this._nowPlayingOpen.asReadonly();
  readonly panel = this._panel.asReadonly();
  readonly paletteOpen = this._paletteOpen.asReadonly();
  readonly shortcutsHelpOpen = this._shortcutsHelpOpen.asReadonly();
  readonly sleepTimerOpen = this._sleepTimerOpen.asReadonly();
  readonly importOpen = this._importOpen.asReadonly();
  /** Tracks waiting for "Add to playlist", or null. */
  readonly addToPlaylist = this._addToPlaylist.asReadonly();
  readonly trackInfo = this._trackInfo.asReadonly();
  readonly contextMenu = this._contextMenu.asReadonly();

  /** Open overlays, most recent last (what Back closes first). */
  private stack: MusicOverlay[] = [];
  /** Overlays that pushed a history entry. */
  private pushed = new Set<MusicOverlay>();
  /** popstates we caused ourselves (history.back() after a UI close). */
  private ignorePops = 0;
  private lastPath = '';

  constructor() {
    this.lastPath = this.path(this.router.url);
    const sub = this.router.events
      .pipe(filter((e): e is NavigationEnd => e instanceof NavigationEnd))
      .subscribe((e) => {
        const path = this.path(e.urlAfterRedirects);
        // Same-page navigations (query changes, our own history.back()) keep overlays.
        if (path !== this.lastPath && this.settings.closeOverlaysOnNavigate()) this.closeAll(true);
        this.lastPath = path;
      });
    inject(DestroyRef).onDestroy(() => sub.unsubscribe());

    if (typeof window !== 'undefined') {
      window.addEventListener('popstate', () => {
        if (this.ignorePops > 0) {
          this.ignorePops--;
          return;
        }
        const top = [...this.stack].reverse().find((o) => this.pushed.has(o));
        if (top) {
          this.pushed.delete(top);
          this.close(top, true);
        }
      });
    }
  }

  // ── Now Playing ──────────────────────────────────────────────────────────
  openNowPlaying(): void { this.open('nowPlaying', () => this._nowPlayingOpen.set(true)); }
  closeNowPlaying(): void { this.close('nowPlaying'); }
  toggleNowPlaying(): void { this._nowPlayingOpen() ? this.closeNowPlaying() : this.openNowPlaying(); }

  // ── Queue / lyrics side panel (one at a time) ────────────────────────────
  openPanel(p: MusicPanel): void {
    if (this._panel()) this._panel.set(p);
    else this.open('panel', () => this._panel.set(p));
  }
  closePanel(): void { this.close('panel'); }
  togglePanel(p: MusicPanel): void { this._panel() === p ? this.closePanel() : this.openPanel(p); }

  // ── Command palette, shortcuts help, sleep timer, import ────────────────
  openPalette(): void { this.open('palette', () => this._paletteOpen.set(true)); }
  closePalette(): void { this.close('palette'); }
  togglePalette(): void { this._paletteOpen() ? this.closePalette() : this.openPalette(); }

  openShortcutsHelp(): void { this.open('shortcutsHelp', () => this._shortcutsHelpOpen.set(true)); }
  closeShortcutsHelp(): void { this.close('shortcutsHelp'); }

  openSleepTimer(): void { this.open('sleepTimer', () => this._sleepTimerOpen.set(true)); }
  closeSleepTimer(): void { this.close('sleepTimer'); }

  openImport(): void { this.open('import', () => this._importOpen.set(true)); }
  closeImport(): void { this.close('import'); }

  // ── Dialogs with a payload ───────────────────────────────────────────────
  openAddToPlaylist(tracks: MusicTrack[]): void {
    if (!tracks.length) return;
    this.open('addToPlaylist', () => this._addToPlaylist.set([...tracks]));
  }
  closeAddToPlaylist(): void { this.close('addToPlaylist'); }

  openTrackInfo(track: MusicTrack): void { this.open('trackInfo', () => this._trackInfo.set(track)); }
  closeTrackInfo(): void { this.close('trackInfo'); }

  /**
   * Opens the context menu for `item` at the pointer, or under the event's
   * target when opened from the keyboard (no pointer coordinates).
   */
  openContextMenu(
    item: MusicLibraryItem,
    event: MouseEvent | KeyboardEvent | PointerEvent | { x: number; y: number } | null,
    tracks?: MusicTrack[],
    source?: string,
  ): void {
    let x = 0;
    let y = 0;
    if (event && 'clientX' in event && (event.clientX || event.clientY)) {
      x = event.clientX;
      y = event.clientY;
    } else if (event && 'target' in event && event.target instanceof Element) {
      const r = event.target.getBoundingClientRect();
      x = r.left;
      y = r.bottom;
    } else if (event && 'x' in event && !('target' in event)) {
      x = event.x;
      y = event.y;
    }
    if (event && 'preventDefault' in event) event.preventDefault();
    this.open('contextMenu', () => this._contextMenu.set({ item, tracks, x, y, source }));
  }
  closeContextMenu(): void { this.close('contextMenu'); }

  /** Whether any overlay is open. */
  anyOpen(): boolean {
    return this.stack.length > 0;
  }

  /** Closes every overlay. */
  closeAll(fromNavigation = false): void {
    for (const o of [...this.stack].reverse()) this.close(o, fromNavigation);
  }

  // ── internals ────────────────────────────────────────────────────────────

  private open(name: MusicOverlay, apply: () => void): void {
    apply();
    if (this.stack.includes(name)) return;
    this.stack.push(name);
    if (HISTORY_OVERLAYS.has(name) && this.settings.backClosesOverlays() && typeof history !== 'undefined') {
      try {
        // Keep the router's own state (navigationId) so it treats Back as the same page.
        history.pushState({ ...(history.state ?? {}), fiestaMusicOverlay: name }, '');
        this.pushed.add(name);
      } catch {
        // sandboxed iframe: Back just leaves the page
      }
    }
  }

  /** `quiet`: closed by Back or by navigation, so don't touch history. */
  private close(name: MusicOverlay, quiet = false): void {
    this.reset(name);
    const i = this.stack.lastIndexOf(name);
    if (i >= 0) this.stack.splice(i, 1);
    if (this.pushed.has(name)) {
      this.pushed.delete(name);
      if (!quiet && typeof history !== 'undefined') {
        this.ignorePops++;
        history.back();
      }
    }
  }

  private reset(name: MusicOverlay): void {
    switch (name) {
      case 'nowPlaying': this._nowPlayingOpen.set(false); break;
      case 'panel': this._panel.set(null); break;
      case 'palette': this._paletteOpen.set(false); break;
      case 'shortcutsHelp': this._shortcutsHelpOpen.set(false); break;
      case 'sleepTimer': this._sleepTimerOpen.set(false); break;
      case 'import': this._importOpen.set(false); break;
      case 'addToPlaylist': this._addToPlaylist.set(null); break;
      case 'trackInfo': this._trackInfo.set(null); break;
      case 'contextMenu': this._contextMenu.set(null); break;
    }
  }

  private path(url: string): string {
    return url.split(/[?#]/)[0];
  }
}
