/** IndexedDB database holding fetched lyrics (7 days). P7/P11 clear every `fiesta-music-*` database. */
export const MUSIC_LYRICS_DB = 'fiesta-music-lyrics';
const STORE = 'entries';
export const MUSIC_LYRICS_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface Entry<T> {
  key: string;
  at: number;
  value: T;
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

function open(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase | null>((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null);
      const req = indexedDB.open(MUSIC_LYRICS_DB, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: 'key' });
      };
      req.onsuccess = () => {
        req.result.onversionchange = () => {
          req.result.close();
          dbPromise = null;
        };
        resolve(req.result);
      };
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

/** The cached value, or undefined when missing, expired or storage is unavailable. */
export async function lyricsCacheGet<T>(key: string, now = Date.now()): Promise<T | undefined> {
  const db = await open();
  if (!db) return undefined;
  return new Promise<T | undefined>((resolve) => {
    try {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
      req.onsuccess = () => {
        const e = req.result as Entry<T> | undefined;
        resolve(e && now - e.at < MUSIC_LYRICS_TTL_MS ? e.value : undefined);
      };
      req.onerror = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  });
}

/** Best effort: failures (private mode, quota) are swallowed. */
export async function lyricsCachePut<T>(key: string, value: T, now = Date.now()): Promise<void> {
  const db = await open();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put({ key, at: now, value } satisfies Entry<T>);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}

/** Drops every cached lyric (used by tests; the Data settings reset clears the whole database). */
export async function lyricsCacheClear(): Promise<void> {
  const db = await open();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}
