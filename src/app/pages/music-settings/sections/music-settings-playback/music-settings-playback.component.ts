import { Component, inject } from '@angular/core';
import { MusicSettingRowComponent } from '../../../../components/music-setting-row/music-setting-row.component';
import { supportsElementVolume } from '../../../../services/music-crossfade';
import { MusicQualitySetting, MusicReplayGainMode, MusicSettingsService } from '../../../../services/music-settings.service';

/** Music settings: Playback section. Owned by package P11. */
@Component({
  selector: 'app-music-settings-playback',
  imports: [MusicSettingRowComponent],
  templateUrl: './music-settings-playback.component.html',
  host: { class: 'block' },
})
export class MusicSettingsPlaybackComponent {
  protected readonly settings = inject(MusicSettingsService);
  protected readonly canCrossfade = supportsElementVolume();

  protected readonly qualities: { value: MusicQualitySetting; label: string }[] = [
    { value: 'auto', label: 'Auto' },
    { value: 'LOW', label: 'Low' },
    { value: 'HIGH', label: 'High' },
    { value: 'LOSSLESS', label: 'Lossless' },
    { value: 'HI_RES_LOSSLESS', label: 'Hi-Res' },
  ];
  protected readonly gainModes: { value: MusicReplayGainMode; label: string }[] = [
    { value: 'off', label: 'Off' },
    { value: 'track', label: 'Track' },
    { value: 'album', label: 'Album' },
  ];
  protected readonly speeds = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

  protected num(e: Event): number {
    return Number((e.target as HTMLInputElement | HTMLSelectElement).value);
  }

  protected setQuality(e: Event): void {
    const v = (e.target as HTMLSelectElement).value;
    const found = this.qualities.find((q) => q.value === v);
    if (found) this.settings.quality.set(found.value);
  }

  protected signed(n: number): string {
    return (n > 0 ? '+' : '') + n + ' dB';
  }
}
