import { Component, computed, effect, inject, input, model, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MusicLibraryService } from '../../services/music-library.service';
import { MusicToastService } from '../../services/music-toast.service';
import { UserPlaylist } from '../../services/music.service';
import { buildCollage, imageFileToCover } from '../../utils/music-collage';
import { distinctCovers } from '../../utils/music-library-sort';
import { MusicDialogComponent } from '../music-dialog/music-dialog.component';

/** True for an http(s) URL or an image data URL; blank is fine (no custom cover). */
export function isValidCoverUrl(v: string): boolean {
  const s = v.trim();
  if (!s) return true;
  if (/^data:image\/(png|jpe?g|webp|gif);base64,/i.test(s)) return true;
  try {
    const u = new URL(s);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

/**
 * Dialog to create (playlist = null) or edit a user playlist: name (required),
 * description, cover URL or uploaded image (downscaled data URL <= 100 KB) or
 * the 2x2 collage of its first covers.
 */
@Component({
  selector: 'app-music-playlist-editor',
  imports: [MusicDialogComponent, FormsModule],
  templateUrl: './music-playlist-editor.component.html',
})
export class MusicPlaylistEditorComponent {
  readonly playlist = input<UserPlaylist | null>(null);
  readonly open = model(false);
  /** Folder a newly created playlist goes into. */
  readonly folderId = input<string | null>(null);
  /** Emits the playlist id after Save. */
  readonly saved = output<string>();

  private library = inject(MusicLibraryService);
  private toast = inject(MusicToastService);

  protected name = '';
  protected description = '';
  protected readonly cover = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly touched = signal(false);
  protected readonly nameValue = signal('');

  protected readonly editing = computed(() => this.playlist() !== null);
  protected readonly coverIsData = computed(() => this.cover().startsWith('data:'));
  protected readonly canCollage = computed(() => distinctCovers(this.playlist()?.tracks ?? []).length >= 4);

  constructor() {
    effect(() => {
      if (!this.open()) return;
      const p = this.playlist();
      this.name = p?.name ?? '';
      this.nameValue.set(this.name);
      this.description = p?.description ?? '';
      this.cover.set(p?.cover ?? '');
      this.error.set('');
      this.touched.set(false);
      this.busy.set(false);
    });
  }

  protected onName(v: string): void {
    this.name = v;
    this.nameValue.set(v);
  }

  protected setCoverUrl(v: string): void {
    this.cover.set(v.trim());
    this.error.set(isValidCoverUrl(v) ? '' : 'Enter a valid image URL (https://...).');
  }

  protected async onFile(e: Event): Promise<void> {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    this.busy.set(true);
    try {
      this.cover.set(await imageFileToCover(file));
      this.error.set('');
    } catch {
      this.error.set("That file couldn't be used as a cover. Try another image.");
    } finally {
      this.busy.set(false);
    }
  }

  protected async useCollage(): Promise<void> {
    const p = this.playlist();
    if (!p) return;
    this.busy.set(true);
    try {
      const url = await buildCollage(distinctCovers(p.tracks));
      if (url) {
        this.cover.set(url);
        this.error.set('');
      } else {
        this.error.set("Couldn't build a collage. The playlist keeps its automatic cover.");
      }
    } finally {
      this.busy.set(false);
    }
  }

  protected save(): void {
    this.touched.set(true);
    const name = this.name.trim();
    if (!name || this.busy() || !isValidCoverUrl(this.cover())) return;
    const p = this.playlist();
    const cover = this.cover().trim() || undefined;
    let id: string;
    if (p) {
      this.library.updatePlaylist(p.id, { name, description: this.description.trim(), cover });
      id = p.id;
      this.toast.show({ message: 'Playlist saved' });
    } else {
      const created = this.library.createPlaylist(name, [], this.description.trim());
      if (cover) this.library.updatePlaylist(created.id, { cover });
      if (this.folderId()) this.library.movePlaylistToFolder(created.id, this.folderId());
      id = created.id;
    }
    this.open.set(false);
    this.saved.emit(id);
  }
}
