import { TestBed } from '@angular/core/testing';
import { musicStorage } from '../utils/music-storage';
import { MusicBackupService } from './music-backup.service';
import { MusicLibraryService } from './music-library.service';
import { MusicSettingsService } from './music-settings.service';
import { MusicTrack } from './music.service';

const t = (id: number): MusicTrack => ({
  id, title: 't' + id, artist: 'a', artistId: 1, album: 'x', albumId: 1, cover: '', duration: 10, explicit: false, trackNumber: 1, quality: '',
});

function clearAll(): void {
  for (const k of musicStorage.keys()) musicStorage.remove(k);
}

describe('MusicBackupService', () => {
  let backup: MusicBackupService;
  let library: MusicLibraryService;

  beforeEach(() => {
    clearAll();
    TestBed.configureTestingModule({});
    backup = TestBed.inject(MusicBackupService);
    library = TestBed.inject(MusicLibraryService);
  });
  afterEach(clearAll);

  it('snapshot holds every music key except secrets', () => {
    library.createPlaylist('Mine', [t(1)]);
    musicStorage.write('settings', { volume: 0.4 });
    musicStorage.write('secret:lastfm', { token: 'nope' });
    musicStorage.write('custom-thing', [1]);
    const snap = backup.snapshot();
    expect(snap.app).toBe('fiesta-music');
    expect(snap.version).toBe(1);
    expect(Object.keys(snap.keys).sort()).toEqual(['custom-thing', 'library', 'settings']);
    expect(JSON.stringify(snap)).not.toContain('nope');
  });

  it('file name carries the date', () => {
    expect(backup.backupFileName()).toMatch(/^fiesta-music-backup-\d{4}-\d{2}-\d{2}\.json$/);
    expect(backup.backupFileName(true)).toMatch(/^fiesta-music-settings-\d{4}-\d{2}-\d{2}\.json$/);
  });

  it('parse validates and drops secret keys', () => {
    expect(() => backup.parse('nope')).toThrowError(/valid JSON/);
    expect(() => backup.parse('{"app":"other","keys":{}}')).toThrowError(/not a Fiesta/);
    expect(() => backup.parse('{"app":"fiesta-music","version":9,"keys":{}}')).toThrowError(/newer/);
    const ok = backup.parse('{"app":"fiesta-music","version":1,"keys":{"settings":{},"secret:x":{"a":1}}}');
    expect(Object.keys(ok.keys)).toEqual(['settings']);
  });

  it('restore merge keeps existing playlists and adds new ones; existing settings win', () => {
    const mine = library.createPlaylist('Mine', [t(1)]);
    musicStorage.write('settings', { volume: 0.4 });
    const snap = backup.snapshot();
    // Another device's backup: a different playlist and different settings.
    const other = { ...snap, keys: {
      library: { favorites: {}, playlists: [{ id: 'other', name: 'Other', description: '', tracks: [], createdAt: 1, updatedAt: 1 }], folders: [], pins: [] },
      settings: { volume: 0.9, theme: 'x' },
    } };
    backup.restore(backup.parse(JSON.stringify(other)), 'merge');
    expect(library.playlists().map((p) => p.id).sort()).toEqual([mine.id, 'other'].sort());
    expect(musicStorage.read<Record<string, unknown>>('settings', {})).toEqual({ volume: 0.4, theme: 'x' });
  });

  it('restore replace overwrites everything but secrets', () => {
    library.createPlaylist('Mine', [t(1)]);
    musicStorage.write('custom-thing', 1);
    musicStorage.write('secret:lastfm', { token: 'keep' });
    const incoming = { app: 'fiesta-music', version: 1, exportedAt: '', keys: {
      library: { favorites: {}, playlists: [{ id: 'only', name: 'Only', description: '', tracks: [], createdAt: 1, updatedAt: 1 }], folders: [], pins: [] },
    } };
    backup.restore(backup.parse(JSON.stringify(incoming)), 'replace');
    expect(library.playlists().map((p) => p.id)).toEqual(['only']);
    expect(musicStorage.read<unknown>('custom-thing', null)).toBeNull();
    expect(musicStorage.read<unknown>('secret:lastfm', null)).toEqual({ token: 'keep' });
  });

  it('settings export excludes library keys; import overwrites', () => {
    library.createPlaylist('Mine', [t(1)]);
    musicStorage.write('settings', { volume: 0.4 });
    expect(Object.keys(backup.settingsSnapshot().keys)).toEqual(['settings']);
    const n = backup.importSettings({ app: 'fiesta-music', version: 1, exportedAt: '', keys: { settings: { volume: 1 }, library: {} } });
    expect(n).toBe(1);
    expect(musicStorage.read<unknown>('settings', null)).toEqual({ volume: 1 });
    expect(library.playlists().length).toBe(1);
  });

  it('settings import also updates the live settings (so the page-hide flush cannot undo it)', () => {
    const settings = TestBed.inject(MusicSettingsService);
    settings.reduceBlur.set(false);
    backup.importSettings({ app: 'fiesta-music', version: 1, exportedAt: '', keys: { settings: { reduceBlur: true } } });
    expect(settings.reduceBlur()).toBeTrue();
    settings.reduceBlur.set(false);
  });

  it('reset clears every music key', async () => {
    musicStorage.write('settings', {});
    musicStorage.write('secret:x', 1);
    await backup.reset();
    expect(musicStorage.keys()).toEqual([]);
  });
});
