import { CdkDragDrop, DragDropModule } from '@angular/cdk/drag-drop';
import { Component, computed, DestroyRef, effect, inject, signal } from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { Meta, Title } from '@angular/platform-browser';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { map } from 'rxjs';
import { MusicDialogComponent } from '../../components/music-dialog/music-dialog.component';
import { MusicExportMenuComponent } from '../../components/music-export-menu/music-export-menu.component';
import { togglePinWithToast } from '../../components/music-pins-row/music-pins-row.component';
import { MusicPlaylistEditorComponent } from '../../components/music-playlist-editor/music-playlist-editor.component';
import { MusicSubnavComponent } from '../../components/music-subnav/music-subnav.component';
import { MusicTrackRowComponent } from '../../components/music-track-row/music-track-row.component';
import { NavbarComponent } from '../../components/navbar/navbar.component';
import { MusicLibraryService } from '../../services/music-library.service';
import { MusicPlayerService } from '../../services/music-player.service';
import { MusicRecommenderService } from '../../services/music-recommender.service';
import { MusicToastService } from '../../services/music-toast.service';
import { MusicLibraryItem, MusicTrack } from '../../services/music.service';
import { longDuration } from '../../utils/music-format';
import { distinctCovers, MUSIC_TRACK_SORTS, MusicTrackSort, sortTracks, totalDuration } from '../../utils/music-library-sort';
import { buildShareUrl } from '../../utils/music-share';

interface Row {
  track: MusicTrack;
  /** Position in the stored playlist (differs from the row position when sorted or when blocked tracks are hidden). */
  index: number;
}

/** Route /music/library/playlist/:id: one of the visitor's playlists. */
@Component({
  selector: 'app-music-user-playlist',
  imports: [
    NavbarComponent, MusicSubnavComponent, RouterLink, FormsModule, DragDropModule, MusicTrackRowComponent,
    MusicPlaylistEditorComponent, MusicDialogComponent, MusicExportMenuComponent,
  ],
  templateUrl: './music-user-playlist.component.html',
})
export class MusicUserPlaylistComponent {
  protected readonly library = inject(MusicLibraryService);
  private player = inject(MusicPlayerService);
  private recommender = inject(MusicRecommenderService);
  private toast = inject(MusicToastService);
  private router = inject(Router);
  private title = inject(Title);

  protected readonly sorts: { value: MusicTrackSort; label: string }[] = [{ value: 'custom', label: 'Custom order' }, ...MUSIC_TRACK_SORTS];
  protected readonly sort = signal<MusicTrackSort>('custom');
  protected readonly editorOpen = signal(false);
  protected readonly confirmDelete = signal(false);
  protected readonly recs = signal<MusicTrack[]>([]);
  protected readonly recsLoading = signal(false);
  private recsFor = '';

  private readonly id = toSignal(
    inject(ActivatedRoute).paramMap.pipe(map((p) => p.get('id') ?? ''), takeUntilDestroyed(inject(DestroyRef))),
    { initialValue: '' },
  );

  protected readonly playlist = computed(() => this.library.playlists().find((p) => p.id === this.id()) ?? null);
  protected readonly item = computed<MusicLibraryItem | null>(() => {
    const p = this.playlist();
    return p ? { kind: 'userPlaylist', data: p } : null;
  });
  protected readonly pinned = computed(() => {
    const it = this.item();
    return it ? this.library.isPinned(it) : false;
  });

  /** Visible rows in display order (sorted, blocked tracks hidden). */
  protected readonly rows = computed<Row[]>(() => {
    const p = this.playlist();
    if (!p) return [];
    const withIndex = p.tracks.map((t, index) => ({ ...t, index }));
    return sortTracks(withIndex, this.sort())
      .filter((t) => !this.library.isBlocked(t))
      .map((t) => ({ track: t as MusicTrack, index: t.index }));
  });
  protected readonly queue = computed(() => this.rows().map((r) => r.track));
  protected readonly covers = computed(() => distinctCovers(this.playlist()?.tracks ?? []));
  protected readonly duration = computed(() => longDuration(totalDuration(this.playlist()?.tracks ?? [])));
  protected readonly canReorder = computed(() => this.sort() === 'custom');

  /** Recommendations that are not already in the playlist. */
  protected readonly freshRecs = computed(() => {
    const have = new Set((this.playlist()?.tracks ?? []).map((t) => t.id));
    return this.recs().filter((t) => !have.has(t.id) && !this.library.isBlocked(t));
  });

