import { Component, computed, inject, signal } from '@angular/core';
import { MusicDialogComponent } from '../../../../components/music-dialog/music-dialog.component';
import { MusicBackupFile, MusicBackupService, RestoreMode } from '../../../../services/music-backup.service';
import { MusicLibraryService } from '../../../../services/music-library.service';
import { MusicToastService } from '../../../../services/music-toast.service';
import { MusicUiService } from '../../../../services/music-ui.service';

interface Confirm {
  title: string;
  body: string;
  label: string;
  run: () => void | Promise<void>;
}

type FilePurpose = 'restore' | 'settings';

/** Music settings: Data section (backup/restore, settings export/import, import wizard, blocked items, reset). Owned by package P7. */
@Component({
  selector: 'app-music-settings-data',
  imports: [MusicDialogComponent],
  templateUrl: './music-settings-data.component.html',
  host: { class: 'block' },
})
export class MusicSettingsDataComponent {
  private backup = inject(MusicBackupService);
  private library = inject(MusicLibraryService);
  private toast = inject(MusicToastService);
  protected readonly ui = inject(MusicUiService);

  protected readonly blocked = this.library.blocked;
  protected readonly blockedCount = computed(() => {
    const b = this.blocked();
    return b.tracks.length + b.albums.length + b.artists.length;
  });
  protected readonly mode = signal<RestoreMode>('merge');
  protected readonly status = signal('');
  protected readonly statusTone = signal<'info' | 'warn'>('info');
  protected readonly confirm = signal<Confirm | null>(null);
  protected readonly busy = signal(false);

  protected setMode(m: RestoreMode): void {
    this.mode.set(m);
  }

  protected backUp(): void {
    const name = this.backup.download(false);
    this.say(`Saved ${name}`);
  }

  protected exportSettings(): void {
    const name = this.backup.download(true);
    this.say(`Saved ${name}`);
  }

  protected async onFile(e: Event, purpose: FilePurpose): Promise<void> {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    let parsed: MusicBackupFile;
    try {
      parsed = this.backup.parse(await file.text());
    } catch (err) {
      this.say(err instanceof Error ? err.message : 'Could not read that file.', 'warn');
      return;
    }
    if (purpose === 'settings') {
      const n = this.backup.importSettings(parsed);
      this.say(`Imported ${n} ${n === 1 ? 'setting group' : 'setting groups'}. Reloading...`);
      this.reloadSoon();
      return;
    }
    const mode = this.mode();
    const apply = () => {
      const r = this.backup.restore(parsed, mode);
      this.say(`Restored (${mode}): ${r.playlists} ${r.playlists === 1 ? 'playlist' : 'playlists'} in the file. Reloading...`);
      this.reloadSoon();
    };
    if (mode === 'replace') {
      this.confirm.set({
        title: 'Replace your music data?',
        body: 'Everything stored for music on this device (library, playlists, history, settings) is overwritten with the contents of the file. This cannot be undone.',
        label: 'Replace',
        run: apply,
      });
    } else {
      apply();
    }
  }

  protected unblock(kind: 'track' | 'album' | 'artist', id: number): void {
    this.library.unblock(kind, id);
  }

  protected askReset(): void {
    this.confirm.set({
      title: 'Reset music data?',
      body: 'This clears your library, playlists, history, settings, sign-ins and offline data for music on this device, then reloads the page. Download a backup first if you want to keep anything.',
      label: 'Reset everything',
      run: async () => {
        this.busy.set(true);
        await this.backup.reset();
        this.reloadSoon(0);
      },
    });
  }

  protected async runConfirm(): Promise<void> {
    const c = this.confirm();
    this.confirm.set(null);
    await c?.run();
  }

  protected onConfirmOpen(open: boolean): void {
    if (!open) this.confirm.set(null);
  }

  private say(message: string, tone: 'info' | 'warn' = 'info'): void {
    this.status.set(message);
    this.statusTone.set(tone);
    this.toast.show({ message, tone });
  }

  private reloadSoon(ms = 900): void {
    if (typeof location === 'undefined') return;
    setTimeout(() => location.reload(), ms);
  }
}
