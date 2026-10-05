import { Component, computed, inject } from '@angular/core';
import { MusicLyricsPrefs, MusicLyricsService } from '../../../../services/music-lyrics.service';
import { MUSIC_LYRICS_LANGUAGES } from '../../../../utils/music-lyrics-languages';
import { MUSIC_LYRICS_PROVIDERS } from '../../../../utils/music-lyrics-providers';

type ToggleKey = 'romanize' | 'translate' | 'blur' | 'hidePlayed' | 'karaoke';

/** Music settings: Lyrics section (providers, defaults, display). Owned by package P3. */
@Component({
  selector: 'app-music-settings-lyrics',
  templateUrl: './music-settings-lyrics.component.html',
  host: { class: 'block' },
})
export class MusicSettingsLyricsComponent {
  private readonly lyrics = inject(MusicLyricsService);

  protected readonly providers = MUSIC_LYRICS_PROVIDERS;
  protected readonly languages = MUSIC_LYRICS_LANGUAGES;
  protected readonly prefs = computed<MusicLyricsPrefs>(() => {
    this.lyrics.prefs(); // track changes
    return this.lyrics.currentPrefs();
  });

  protected providerOn(id: string): boolean {
    return this.prefs().providers[id as keyof MusicLyricsPrefs['providers']] ?? true;
  }

  protected setProvider(id: string, on: boolean): void {
    this.lyrics.setPrefs({ providers: { [id]: on } });
  }

  protected set(key: ToggleKey, on: boolean): void {
    this.lyrics.setPrefs({ [key]: on });
  }

  protected setLanguage(code: string): void {
    this.lyrics.setPrefs({ targetLang: code });
  }
}