  constructor() {
    inject(Meta).updateTag({ name: 'description', content: 'A playlist from your library.' });
    effect(() => {
      const p = this.playlist();
      this.title.setTitle(p ? `${p.name} | Stream Fiesta` : 'Playlist | Stream Fiesta');
    });
    // Recommendations load once per playlist visited (and on Refresh); adding one just removes it from the list.
    effect(() => {
      const p = this.playlist();
      if (!p || !p.tracks.length || this.recsFor === p.id) return;
      this.recsFor = p.id;
      void this.refreshRecs();
    });
  }

  protected async refreshRecs(): Promise<void> {
    const p = this.playlist();
    if (!p?.tracks.length) return;
    this.recsLoading.set(true);
    try {
      this.recs.set(await this.recommender.forPlaylist(p.tracks, 10));
    } catch {
      this.recs.set([]);
    } finally {
      this.recsLoading.set(false);
    }
  }

  protected addRec(t: MusicTrack): void {
    const p = this.playlist();
    if (!p) return;
    this.library.addToPlaylist(p.id, [t]);
    this.toast.show({ message: `Added ${t.title}` });
  }

  protected play(shuffle: boolean): void {
    const p = this.playlist();
    const list = this.queue();
    if (!p || !list.length) return;
    const start = shuffle ? list[Math.floor(Math.random() * list.length)] : list[0];
    void this.player.play(start, list, { shuffle, context: { type: 'userPlaylist', id: p.id, label: p.name } });
  }

  protected onSort(v: string): void {
    this.sort.set(v as MusicTrackSort);
  }

  protected drop(e: CdkDragDrop<Row[]>): void {
    const p = this.playlist();
    const rows = this.rows();
    if (!p || !this.canReorder() || e.previousIndex === e.currentIndex) return;
    const from = rows[e.previousIndex]?.index;
    const to = rows[e.currentIndex]?.index;
    if (from === undefined || to === undefined) return;
    this.library.movePlaylistTrack(p.id, from, to);
  }

  /** Keyboard / button reorder: swap with the visible neighbour. */
  protected move(pos: number, delta: -1 | 1): void {
    const p = this.playlist();
    const rows = this.rows();
    const other = rows[pos + delta];
    if (!p || !other || !this.canReorder()) return;
    this.library.movePlaylistTrack(p.id, rows[pos].index, other.index);
    setTimeout(() => {
      const btn = document.querySelector<HTMLElement>(`[data-row="${pos + delta}"] [data-move="${delta === -1 ? 'up' : 'down'}"]`)
        ?? document.querySelector<HTMLElement>(`[data-row="${pos + delta}"] [data-move]`);
      btn?.focus();
    }, 60);
  }

  protected remove(row: Row): void {
    const p = this.playlist();
    if (!p) return;
    const track = row.track;
    this.library.removeFromPlaylist(p.id, row.index);
    this.toast.show({
      message: `Removed ${track.title}`,
      action: {
        label: 'Undo',
        run: () => {
          // Put it back where it was (addToPlaylist appends, then move to the old slot).
          if (this.library.addToPlaylist(p.id, [track])) {
            const n = this.library.playlist(p.id)?.tracks.length ?? 0;
            this.library.movePlaylistTrack(p.id, n - 1, Math.min(row.index, n - 1));
          }
        },
      },
    });
  }

  protected togglePin(): void {
    const it = this.item();
    if (it) togglePinWithToast(this.library, this.toast, it);
  }

  protected async share(): Promise<void> {
    const p = this.playlist();
    if (!p) return;
    try {
      const url = await buildShareUrl({ name: p.name, description: p.description, tracks: p.tracks });
      const coarse = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;
      if (coarse && typeof navigator !== 'undefined' && 'share' in navigator) {
        try {
          await navigator.share({ title: p.name, url });
          return;
        } catch (e) {
          if ((e as DOMException)?.name === 'AbortError') return;
        }
      }
      await navigator.clipboard.writeText(url);
      this.toast.show({ message: 'Link copied' });
    } catch {
      this.toast.show({ message: "Couldn't copy the share link", tone: 'warn' });
    }
  }

  protected deletePlaylist(): void {
    const p = this.playlist();
    if (!p) return;
    this.library.deletePlaylist(p.id);
    this.confirmDelete.set(false);
    this.toast.show({ message: `Deleted ${p.name}` });
    void this.router.navigate(['/music/library'], { queryParams: { tab: 'playlists' }, queryParamsHandling: 'merge' });
  }
}
