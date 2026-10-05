import { fakeAsync, TestBed, tick } from '@angular/core/testing';
import { musicStorage } from '../utils/music-storage';
import { MUSIC_SETTINGS_DEFAULTS, MusicSettingsService } from './music-settings.service';

describe('MusicSettingsService', () => {
  const clean = () => musicStorage.keys().forEach((k) => musicStorage.remove(k));
  beforeEach(() => {
    clean();
    TestBed.resetTestingModule();
  });
  afterEach(clean);

  const make = () => TestBed.inject(MusicSettingsService);

  it('starts from the defaults', () => {
    const s = make();
    expect(s.snapshot()).toEqual(MUSIC_SETTINGS_DEFAULTS as never);
    expect(s.volume()).toBe(1);
    expect(s.repeat()).toBe('off');
    expect(s.quality()).toBe('auto');
    expect(s.homeSections().picks).toBeTrue();
    expect(s.panelWidth()).toBe(380);
  });

  it('persists changes under fiesta:music:settings (debounced)', fakeAsync(() => {
    const s = make();
    s.volume.set(0.3);
    s.repeat.set('one');
    expect(musicStorage.read<Record<string, unknown> | null>('settings', null)).toBeNull();
    tick(300);
    const stored = musicStorage.read<Record<string, unknown>>('settings', {});
    expect(stored['volume']).toBe(0.3);
    expect(stored['repeat']).toBe('one');
  }));

  it('loads stored values and ignores invalid ones', () => {
    musicStorage.write('settings', { volume: 0.5, repeat: 'sideways', quality: 'LOSSLESS', panelWidth: 9999, muted: 'yes' });
    const s = make();
    expect(s.volume()).toBe(0.5);
    expect(s.repeat()).toBe('off');
    expect(s.quality()).toBe('LOSSLESS');
    expect(s.panelWidth()).toBe(640);
    expect(s.muted()).toBeFalse();
  });

  it('rejects invalid sets and clamps numbers', () => {
    const s = make();
    s.repeat.set('bogus' as never);
    expect(s.repeat()).toBe('off');
    s.volume.set(4);
    expect(s.volume()).toBe(1);
    s.volume.update((v) => v - 0.25);
    expect(s.volume()).toBe(0.75);
  });

  it('reset() restores defaults; restore() applies a backup', fakeAsync(() => {
    const s = make();
    s.gapless.set(false);
    s.homeSections.set({ ...s.homeSections(), mixes: false });
    s.reset();
    expect(s.gapless()).toBeTrue();
    expect(s.homeSections().mixes).toBeTrue();
    s.restore({ crossfadeSeconds: 5, autoplay: true });
    expect(s.crossfadeSeconds()).toBe(5);
    expect(s.autoplay()).toBeTrue();
    tick(300);
    expect(musicStorage.read<Record<string, unknown>>('settings', {})['crossfadeSeconds']).toBe(5);
  }));

  it('scoped() persists each value at its own key and reuses the signal', () => {
    const s = make();
    const a = s.scoped('test-scope', { on: false });
    a.set({ on: true });
    expect(musicStorage.read<unknown>('test-scope', null)).toEqual({ on: true });
    expect(s.scoped('test-scope', { on: false })).toBe(a);
    a.update((v) => ({ on: !v.on }));
    expect(musicStorage.read<unknown>('test-scope', null)).toEqual({ on: false });
  });
});
