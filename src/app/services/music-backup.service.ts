import { inject, Injectable, Injector } from '@angular/core';
import { musicStorage } from '../utils/music-storage';
import { saveTextFile } from '../utils/music-playlist-files';
import { MusicLibrarySnapshot, MusicLibraryService } from './music-library.service';
import { MusicPlayerService } from './music-player.service';
import { MusicSettingsService } from './music-settings.service';

export const BACKUP_APP = 'fiesta-music';
export const BACKUP_VERSION = 1;

/** The relative storage keys MusicLibraryService owns. */
const LIBRARY_KEYS = ['library', 'history', 'search-history', 'activity', 'blocked'] as const;
const SETTINGS_KEY = 'settings';
/** IndexedDB names used when `indexedDB.databases()` is unavailable (Firefox < 126, older Safari). */
const FALLBACK_DBS = [
  'fiesta-music-downloads', 'fiesta-music-lyrics', 'fiesta-music-waveform', 'fiesta-music-autoeq',
  // Reserved names (no package opens them yet); deleting a missing database is harmless.
  'fiesta-music-waveforms', 'fiesta-music-cache', 'fiesta-music-covers',
];

export interface MusicBackupFile {
  app: typeof BACKUP_APP;
  version: typeof BACKUP_VERSION;
  exportedAt: string;
  /** Relative key (without 'fiesta:music:') -> stored JSON value. */
  keys: Record<string, unknown>;
}

export type RestoreMode = 'merge' | 'replace';

export interface RestoreSummary {
  keys: number;
  playlists: number;
}

