import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { MusicSettingRowComponent } from '../../../../components/music-setting-row/music-setting-row.component';
import { MusicDownloadService } from '../../../../services/music-download.service';
import { MusicToastService } from '../../../../services/music-toast.service';
import { DownloadBulkMode, DownloadLyricsSidecar, DownloadQuality, DownloadSidecars, MusicDownloadPrefs } from '../../../../utils/music-download-prefs';
import { DOWNLOAD_TEMPLATE_TOKENS, previewTemplate } from '../../../../utils/music-download-template';
import { folderName, folderWriterSupported, forgetDownloadFolder, pickDownloadFolder } from '../../../../utils/music-download-writer';

type SidecarKey = keyof DownloadSidecars;

/** Music settings: Downloads section. Owned by package P12. */
@Component({
  selector: 'app-music-settings-downloads',
  imports: [MusicSettingRowComponent],
  templateUrl: './music-settings-downloads.component.html',
  host: { class: 'block' },
})
export class MusicSettingsDownloadsComponent implements OnInit {
  protected readonly downloads = inject(MusicDownloadService);
  private readonly toast = inject(MusicToastService);

  protected readonly tokens = DOWNLOAD_TEMPLATE_TOKENS;
  protected readonly folderSupported = folderWriterSupported();
  protected readonly folder = signal('');
  protected readonly prefs = computed<MusicDownloadPrefs>(() => {
    this.downloads.prefs(); // track changes
    return this.downloads.currentPrefs();
  });
  protected readonly trackPreview = computed(() => previewTemplate(this.prefs().trackTemplate));
  protected readonly bulkPreview = computed(() => previewTemplate(this.prefs().bulkTemplate));

  protected readonly qualities: { id: DownloadQuality; label: string; hint: string }[] = [
    { id: 'LOSSLESS', label: 'Lossless', hint: 'FLAC, the original quality' },
    { id: 'HIGH', label: 'High', hint: 'AAC 320 kbps (.m4a)' },
    { id: 'LOW', label: 'Low', hint: 'AAC 96 kbps (.m4a)' },
  ];
  protected readonly sidecarRows: { id: SidecarKey; label: string; hint: string }[] = [
    { id: 'cover', label: 'cover.jpg', hint: 'The album cover next to the tracks.' },
    { id: 'm3u8', label: 'Playlist (.m3u8)', hint: 'Track order, for players that read playlists.' },
    { id: 'cue', label: 'Cue sheet (.cue)', hint: 'A CUE file for the album.' },
    { id: 'nfo', label: 'Info file (.nfo)', hint: 'A text summary of the tracks.' },
    { id: 'json', label: 'Metadata (.json)', hint: 'Every track as JSON.' },
  ];

  protected qualityHint(): string {
    return this.qualities.find((q) => q.id === this.prefs().quality)?.hint ?? '';
  }

  ngOnInit(): void {
    void folderName().then((n) => this.folder.set(n));
  }

  protected setQuality(q: DownloadQuality): void {
    this.downloads.setPrefs({ quality: q });
  }

  protected setTemplate(key: 'trackTemplate' | 'bulkTemplate', value: string): void {
    if (value.trim()) this.downloads.setPrefs({ [key]: value.trim() });
  }

  protected setSidecar(key: SidecarKey, on: boolean): void {
    this.downloads.setPrefs({ sidecars: { [key]: on } });
  }

  protected setLyricsSidecar(v: string): void {
    this.downloads.setPrefs({ lyricsSidecar: v as DownloadLyricsSidecar });
  }

  protected setBulkMode(m: DownloadBulkMode): void {
    this.downloads.setPrefs({ bulkMode: m });
  }

  protected setFlag(key: 'embedLyrics' | 'embedCover' | 'saveToFolder', on: boolean): void {
    this.downloads.setPrefs({ [key]: on });
  }

  protected async chooseFolder(): Promise<void> {
    const dir = await pickDownloadFolder();
    if (!dir) return;
    this.folder.set(dir.name);
    this.downloads.setPrefs({ saveToFolder: true });
    this.toast.show({ message: `Saving to the folder "${dir.name}"` });
  }

  protected async clearFolder(): Promise<void> {
    await forgetDownloadFolder();
    this.folder.set('');
    this.downloads.setPrefs({ saveToFolder: false });
  }
}
