import { Component, computed, effect, ElementRef, inject, signal, untracked, viewChild } from '@angular/core';
import { Router } from '@angular/router';
import { ImportCommitResult, ImportMatchResult, ImportMode, ImportProgress, MusicImportService } from '../../services/music-import.service';
import { MusicToastService } from '../../services/music-toast.service';
import { MusicUiService } from '../../services/music-ui.service';
import { generateMissingCSV, saveTextFile } from '../../utils/music-playlist-files';
import { IMPORT_ACCEPT, ParsedImport } from '../../utils/music-import-parse';
import { MusicDialogComponent } from '../music-dialog/music-dialog.component';

type Step = 'pick' | 'ready' | 'matching' | 'done';

/**
 * Playlist/library import wizard. Visible when ui.importOpen(). Owned by package P7.
 * Pick a file, see the detected format, match rows against TIDAL (with Cancel),
 * then get the new playlist (or add-only favourites) plus a missing-tracks report.
 */
@Component({
  selector: 'app-music-import-dialog',
  imports: [MusicDialogComponent],
  templateUrl: './music-import-dialog.component.html',
})
export class MusicImportDialogComponent {
  protected readonly ui = inject(MusicUiService);
  private importer = inject(MusicImportService);
  private toast = inject(MusicToastService);
  private router = inject(Router);

  protected readonly accept = IMPORT_ACCEPT;
  protected readonly fileInput = viewChild<ElementRef<HTMLInputElement>>('fileInput');
  protected readonly step = signal<Step>('pick');
  protected readonly mode = signal<ImportMode>('playlist');
  protected readonly parsed = signal<ParsedImport | null>(null);
  protected readonly fileName = signal('');
  protected readonly name = signal('');
  protected readonly error = signal('');
  protected readonly progress = signal<ImportProgress>({ done: 0, total: 0, current: '' });
  protected readonly result = signal<ImportMatchResult | null>(null);
  protected readonly committed = signal<ImportCommitResult | null>(null);

  protected readonly percent = computed(() => {
    const p = this.progress();
    return p.total ? Math.round((p.done / p.total) * 100) : 0;
  });
  protected readonly trackRows = computed(() => this.parsed()?.rows.filter((r) => r.type === 'track').length ?? 0);
  protected readonly otherRows = computed(() => (this.parsed()?.rows.length ?? 0) - this.trackRows());
  protected readonly canStart = computed(() => {
    const p = this.parsed();
    if (!p) return false;
    return this.mode() === 'playlist' ? this.trackRows() > 0 : p.rows.length > 0;
  });

  private abort: AbortController | null = null;

  constructor() {
    effect(() => {
      if (!this.ui.importOpen()) untracked(() => this.reset());
    });
  }

  protected pick(): void {
    this.fileInput()?.nativeElement.click();
  }

  protected async onFile(e: Event): Promise<void> {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    this.error.set('');
    try {
      const parsed = await this.importer.readFile(file);
      this.parsed.set(parsed);
      this.fileName.set(file.name);
      this.name.set(parsed.name || file.name.replace(/\.[^.]+$/, ''));
      // A file of albums/artists/favourites is most useful as favourites.
      const tracks = parsed.rows.filter((r) => r.type === 'track').length;
      this.mode.set(tracks === 0 || parsed.rows.some((r) => r.favorite) ? 'library' : 'playlist');
      this.step.set('ready');
    } catch (err) {
      this.parsed.set(null);
      this.step.set('pick');
      this.error.set(err instanceof Error ? err.message : 'Could not read that file.');
    }
  }

  protected setMode(m: ImportMode): void {
    this.mode.set(m);
  }

  protected onName(e: Event): void {
    this.name.set((e.target as HTMLInputElement).value);
  }

  protected async start(): Promise<void> {
    const parsed = this.parsed();
    if (!parsed || !this.canStart()) return;
    const ctl = new AbortController();
    this.abort = ctl;
    this.step.set('matching');
    this.progress.set({ done: 0, total: 0, current: '' });
    const mode = this.mode();
    const res = await this.importer.match(parsed, mode, ctl.signal, (p) => this.progress.set(p));
    if (this.abort !== ctl) return;
    this.abort = null;
    if (res.cancelled) {
      this.step.set('ready');
      this.toast.show({ message: 'Import cancelled' });
      return;
    }
    this.result.set(res);
    this.committed.set(mode === 'playlist' && res.tracks.length === 0 ? null : this.importer.commit(parsed, this.name(), mode, res));
    this.step.set('done');
  }

  protected cancel(): void {
    this.abort?.abort();
  }

  protected downloadMissing(): void {
    const res = this.result();
    if (!res?.missing.length) return;
    const base = (this.committed()?.playlistName || this.name() || 'import').replace(/[\\/:*?"<>|]/g, ' ').trim();
    saveTextFile(`${base} - missing tracks.csv`, generateMissingCSV(res.missing), 'text/csv');
  }

  protected openPlaylist(): void {
    const id = this.committed()?.playlistId;
    this.ui.closeImport();
    if (id) void this.router.navigate(['/music/library/playlist', id]);
  }

  protected another(): void {
    this.reset();
  }

  protected close(): void {
    this.ui.closeImport();
  }

  protected rowLabel(r: { title: string; artist: string; type: string }): string {
    if (r.type === 'artist') return r.artist;
    return r.artist ? `${r.title} - ${r.artist}` : r.title;
  }

  private reset(): void {
    this.abort?.abort();
    this.abort = null;
    this.step.set('pick');
    this.parsed.set(null);
    this.result.set(null);
    this.committed.set(null);
    this.error.set('');
    this.name.set('');
    this.fileName.set('');
    this.progress.set({ done: 0, total: 0, current: '' });
  }
}
