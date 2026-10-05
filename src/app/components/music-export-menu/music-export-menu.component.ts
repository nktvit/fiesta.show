import { Component, computed, ElementRef, HostListener, inject, input, signal, viewChild } from '@angular/core';
import { MusicToastService } from '../../services/music-toast.service';
import { MusicTrack } from '../../services/music.service';
import {
  generateFullCSV, generateJSON, generateM3U, generateM3U8, generateXSPF, PlaylistFileMeta, playlistFileName, saveTextFile,
} from '../../utils/music-playlist-files';
import { buildShareUrl } from '../../utils/music-share';

/** What the menu needs of a playlist: a UserPlaylist fits, so does any named list of tracks. */
export interface ExportablePlaylist {
  name: string;
  description?: string;
  cover?: string;
  tracks: MusicTrack[];
}

interface ExportFormat {
  id: string;
  label: string;
  ext: string;
  mime: string;
  build: (meta: PlaylistFileMeta, tracks: MusicTrack[]) => string;
}

const FORMATS: ExportFormat[] = [
  { id: 'csv', label: 'CSV', ext: 'csv', mime: 'text/csv', build: generateFullCSV },
  { id: 'json', label: 'JSON', ext: 'json', mime: 'application/json', build: generateJSON },
  { id: 'xspf', label: 'XSPF', ext: 'xspf', mime: 'application/xspf+xml', build: generateXSPF },
  { id: 'm3u', label: 'M3U', ext: 'm3u', mime: 'audio/x-mpegurl', build: (m, t) => generateM3U(m, t) },
  { id: 'm3u8', label: 'M3U8', ext: 'm3u8', mime: 'application/vnd.apple.mpegurl', build: (m, t) => generateM3U8(m, t) },
];

/**
 * "Export" button with a menu of file formats (and a share link) for one
 * playlist. Owned by package P7.
 *
 *   <app-music-export-menu [playlist]="p" />
 */
@Component({
  selector: 'app-music-export-menu',
  templateUrl: './music-export-menu.component.html',
  host: { class: 'relative inline-block' },
})
export class MusicExportMenuComponent {
  readonly playlist = input.required<ExportablePlaylist>();

  private toast = inject(MusicToastService);
  private host = inject<ElementRef<HTMLElement>>(ElementRef);
  protected readonly trigger = viewChild<ElementRef<HTMLButtonElement>>('trigger');
  protected readonly open = signal(false);
  protected readonly formats = FORMATS;
  protected readonly empty = computed(() => this.playlist().tracks.length === 0);

  protected toggle(): void {
    this.open.update((v) => !v);
    if (this.open()) setTimeout(() => this.items()[0]?.focus());
  }

  protected close(refocus = true): void {
    if (!this.open()) return;
    this.open.set(false);
    if (refocus) this.trigger()?.nativeElement.focus();
  }

  protected download(f: ExportFormat): void {
    const p = this.playlist();
    const meta: PlaylistFileMeta = { title: p.name, description: p.description, cover: p.cover };
    const name = playlistFileName(p.name, f.ext);
    if (saveTextFile(name, f.build(meta, p.tracks), f.mime)) this.toast.show({ message: `Exported ${name}` });
    else this.toast.show({ message: 'Could not export this playlist', tone: 'warn' });
    this.close();
  }

  protected async share(): Promise<void> {
    const p = this.playlist();
    this.close();
    try {
      const url = await buildShareUrl({ name: p.name, description: p.description, tracks: p.tracks });
      await navigator.clipboard.writeText(url);
      this.toast.show({ message: p.tracks.length > 500 ? 'Link copied (first 500 tracks)' : 'Share link copied' });
    } catch {
      this.toast.show({ message: 'Could not copy the link', tone: 'warn' });
    }
  }

  protected onMenuKeydown(e: KeyboardEvent): void {
    const items = this.items();
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      items[(i + 1) % items.length]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      items[(i - 1 + items.length) % items.length]?.focus();
    } else if (e.key === 'Tab') {
      this.close(false);
    }
  }

  /** Escape closes from the menu or from the button (the dialog shells use the same rule). */
  @HostListener('keydown.escape', ['$event'])
  protected onEscape(e: Event): void {
    if (!this.open()) return;
    e.stopPropagation();
    this.close();
  }

  @HostListener('document:pointerdown', ['$event'])
  protected onOutside(e: Event): void {
    if (this.open() && !this.host.nativeElement.contains(e.target as Node)) this.close(false);
  }

  private items(): HTMLElement[] {
    return Array.from(this.host.nativeElement.querySelectorAll<HTMLElement>('[role="menuitem"]'));
  }
}
