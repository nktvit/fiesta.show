import { A11yModule } from '@angular/cdk/a11y';
import { Component, computed, effect, inject } from '@angular/core';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { MusicDiscoveryService } from '../../services/music-discovery.service';
import { MusicDownloadService } from '../../services/music-download.service';
import { MusicLibraryService } from '../../services/music-library.service';
import { MusicPlayerService, RadioSeed } from '../../services/music-player.service';
import { MusicSelectionService } from '../../services/music-selection.service';
import { MusicToastService } from '../../services/music-toast.service';
import { MusicUiService } from '../../services/music-ui.service';
import { MusicLibraryItem, MusicService, MusicTrack } from '../../services/music.service';
import { musicShareTarget, shareMusicTarget } from '../../utils/music-share-target';

interface MenuEntry {
  id: string;
  label: string;
  run: () => void | Promise<void>;
  /** Draws a divider above the entry. */
  divider?: boolean;
}

const ITEM_HEIGHT = 40;
const MENU_WIDTH = 224;

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Global host for track and card context menus (ui.contextMenu()): a popover at
 * the pointer on desktop, a bottom action sheet on phones. role=menu with arrow
 * key navigation; closes on Escape, outside click, scroll and resize.
 */
@Component({
  selector: 'app-music-context-menu',
  imports: [A11yModule],
  templateUrl: './music-context-menu.component.html',
})
export class MusicContextMenuComponent {
  protected readonly ui = inject(MusicUiService);
  private player = inject(MusicPlayerService);
  private library = inject(MusicLibraryService);
  private toast = inject(MusicToastService);
  private router = inject(Router);
  private music = inject(MusicService);
  private discovery = inject(MusicDiscoveryService);
  private downloads = inject(MusicDownloadService);
  private selection = inject(MusicSelectionService);

  /** Phone width: draw as a bottom sheet. Evaluated when a menu opens. */
  protected readonly sheet = computed(() => {
    this.ui.contextMenu();
    return typeof window !== 'undefined' && !!window.matchMedia?.('(max-width: 639px)').matches;
  });

  protected readonly heading = computed(() => {
    const it = this.ui.contextMenu()?.item;
    if (!it) return '';
    const n = this.ui.contextMenu()?.tracks?.length ?? 0;
    if (it.kind === 'track' && n > 1) return `${n} tracks selected`;
    switch (it.kind) {
      case 'track': case 'album': case 'playlist': case 'mix': return it.data.title;
      default: return it.data.name;
    }
  });

  protected readonly entries = computed<MenuEntry[]>(() => {
    const m = this.ui.contextMenu();
    if (!m) return [];
    // Re-evaluate when likes, pins, blocks or the download switch change.
    this.library.favorites();
    this.library.pins();
    const list = m.item.kind === 'track' && m.tracks && m.tracks.length > 1 ? this.bulkEntries(m.tracks) : this.entriesFor(m.item);
    return list;
  });

  protected readonly pos = computed(() => {
    const m = this.ui.contextMenu();
    if (!m || typeof window === 'undefined') return { left: 0, top: 0 };
    const h = this.entries().length * ITEM_HEIGHT + 8;
    return {
      left: Math.max(8, Math.min(m.x, window.innerWidth - MENU_WIDTH - 8)),
      top: Math.max(8, Math.min(m.y, window.innerHeight - h - 8)),
    };
  });

