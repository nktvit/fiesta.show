import { NgTemplateOutlet } from '@angular/common';
import { Component, computed, DestroyRef, inject, signal } from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { Meta, Title } from '@angular/platform-browser';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { map } from 'rxjs';
import { MusicAlbumCardComponent } from '../../components/music-album-card/music-album-card.component';
import { MusicArtistCardComponent } from '../../components/music-artist-card/music-artist-card.component';
import { MusicLikeButtonComponent } from '../../components/music-like-button/music-like-button.component';
import { MusicDialogComponent } from '../../components/music-dialog/music-dialog.component';
import { MusicPinsRowComponent, togglePinWithToast } from '../../components/music-pins-row/music-pins-row.component';
import { MusicPlaylistCardComponent } from '../../components/music-playlist-card/music-playlist-card.component';
import { MusicPlaylistEditorComponent } from '../../components/music-playlist-editor/music-playlist-editor.component';
import { MusicSubnavComponent } from '../../components/music-subnav/music-subnav.component';
import { MusicTrackRowComponent } from '../../components/music-track-row/music-track-row.component';
import { NavbarComponent } from '../../components/navbar/navbar.component';
import { MusicLibraryService, MusicFolder } from '../../services/music-library.service';
import { MusicPlayerService } from '../../services/music-player.service';
import { MusicSettingsService } from '../../services/music-settings.service';
import { MusicToastService } from '../../services/music-toast.service';
import { MusicAlbum, MusicArtist, MusicLibraryItem, MusicTrack, UserPlaylist } from '../../services/music.service';
import { filterByName, filterTracks, MUSIC_TRACK_SORTS, MusicTrackSort, sortTracks } from '../../utils/music-library-sort';

export type LibraryTab = 'tracks' | 'albums' | 'artists' | 'playlists' | 'mixes';

export const LIBRARY_TABS: { id: LibraryTab; label: string }[] = [
  { id: 'tracks', label: 'Tracks' },
  { id: 'albums', label: 'Albums' },
  { id: 'artists', label: 'Artists' },
  { id: 'playlists', label: 'Playlists' },
  { id: 'mixes', label: 'Mixes' },
];

/** Route /music/library (?tab=tracks|albums|artists|playlists|mixes). */
@Component({
  selector: 'app-music-library',
  imports: [
    NavbarComponent, MusicSubnavComponent, RouterLink, FormsModule, NgTemplateOutlet, MusicTrackRowComponent, MusicAlbumCardComponent,
    MusicArtistCardComponent, MusicPlaylistCardComponent, MusicLikeButtonComponent, MusicPinsRowComponent,
    MusicPlaylistEditorComponent, MusicDialogComponent,
  ],
  templateUrl: './music-library.component.html',
  host: { '(document:click)': 'moveMenu.set(null)' },
})
export class MusicLibraryComponent {
  protected readonly library = inject(MusicLibraryService);
  protected readonly player = inject(MusicPlayerService);
  protected readonly settings = inject(MusicSettingsService);
  private toast = inject(MusicToastService);
  private router = inject(Router);
  private route = inject(ActivatedRoute);

  protected readonly tabs = LIBRARY_TABS;
  protected readonly sorts = MUSIC_TRACK_SORTS;

  protected readonly tab = toSignal(
    this.route.queryParamMap.pipe(
      map((p) => {
        const t = p.get('tab');
        return (LIBRARY_TABS.some((x) => x.id === t) ? t : 'tracks') as LibraryTab;
      }),
      takeUntilDestroyed(inject(DestroyRef)),
    ),
    { initialValue: 'tracks' as LibraryTab },
  );

  /** Albums/artists layout; persists as fiesta:music:library-view. */
  protected readonly view = this.settings.scoped<'grid' | 'list'>('library-view', 'grid');

  protected readonly filter = signal('');
  protected readonly sort = signal<MusicTrackSort>('added');
  protected readonly folderFilter = signal<string | 'all'>('all');
  protected readonly moveMenu = signal<string | null>(null);
  protected readonly editorOpen = signal(false);
  protected readonly folderDialog = signal<{ mode: 'new' | 'rename'; id?: string } | null>(null);
  protected readonly confirmFolder = signal<MusicFolder | null>(null);
  protected folderName = '';

