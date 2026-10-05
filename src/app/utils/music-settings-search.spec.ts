import { MUSIC_SETTINGS_REGISTRY } from '../services/music-settings-registry';
import { searchSettings } from './music-settings-search';

describe('searchSettings', () => {
  it('returns nothing for an empty query', () => {
    expect(searchSettings(MUSIC_SETTINGS_REGISTRY, '  ')).toEqual([]);
  });

  it('finds crossfade by label and ranks it first', () => {
    expect(searchSettings(MUSIC_SETTINGS_REGISTRY, 'crossf')[0].id).toBe('crossfadeSeconds');
  });

  it('finds by keyword', () => {
    expect(searchSettings(MUSIC_SETTINGS_REGISTRY, 'last.fm').some((e) => e.tab === 'scrobbling')).toBeTrue();
    expect(searchSettings(MUSIC_SETTINGS_REGISTRY, 'vibration')[0].id).toBe('haptics');
  });

  it('requires every word to match', () => {
    expect(searchSettings(MUSIC_SETTINGS_REGISTRY, 'crossfade zzzz')).toEqual([]);
  });

  it('respects the limit', () => {
    expect(searchSettings(MUSIC_SETTINGS_REGISTRY, 'a', 3).length).toBeLessThanOrEqual(3);
  });
});