  constructor() {
    // The user scrolling (wheel / touch drag / scroll keys) or turning the device moves the anchor away: close.
    // Plain `scroll` events are not used: late-loading images shift the page without any user input.
    effect((onCleanup) => {
      if (!this.ui.contextMenu() || typeof window === 'undefined') return;
      const outside = (e: Event) => !(e.target instanceof Element && e.target.closest('[role=menu]'));
      const onUser = (e: Event) => { if (outside(e)) this.ui.closeContextMenu(); };
      const onKey = (e: KeyboardEvent) => {
        if (['PageDown', 'PageUp', 'Home', 'End', ' '].includes(e.key) && outside(e)) this.ui.closeContextMenu();
      };
      const width = window.innerWidth;
      const onResize = () => { if (window.innerWidth !== width) this.ui.closeContextMenu(); };
      window.addEventListener('wheel', onUser, { capture: true, passive: true });
      window.addEventListener('touchmove', onUser, { capture: true, passive: true });
      window.addEventListener('keydown', onKey, true);
      window.addEventListener('resize', onResize);
      onCleanup(() => {
        window.removeEventListener('wheel', onUser, true);
        window.removeEventListener('touchmove', onUser, true);
        window.removeEventListener('keydown', onKey, true);
        window.removeEventListener('resize', onResize);
      });
    });
  }