  protected readonly liked = computed(() => this.library.favorites());
  protected readonly allTracks = computed(() => this.liked().tracks.filter((t) => !this.library.isBlocked(t)));
  protected readonly tracks = computed(() => sortTracks(filterTracks(this.allTracks(), this.filter()), this.sort()));
  protected readonly albums = computed(() =>
    filterByName(this.liked().albums.filter((a) => !this.library.isBlocked({ kind: 'album', data: a })), this.filter(), (a) => `${a.title} ${a.artist}`));
  protected readonly artists = computed(() =>
    filterByName(this.liked().artists.filter((a) => !this.library.isBlocked({ kind: 'artist', data: a })), this.filter(), (a) => a.name));
  protected readonly mixes = computed(() => filterByName(this.liked().mixes, this.filter(), (m) => m.title));
  protected readonly savedPlaylists = computed(() => filterByName(this.liked().playlists, this.filter(), (p) => p.title));
  protected readonly myPlaylists = computed(() => {
    const f = this.folderFilter();
    const list = this.library.playlists().filter((p) => f === 'all' || p.folderId === f);
    return filterByName(list, this.filter(), (p) => p.name);
  });

  constructor() {
    inject(Title).setTitle('Your Library | Stream Fiesta');
    inject(Meta).updateTag({ name: 'description', content: 'Your liked songs, albums, artists and playlists.' });
  }

  protected setTab(t: LibraryTab): void {
    this.filter.set('');
    void this.router.navigate([], { relativeTo: this.route, queryParams: { tab: t === 'tracks' ? null : t }, queryParamsHandling: 'merge' });
  }

  protected onTabKey(e: KeyboardEvent, i: number): void {
    const n = this.tabs.length;
    const next = e.key === 'ArrowRight' ? (i + 1) % n : e.key === 'ArrowLeft' ? (i + n - 1) % n : -1;
    if (next < 0) return;
    e.preventDefault();
    this.setTab(this.tabs[next].id);
    queueMicrotask(() => (document.getElementById('music-library-tab-' + this.tabs[next].id) as HTMLElement | null)?.focus());
  }

  protected playAll(shuffle: boolean): void {
    const list = sortTracks(this.allTracks(), this.sort());
    if (!list.length) return;
    const start = shuffle ? list[Math.floor(Math.random() * list.length)] : list[0];
    void this.player.play(start, list, { shuffle, context: { type: 'library', label: 'Liked tracks' } });
  }

  protected onSort(v: string): void {
    this.sort.set(v as MusicTrackSort);
  }

  // ── pins ──
  protected isPinned(it: MusicLibraryItem): boolean {
    return this.library.isPinned(it);
  }
  protected pin(it: MusicLibraryItem): void {
    togglePinWithToast(this.library, this.toast, it);
  }
  protected albumItem = (a: MusicAlbum): MusicLibraryItem => ({ kind: 'album', data: a });
  protected artistItem = (a: MusicArtist): MusicLibraryItem => ({ kind: 'artist', data: a });
  protected playlistItem = (p: UserPlaylist): MusicLibraryItem => ({ kind: 'userPlaylist', data: p });

  // ── playlists ──
  protected onCreated(id: string): void {
    void this.router.navigate(['/music/library/playlist', id]);
  }

  // ── folders ──
  protected folderLabel = (id: string | 'all'): string => this.library.folders().find((f) => f.id === id)?.name ?? '';

  protected openFolderDialog(mode: 'new' | 'rename'): void {
    const f = this.folderFilter();
    this.folderName = mode === 'rename' && f !== 'all' ? this.folderLabel(f) : '';
    this.folderDialog.set({ mode, id: mode === 'rename' && f !== 'all' ? f : undefined });
  }

  protected saveFolder(): void {
    const d = this.folderDialog();
    const name = this.folderName.trim();
    if (!d || !name) return;
    if (d.mode === 'new') {
      const f = this.library.createFolder(name);
      this.folderFilter.set(f.id);
    } else if (d.id) {
      this.library.renameFolder(d.id, name);
    }
    this.folderDialog.set(null);
  }

  protected askDeleteFolder(): void {
    this.confirmFolder.set(this.library.folders().find((x) => x.id === this.folderFilter()) ?? null);
  }

  protected deleteFolder(): void {
    const f = this.confirmFolder();
    if (!f) return;
    this.library.deleteFolder(f.id);
    if (this.folderFilter() === f.id) this.folderFilter.set('all');
    this.confirmFolder.set(null);
    this.toast.show({ message: `Deleted folder ${f.name}` });
  }

  protected toggleMoveMenu(id: string, e: Event): void {
    e.stopPropagation();
    this.moveMenu.set(this.moveMenu() === id ? null : id);
  }

  protected move(p: UserPlaylist, folderId: string | null): void {
    this.library.movePlaylistToFolder(p.id, folderId);
    const name = folderId ? this.folderLabel(folderId) : '';
    this.toast.show({ message: folderId ? `Moved to ${name}` : 'Removed from folder' });
    this.moveMenu.set(null);
  }

  protected onMenuKey(e: KeyboardEvent, id: string): void {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    this.moveMenu.set(null);
    (document.getElementById('music-move-btn-' + id) as HTMLElement | null)?.focus();
  }

  protected count(n: number, one: string, many: string): string {
    return `${n} ${n === 1 ? one : many}`;
  }
}
