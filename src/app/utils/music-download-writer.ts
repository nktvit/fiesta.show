// Ported from Monochrome (Apache-2.0), js/bulk-download-writer.ts - adapted for Fiesta.

/**
 * Where downloads go: the browser's download flow, a ZIP stream, or a folder the
 * visitor picked (File System Access, Chromium only). The folder handle is kept
 * in IndexedDB `fiesta-music-downloads` (store `handles`). Owned by package P12.
 */

export const DOWNLOADS_DB = 'fiesta-music-downloads';
const STORE = 'handles';
const FOLDER_KEY = 'folder';

export interface DirHandle {
  name: string;
  getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<DirHandle>;
  getFileHandle(name: string, opts?: { create?: boolean }): Promise<{ createWritable(): Promise<WritableLike> }>;
  queryPermission?(d: { mode: 'readwrite' }): Promise<string>;
  requestPermission?(d: { mode: 'readwrite' }): Promise<string>;
}

interface WritableLike {
  write(data: BlobPart): Promise<void>;
  close(): Promise<void>;
  abort?(): Promise<void>;
}

export type ZipInput = Blob | string | Uint8Array | ArrayBuffer;
export interface ZipEntry {
  name: string;
  input: ZipInput;
  lastModified?: Date;
}

export function folderWriterSupported(): boolean {
  return typeof window !== 'undefined' && typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function';
}

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null);
      const req = indexedDB.open(DOWNLOADS_DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function idbRun<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
  const db = await openDb();
  if (!db) return undefined;
  return new Promise((resolve) => {
    try {
      const req = fn(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => {
        db.close();
        resolve(req.result);
      };
      req.onerror = () => {
        db.close();
        resolve(undefined);
      };
    } catch {
      db.close();
      resolve(undefined);
    }
  });
}

/** Asks for a folder and remembers it. Null when cancelled or unsupported. */
export async function pickDownloadFolder(): Promise<DirHandle | null> {
  if (!folderWriterSupported()) return null;
  try {
    const dir = (await (window as unknown as { showDirectoryPicker(o: { mode: string }): Promise<DirHandle> }).showDirectoryPicker({ mode: 'readwrite' }));
    await idbRun('readwrite', (s) => s.put(dir, FOLDER_KEY));
    return dir;
  } catch {
    return null;
  }
}

/** The remembered folder, if its write permission is (or can be re-)granted. */
export async function rememberedFolder(ask = false): Promise<DirHandle | null> {
  if (!folderWriterSupported()) return null;
  const dir = (await idbRun<DirHandle>('readonly', (s) => s.get(FOLDER_KEY) as IDBRequest<DirHandle>)) ?? null;
  if (!dir) return null;
  try {
    const opts = { mode: 'readwrite' as const };
    if ((await dir.queryPermission?.(opts)) === 'granted') return dir;
    if (ask && (await dir.requestPermission?.(opts)) === 'granted') return dir;
  } catch {
    /* handle went stale */
  }
  return null;
}

export async function forgetDownloadFolder(): Promise<void> {
  await idbRun('readwrite', (s) => s.delete(FOLDER_KEY) as IDBRequest<undefined>);
}

export async function folderName(): Promise<string> {
  const dir = (await idbRun<DirHandle>('readonly', (s) => s.get(FOLDER_KEY) as IDBRequest<DirHandle>)) ?? null;
  return dir?.name ?? '';
}

async function fileIn(dir: DirHandle, path: string) {
  const parts = path.split('/').filter(Boolean);
  const file = parts.pop() as string;
  let d = dir;
  for (const p of parts) d = await d.getDirectoryHandle(p, { create: true });
  return d.getFileHandle(file, { create: true });
}

/** Writes `parts` to `path` (folders created) under `dir`. */
export async function writeToFolder(dir: DirHandle, path: string, parts: BlobPart[]): Promise<void> {
  const w = await (await fileIn(dir, path)).createWritable();
  try {
    for (const p of parts) await w.write(p);
    await w.close();
  } catch (e) {
    await w.abort?.().catch(() => undefined);
    throw e;
  }
}

/** Streams a ZIP Response body into `path` under `dir`. */
export async function streamToFolder(dir: DirHandle, path: string, body: ReadableStream<Uint8Array>): Promise<void> {
  const w = await (await fileIn(dir, path)).createWritable();
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      await w.write(value as BlobPart);
    }
    await w.close();
  } catch (e) {
    await w.abort?.().catch(() => undefined);
    throw e;
  }
}

/** Offers a Blob through the browser's download flow. */
export function saveBlob(name: string, blob: Blob): void {
  if (typeof document === 'undefined') return;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(url);
  }, 30_000);
}

/** A ZIP of `entries` (client-zip, loaded on first use), as a Response whose body streams. */
export async function zipResponse(entries: AsyncIterable<ZipEntry> | Iterable<ZipEntry>): Promise<Response> {
  const { downloadZip } = await import('client-zip');
  return downloadZip(entries);
}
