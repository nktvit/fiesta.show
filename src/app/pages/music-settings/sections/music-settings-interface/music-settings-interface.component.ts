import { Component, inject } from '@angular/core';
import { MusicSettingRowComponent } from '../../../../components/music-setting-row/music-setting-row.component';
import { MusicHomeSections, MusicSettings, MusicSettingsService } from '../../../../services/music-settings.service';

type ToggleKey =
  | 'closeOverlaysOnNavigate' | 'backClosesOverlays' | 'reduceBlur' | 'dynamicColor' | 'albumBackground'
  | 'compactGrids' | 'haptics' | 'coverTilt' | 'coverRound' | 'nowPlayingLyrics' | 'waveformSeekbar';

interface Toggle { key: ToggleKey; label: string; description: string }

/** Music settings: Interface section. Owned by package P11. */
@Component({
  selector: 'app-music-settings-interface',
  imports: [MusicSettingRowComponent],
  templateUrl: './music-settings-interface.component.html',
  host: { class: 'block' },
})
export class MusicSettingsInterfaceComponent {
  protected readonly settings = inject(MusicSettingsService);

  protected readonly navigation: Toggle[] = [
    { key: 'closeOverlaysOnNavigate', label: 'Close overlays on navigation', description: 'Close Now Playing and side panels when you open another page.' },
    { key: 'backClosesOverlays', label: 'Back closes overlays', description: 'The browser Back button closes an open overlay instead of leaving the page.' },
  ];
  protected readonly appearance: Toggle[] = [
    { key: 'reduceBlur', label: 'Reduce blur', description: 'Use solid panels instead of frosted glass. Helps on slower devices.' },
    { key: 'dynamicColor', label: 'Dynamic colour', description: 'Tint Now Playing with the colours of the current cover.' },
    { key: 'albumBackground', label: 'Album background', description: 'Show the blurred cover behind Now Playing.' },
    { key: 'compactGrids', label: 'Compact grids', description: 'Fit more covers on screen.' },
    { key: 'coverRound', label: 'Rounded cover', description: 'Round the corners of the big cover in Now Playing.' },
    { key: 'coverTilt', label: 'Cover tilt', description: 'The big cover leans towards your pointer.' },
    { key: 'haptics', label: 'Haptics', description: 'Short vibrations on supported phones when you tap player controls.' },
    { key: 'nowPlayingLyrics', label: 'Show lyrics in Now Playing', description: 'Open Now Playing with lyrics visible by default.' },
    { key: 'waveformSeekbar', label: 'Waveform seek bar', description: 'Draw the track waveform behind the seek bar.', },
  ];
  protected readonly homeSections: { key: keyof MusicHomeSections; label: string }[] = [
    { key: 'jumpBackIn', label: 'Jump back in' },
    { key: 'recent', label: 'Recently played' },
    { key: 'mixes', label: 'Your mixes' },
    { key: 'forYou', label: 'Made for you' },
    { key: 'playlists', label: 'Playlists' },
    { key: 'picks', label: 'Editor picks' },
  ];

  protected get(key: ToggleKey): boolean {
    return (this.settings[key] as () => boolean)();
  }

  protected set(key: ToggleKey, on: boolean): void {
    (this.settings[key] as { set(v: MusicSettings[ToggleKey]): void }).set(on);
  }

  protected setCoverClick(e: Event): void {
    const v = (e.target as HTMLSelectElement).value;
    if (v === 'nowPlaying' || v === 'album') this.settings.coverClickAction.set(v);
  }

  protected setHome(key: keyof MusicHomeSections, on: boolean): void {
    this.settings.homeSections.set({ ...this.settings.homeSections(), [key]: on });
  }
}
