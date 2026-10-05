/**
 * The only door to localStorage for music state. Every key lives under
 * `fiesta:music:`; credentials and tokens under `fiesta:music:secret:` (backups
 * skip those). Values are JSON.
 *
 * Every call is SSR-guarded and wrapped in try/catch: in private mode, with
 * storage disabled or full, reads fall back and writes are dropped - the choice
 * lasts for this page only.
 *
 * Keys passed in are relative: `read('settings')` reads `fiesta:music:settings`.
 */
export const MUSIC_STORAGE_PREFIX = 'fiesta:music:';
/** Relative prefix for credentials; `musicStorage.write('secret:lastfm', ...)`. */
export const MUSIC_SECRET_PREFIX = 'secret:';

function store(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export const musicStorage = {
  prefix: MUSIC_STORAGE_PREFIX,

  /** The parsed value at `key`, or `fallback` when missing, unreadable or not JSON. */
  read<T>(key: string, fallback: T): T {
    const s = store();
    if (!s) return fallback;
    try {
      const raw = s.getItem(MUSIC_STORAGE_PREFIX + key);
      return raw === null ? fallback : (JSON.parse(raw) as T);
    } catch {
      return fallback;
    }
  },

  /** Stores `value` as JSON. Returns false when it could not be saved (private mode, quota). */
  write(key: string, value: unknown): boolean {
    const s = store();
    if (!s) return false;
    try {
      s.setItem(MUSIC_STORAGE_PREFIX + key, JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  },

  remove(key: string): void {
    const s = store();
    if (!s) return;
    try {
      s.removeItem(MUSIC_STORAGE_PREFIX + key);
    } catch {
      // private mode: nothing to remove
    }
  },

  /** Every music key, relative (without the prefix), secrets included. */
  keys(): string[] {
    const s = store();
    if (!s) return [];
    try {
      const out: string[] = [];
      for (let i = 0; i < s.length; i++) {
        const k = s.key(i);
        if (k && k.startsWith(MUSIC_STORAGE_PREFIX)) out.push(k.slice(MUSIC_STORAGE_PREFIX.length));
      }
      return out;
    } catch {
      return [];
    }
  },

  /** Whether a relative key holds credentials (excluded from backups). */
  isSecret(key: string): boolean {
    return key.startsWith(MUSIC_SECRET_PREFIX);
  },
};

export type MusicStorage = typeof musicStorage;
