import { MUSIC_SETTINGS_DEFAULTS, MusicSettingsTab } from './music-settings.service';
import { MUSIC_SETTINGS_REGISTRY } from './music-settings-registry';

const TABS: MusicSettingsTab[] = ['playback', 'audio', 'lyrics', 'interface', 'shortcuts', 'downloads', 'scrobbling', 'data', 'system'];

describe('MUSIC_SETTINGS_REGISTRY', () => {
  it('has unique ids', () => {
    const ids = MUSIC_SETTINGS_REGISTRY.map((x) => x.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('only uses valid tabs and has labels and keywords', () => {
    for (const x of MUSIC_SETTINGS_REGISTRY) {
      expect(TABS).toContain(x.tab);
      expect(x.label.length).toBeGreaterThan(0);
      expect(x.keywords.length).toBeGreaterThan(0);
    }
  });

  it('covers every typed setting (home sections as home-*; lastSettingsTab is internal)', () => {
    const ids = new Set(MUSIC_SETTINGS_REGISTRY.map((x) => x.id));
    for (const key of Object.keys(MUSIC_SETTINGS_DEFAULTS)) {
      if (key === 'lastSettingsTab') continue;
      if (key === 'homeSections') {
        for (const k of Object.keys(MUSIC_SETTINGS_DEFAULTS.homeSections)) expect(ids.has('home-' + k)).withContext(k).toBeTrue();
        continue;
      }
      expect(ids.has(key)).withContext(key).toBeTrue();
    }
  });

  it('covers the scoped areas on their tabs', () => {
    const tabOf = (id: string) => MUSIC_SETTINGS_REGISTRY.find((x) => x.id === id)?.tab;
    expect(tabOf('eq')).toBe('audio');
    expect(tabOf('dsp')).toBe('audio');
    expect(tabOf('lyrics')).toBe('lyrics');
    expect(tabOf('shortcuts')).toBe('shortcuts');
    expect(tabOf('downloads')).toBe('downloads');
    expect(tabOf('scrobbling')).toBe('scrobbling');
    expect(tabOf('data')).toBe('data');
    expect(tabOf('visualizerEnabled')).toBe('audio');
  });

  it('every tab has at least one entry', () => {
    for (const t of TABS) expect(MUSIC_SETTINGS_REGISTRY.some((x) => x.tab === t)).withContext(t).toBeTrue();
  });
});