function stamp(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Library backup, restore, settings export/import and reset. A backup holds
 * every `fiesta:music:*` key except credentials (`fiesta:music:secret:*`).
 */
@Injectable({ providedIn: 'root' })
export class MusicBackupService {
  private library = inject(MusicLibraryService);
  private settings = inject(MusicSettingsService);
  private injector = inject(Injector);

  /**
   * Pushes imported setting values into the live settings signals. The settings
   * service writes its in-memory state back to storage when the page hides, so
   * a value written to storage alone would be overwritten by the reload.
   */
  private applySettings(values: Record<string, unknown>): void {
    const bag = this.settings as unknown as Record<string, (() => unknown) & { set?: (v: unknown) => void }>;
    for (const [k, v] of Object.entries(values)) {
      const sig = bag[k];
      if (typeof sig === 'function' && typeof sig.set === 'function') sig.set(v);
    }
  }

  /** The player also persists its queue on page hide, which would undo a reset or replace. */
  private stopPlayer(): void {
    try {
      this.injector.get(MusicPlayerService).stop();
    } catch {
      // no player (tests, SSR): nothing to stop
    }
  }

  /** What a backup contains right now. Secrets are never included. */
  snapshot(filter: (key: string) => boolean = () => true): MusicBackupFile {
    const keys: Record<string, unknown> = {};
    for (const key of musicStorage.keys()) {
      if (musicStorage.isSecret(key) || !filter(key)) continue;
      const v = musicStorage.read<unknown>(key, undefined);
      if (v !== undefined) keys[key] = v;
    }
    return { app: BACKUP_APP, version: BACKUP_VERSION, exportedAt: new Date().toISOString(), keys };
  }

  settingsSnapshot(): MusicBackupFile {
    return this.snapshot((k) => !(LIBRARY_KEYS as readonly string[]).includes(k));
  }

  backupFileName(settingsOnly = false): string {
    return `fiesta-music-${settingsOnly ? 'settings' : 'backup'}-${stamp()}.json`;
  }

  /** Offers the backup as a download; returns the file name. */
  download(settingsOnly = false): string {
    const name = this.backupFileName(settingsOnly);
    const snap = settingsOnly ? this.settingsSnapshot() : this.snapshot();
    saveTextFile(name, JSON.stringify(snap, null, 2), 'application/json');
    return name;
  }

  /** Validates a backup file's text. Throws an Error with a user-facing message. */
  parse(text: string): MusicBackupFile {
    let j: unknown;
    try {
      j = JSON.parse(text.replace(/^﻿/, ''));
    } catch {
      throw new Error('That file is not valid JSON.');
    }
    if (!isObject(j) || j['app'] !== BACKUP_APP || !isObject(j['keys'])) {
      throw new Error('That is not a Fiesta music backup.');
    }
    if (typeof j['version'] !== 'number' || j['version'] > BACKUP_VERSION) {
      throw new Error('That backup was made by a newer version of Fiesta.');
    }
    const keys: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(j['keys'])) {
      if (k && !musicStorage.isSecret(k) && v !== undefined) keys[k] = v;
    }
    return { app: BACKUP_APP, version: BACKUP_VERSION, exportedAt: String(j['exportedAt'] ?? ''), keys };
  }

  /** The library parts of a backup, as MusicLibraryService.restore() takes them. */
  private librarySnapshot(keys: Record<string, unknown>): Partial<MusicLibrarySnapshot> {
    const lib = isObject(keys['library']) ? keys['library'] : {};
    const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
    const snap: Partial<MusicLibrarySnapshot> = {};
    if (isObject(lib['favorites'])) snap.favorites = lib['favorites'] as unknown as MusicLibrarySnapshot['favorites'];
    snap.playlists = arr(lib['playlists']);
    snap.folders = arr(lib['folders']);
    snap.pins = arr(lib['pins']);
    snap.history = arr(keys['history']);
    snap.activity = arr(keys['activity']);
    snap.searches = arr(keys['search-history']);
    if (isObject(keys['blocked'])) snap.blocked = keys['blocked'] as unknown as MusicLibrarySnapshot['blocked'];
    return snap;
  }

  /**
   * Restores a validated backup.
   * Merge: library items are unioned (playlists keep the newer copy), existing
   * settings win over the backup's, other keys are written only when absent.
   * Replace: every non-secret key becomes exactly the backup's (others removed).
   * The page should reload afterwards so every service re-reads its settings.
   */
  restore(file: MusicBackupFile, mode: RestoreMode): RestoreSummary {
    const incoming = file.keys;
    const libSnap = this.librarySnapshot(incoming);
    const hasLibrary = LIBRARY_KEYS.some((k) => k in incoming);
    if (mode === 'replace') {
      this.stopPlayer();
      const incomingSettings = incoming[SETTINGS_KEY];
      if (isObject(incomingSettings)) this.applySettings(incomingSettings);
      else this.settings.reset();
      for (const key of musicStorage.keys()) {
        if (!musicStorage.isSecret(key) && !(key in incoming)) musicStorage.remove(key);
      }
      for (const [k, v] of Object.entries(incoming)) {
        if (!(LIBRARY_KEYS as readonly string[]).includes(k)) musicStorage.write(k, v);
      }
      if (hasLibrary) this.library.restore(libSnap, 'replace');
      else this.library.restore({}, 'replace');
    } else {
      if (hasLibrary) this.library.restore(libSnap, 'merge');
      for (const [k, v] of Object.entries(incoming)) {
        if ((LIBRARY_KEYS as readonly string[]).includes(k)) continue;
        const have = musicStorage.read<unknown>(k, undefined);
        if (k === SETTINGS_KEY && isObject(v)) {
          const current = isObject(have) ? have : {};
          musicStorage.write(k, { ...v, ...current });
          this.applySettings(Object.fromEntries(Object.entries(v).filter(([key]) => !(key in current))));
        } else if (have === undefined) {
          musicStorage.write(k, v);
        }
      }
    }
    return { keys: Object.keys(incoming).length, playlists: libSnap.playlists?.length ?? 0 };
  }

  /** Applies a settings-only file: its keys overwrite the current ones; library keys are ignored. */
  importSettings(file: MusicBackupFile): number {
    let n = 0;
    for (const [k, v] of Object.entries(file.keys)) {
      if ((LIBRARY_KEYS as readonly string[]).includes(k)) continue;
      musicStorage.write(k, v);
      if (k === SETTINGS_KEY && isObject(v)) this.applySettings(v);
      n++;
    }
    return n;
  }

  /** Every IndexedDB database whose name starts with 'fiesta-music-'. */
  async databaseNames(): Promise<string[]> {
    if (typeof indexedDB === 'undefined') return [];
    try {
      const list = await (indexedDB as IDBFactory & { databases?: () => Promise<{ name?: string }[]> }).databases?.();
      if (list) return list.map((d) => d.name ?? '').filter((n) => n.startsWith('fiesta-music-'));
    } catch {
      // fall through to the known names
    }
    return FALLBACK_DBS;
  }

  /** Clears every music key (credentials included) and every fiesta-music-* database. */
  async reset(): Promise<void> {
    this.stopPlayer();
    this.settings.reset();
    for (const key of musicStorage.keys()) musicStorage.remove(key);
    for (const name of await this.databaseNames()) {
      await new Promise<void>((resolve) => {
        try {
          const req = indexedDB.deleteDatabase(name);
          req.onsuccess = req.onerror = req.onblocked = () => resolve();
        } catch {
          resolve();
        }
      });
    }
  }
}