  protected onKeydown(e: KeyboardEvent): void {
    const items = Array.from((e.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('[role=menuitem]'));
    const i = items.indexOf(document.activeElement as HTMLElement);
    switch (e.key) {
      case 'Escape':
        e.stopPropagation();
        this.ui.closeContextMenu();
        return;
      case 'ArrowDown': items[(i + 1) % items.length]?.focus(); break;
      case 'ArrowUp': items[(i - 1 + items.length) % items.length]?.focus(); break;
      case 'Home': items[0]?.focus(); break;
      case 'End': items[items.length - 1]?.focus(); break;
      case 'Tab': this.ui.closeContextMenu(); return;
      default: return;
    }
    e.preventDefault();
  }

  protected async choose(entry: MenuEntry): Promise<void> {
    this.ui.closeContextMenu();
    try {
      await entry.run();
    } catch (e) {
      console.error('music menu action failed', entry.id, e);
      this.toast.show({ message: `${entry.label} didn't work`, tone: 'warn' });
    }
  }

  // ── Entries ──────────────────────────────────────────────────────────────

  private entriesFor(item: MusicLibraryItem): MenuEntry[] {
    return item.kind === 'track' ? this.trackEntries(item.data) : this.cardEntries(item);
  }

  private trackEntries(t: MusicTrack): MenuEntry[] {
    const item: MusicLibraryItem = { kind: 'track', data: t };
    const liked = this.library.isFavorite(item);
    const out: MenuEntry[] = [
      { id: 'play-next', label: 'Play next', run: () => { this.player.playNext([t]); this.toast.show({ message: 'Playing next' }); } },
      { id: 'queue', label: 'Add to queue', run: () => { this.player.addToQueue([t]); this.toast.show({ message: 'Added to queue' }); } },
      { id: 'like', label: liked ? 'Unlike' : 'Like', run: () => this.like(item) },
      { id: 'playlist', label: 'Add to playlist…', run: () => this.ui.openAddToPlaylist([t]) },
      { id: 'radio', label: 'Start radio', divider: true, run: () => this.player.startRadio({ kind: 'track', id: t.id, label: t.title }) },
    ];
    if (t.artistId) out.push({ id: 'artist', label: 'Go to artist', run: () => void this.router.navigate(['/music/artist', t.artistId]) });
    if (t.albumId) out.push({ id: 'album', label: 'Go to album', run: () => void this.router.navigate(['/music/album', t.albumId]) });
    out.push(
      { id: 'info', label: 'Track info', run: () => this.ui.openTrackInfo(t) },
      { id: 'share', label: 'Share', run: () => this.share(item) },
      { id: 'new-tab', label: 'Open in new tab', run: () => void window.open(`/music/track/${t.id}`, '_blank', 'noopener') },
      { id: 'select', label: 'Select', run: () => this.selection.select(t) },
    );
    if (this.downloads.enabled()) out.push({ id: 'download', label: 'Download', run: () => this.downloads.downloadTracks([t], { name: t.title }) });
    out.push({ id: 'hide', label: 'Hide track', divider: true, run: () => this.hide(item) });
    return out;
  }

  private bulkEntries(tracks: MusicTrack[]): MenuEntry[] {
    const n = tracks.length;
    const out: MenuEntry[] = [
      { id: 'play', label: 'Play', run: () => this.player.play(tracks[0], tracks, { context: { type: 'queue', label: 'Selection' } }) },
      { id: 'play-next', label: 'Play next', run: () => { this.player.playNext(tracks); this.toast.show({ message: `${plural(n, 'track', 'tracks')} will play next` }); } },
      { id: 'queue', label: 'Add to queue', run: () => { this.player.addToQueue(tracks); this.toast.show({ message: `Added ${plural(n, 'track', 'tracks')} to queue` }); } },
      { id: 'like', label: 'Like all', run: () => this.likeAll(tracks) },
      { id: 'playlist', label: 'Add to playlist…', run: () => this.ui.openAddToPlaylist(tracks) },
    ];
    if (this.downloads.enabled()) out.push({ id: 'download', label: 'Download', run: () => this.downloads.downloadTracks(tracks, { name: 'Selection', kind: 'selection' }) });
    out.push({ id: 'clear', label: 'Clear selection', divider: true, run: () => this.selection.clear() });
    return out;
  }

  private cardEntries(item: MusicLibraryItem): MenuEntry[] {
    const label = this.heading();
    const out: MenuEntry[] = [
      { id: 'play', label: 'Play', run: () => this.playItem(item, false) },
      { id: 'shuffle', label: 'Shuffle', run: () => this.playItem(item, true) },
      {
        id: 'queue', label: 'Add to queue',
        run: async () => {
          const tracks = await this.tracksFor(item);
          if (!tracks.length) return this.nothingToDo(label);
          this.player.addToQueue(tracks);
          this.toast.show({ message: `Added ${plural(tracks.length, 'track', 'tracks')} to queue` });
        },
      },
    ];
    if (item.kind !== 'userPlaylist') {
      out.push({ id: 'like', label: this.library.isFavorite(item) ? 'Unlike' : 'Like', run: () => this.like(item) });
    }
    out.push({
      id: 'playlist', label: 'Add to playlist…',
      run: async () => {
        const tracks = await this.tracksFor(item);
        if (!tracks.length) return this.nothingToDo(label);
        this.ui.openAddToPlaylist(tracks);
      },
    });
    out.push({ id: 'radio', label: 'Start radio', divider: true, run: () => this.radio(item) });
    out.push({ id: 'share', label: 'Share', run: () => this.share(item) });
    if (this.downloads.enabled()) out.push({ id: 'download', label: 'Download', run: () => this.download(item) });
    out.push({ id: 'pin', label: this.library.isPinned(item) ? 'Unpin' : 'Pin', run: () => this.pin(item) });
    if (item.kind === 'album' || item.kind === 'artist') {
      out.push({ id: 'hide', label: item.kind === 'album' ? 'Hide album' : 'Hide artist', divider: true, run: () => this.hide(item) });
    }
    return out;
  }

  // ── Actions ──────────────────────────────────────────────────────────────

  private like(item: MusicLibraryItem): void {
    const liked = this.library.toggleFavorite(item);
    this.toast.show({
      message: liked ? 'Added to Liked' : 'Removed from Liked',
      action: { label: 'Undo', run: () => this.library.toggleFavorite(item) },
    });
  }

  private likeAll(tracks: MusicTrack[]): void {
    const n = this.library.addFavorites(tracks.map((data) => ({ kind: 'track' as const, data })));
    this.toast.show({ message: n ? `Liked ${plural(n, 'track', 'tracks')}` : 'Already liked' });
  }

  private hide(item: MusicLibraryItem): void {
    this.library.block(item);
    if (item.kind !== 'track' && item.kind !== 'album' && item.kind !== 'artist') return;
    const kind = item.kind;
    const id = item.data.id;
    this.toast.show({
      message: kind === 'track' ? 'Track hidden' : kind === 'album' ? 'Album hidden' : 'Artist hidden',
      action: { label: 'Undo', run: () => this.library.unblock(kind, id) },
    });
  }

  private pin(item: MusicLibraryItem): void {
    const was = this.library.isPinned(item);
    const now = this.library.togglePin(item);
    if (!was && !now) this.toast.show({ message: 'You can pin up to 3 items. Unpin one first.', tone: 'warn' });
    else this.toast.show({ message: now ? 'Pinned to Music home' : 'Unpinned' });
  }

  private async share(item: MusicLibraryItem): Promise<void> {
    const target = await musicShareTarget(item);
    if (!target) {
      this.toast.show({ message: 'Nothing to share yet', tone: 'warn' });
      return;
    }
    const outcome = await shareMusicTarget(target);
    if (outcome === 'copied') this.toast.show({ message: 'Link copied' });
    else if (outcome === 'failed') this.toast.show({ message: "Couldn't copy the link", tone: 'warn' });
  }

  private async radio(item: MusicLibraryItem): Promise<void> {
    let seed: RadioSeed;
    switch (item.kind) {
      case 'track': seed = { kind: 'track', id: item.data.id, label: item.data.title }; break;
      case 'album': seed = { kind: 'album', id: item.data.id, label: item.data.title }; break;
      case 'artist': seed = { kind: 'artist', id: item.data.id, label: item.data.name }; break;
      case 'playlist': seed = { kind: 'playlist', id: item.data.uuid, label: item.data.title }; break;
      case 'mix': seed = { kind: 'mix', id: item.data.id, label: item.data.title }; break;
      default: seed = { kind: 'playlist', id: item.data.id, label: item.data.name, tracks: await this.tracksFor(item) };
    }
    await this.player.startRadio(seed);
  }

  private async playItem(item: MusicLibraryItem, shuffle: boolean): Promise<void> {
    const label = this.heading();
    const tracks = await this.tracksFor(item);
    if (!tracks.length) return this.nothingToDo(label);
    const first = shuffle ? tracks[Math.floor(Math.random() * tracks.length)] : tracks[0];
    const type = item.kind === 'track' ? 'queue' : item.kind;
    const id = item.kind === 'playlist' ? item.data.uuid : item.kind === 'track' ? undefined : item.data.id;
    await this.player.play(first, tracks, { context: { type, id, label }, shuffle });
  }

  private async download(item: MusicLibraryItem): Promise<void> {
    if (item.kind === 'artist') return this.downloads.downloadArtist(item.data.id);
    const tracks = await this.tracksFor(item);
    if (!tracks.length) return this.nothingToDo(this.heading());
    if (item.kind === 'album') return this.downloads.downloadAlbum(item.data, tracks);
    return this.downloads.downloadTracks(tracks, { name: this.heading(), kind: 'playlist' });
  }

  private nothingToDo(label: string): void {
    this.toast.show({ message: `Couldn't load ${label}`, tone: 'warn' });
  }

  /** The tracks an item stands for: what the opener passed, else fetched. Blocked ones are dropped. */
  private async tracksFor(item: MusicLibraryItem): Promise<MusicTrack[]> {
    const given = this.ui.contextMenu()?.tracks;
    let tracks: MusicTrack[] = [];
    try {
      if (given?.length) tracks = given;
      else {
        switch (item.kind) {
          case 'track': tracks = [item.data]; break;
          case 'album': tracks = (await firstValueFrom(this.music.album(item.data.id))).tracks; break;
          case 'artist': tracks = (await firstValueFrom(this.music.artist(item.data.id))).topTracks; break;
          case 'playlist': tracks = (await firstValueFrom(this.discovery.playlist(item.data.uuid))).tracks; break;
          case 'mix': tracks = (await firstValueFrom(this.discovery.mix(item.data.id))).tracks; break;
          case 'userPlaylist': tracks = item.data.tracks; break;
        }
      }
    } catch {
      tracks = [];
    }
    return tracks.filter((t) => !this.library.isBlocked(t));
  }
}
