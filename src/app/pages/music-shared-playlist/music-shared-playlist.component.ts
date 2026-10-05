import { Component, computed, DestroyRef, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Meta, Title } from '@angular/platform-browser';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { catchError, concat, map, Observable, of, switchMap, toArray } from 'rxjs';
import { MusicExportMenuComponent } from '../../components/music-export-menu/music-export-menu.component';
import { MusicSubnavComponent } from '../../components/music-subnav/music-subnav.component';
import { MusicTrackRowComponent } from '../../components/music-track-row/music-track-row.component';
import { NavbarComponent } from '../../components/navbar/navbar.component';
import { MusicCatalogService } from '../../services/music-catalog.service';
import { MusicLibraryService } from '../../services/music-library.service';
import { MusicPlayerService } from '../../services/music-player.service';
import { MusicToastService } from '../../services/music-toast.service';
import { MusicTrack } from '../../services/music.service';
import { longDuration } from '../../utils/music-format';
import { parseSharePayload } from '../../utils/music-share';

type State = 'loading' | 'ready' | 'invalid' | 'failed';

const CHUNK = 100;

/**
 * Route /music/shared?d=<payload>. Owned by package P7.
 * Decodes the link (v0 plain, v1 deflate-raw), resolves the ids through the
 * catalogue in chunks of 100, lists them, and offers Play and Save a copy.
 */
@Component({
  selector: 'app-music-shared-playlist',
  imports: [NavbarComponent, MusicSubnavComponent, MusicTrackRowComponent, MusicExportMenuComponent, RouterLink],
  templateUrl: './music-shared-playlist.component.html',
})
export class MusicSharedPlaylistComponent {
  private catalog = inject(MusicCatalogService);
  private library = inject(MusicLibraryService);
  private player = inject(MusicPlayerService);
  private toast = inject(MusicToastService);
  private router = inject(Router);

  protected readonly state = signal<State>('loading');
  protected readonly name = signal('');
  protected readonly description = signal('');
  protected readonly ids = signal<number[]>([]);
  protected readonly resolved = signal<MusicTrack[]>([]);
  protected readonly saved = signal(false);
  /** Tracks the catalogue returned that aren't blocked, in the shared order. */
  protected readonly tracks = computed(() => this.resolved().filter((t) => !this.library.isBlocked(t)));
  protected readonly duration = computed(() => longDuration(this.tracks().reduce((s, t) => s + (t.duration || 0), 0)));
  private payload = '';

  constructor() {
    inject(Title).setTitle('Shared Playlist | Stream Fiesta');
    inject(Meta).updateTag({ name: 'description', content: 'A playlist someone shared with you.' });
    inject(ActivatedRoute).queryParamMap
      .pipe(
        map((p) => p.get('d') ?? ''),
        switchMap((d) => {
          this.payload = d;
          this.state.set('loading');
          this.saved.set(false);
          return this.load(d);
        }),
        takeUntilDestroyed(inject(DestroyRef)),
      )
      .subscribe();
  }

  private load(d: string): Observable<void> {
    return new Observable<void>((sub) => {
      void (async () => {
        const parsed = d ? await parseSharePayload(d) : null;
        if (!parsed || !parsed.ids.length) {
          this.state.set('invalid');
          sub.complete();
          return;
        }
        this.name.set(parsed.name);
        this.description.set(parsed.description ?? '');
        this.ids.set(parsed.ids);
        this.resolve(parsed.ids).subscribe(() => sub.complete());
      })();
    });
  }

  private resolve(ids: number[]): Observable<void> {
    const chunks: number[][] = [];
    for (let i = 0; i < ids.length; i += CHUNK) chunks.push(ids.slice(i, i + CHUNK));
    return concat(...chunks.map((c) => this.catalog.tracks(c))).pipe(
      toArray(),
      map((parts) => {
        const byId = new Map(parts.flat().map((t) => [t.id, t] as const));
        const ordered = ids.map((id) => byId.get(id)).filter((t): t is MusicTrack => !!t);
        if (!ordered.length) throw new Error('empty');
        this.resolved.set(ordered);
        this.state.set('ready');
      }),
      catchError(() => {
        this.state.set('failed');
        return of(void 0);
      }),
    );
  }

  protected retry(): void {
    this.state.set('loading');
    this.resolve(this.ids()).subscribe();
  }

  protected play(shuffle: boolean): void {
    const list = this.tracks();
    if (!list.length) return;
    const start = shuffle ? list[Math.floor(Math.random() * list.length)] : list[0];
    void this.player.play(start, list, { shuffle, context: { type: 'queue', label: this.name() || 'Shared playlist' } });
  }

  protected saveCopy(): void {
    const list = this.tracks();
    if (!list.length) return;
    const p = this.library.createPlaylist(this.name() || 'Shared playlist', list, this.description());
    this.saved.set(true);
    this.toast.show({
      message: `Saved "${p.name}" to your library`,
      action: { label: 'View', run: () => void this.router.navigate(['/music/library/playlist', p.id]) },
    });
  }
}
