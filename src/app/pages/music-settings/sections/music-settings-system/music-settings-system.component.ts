import { isPlatformBrowser } from '@angular/common';
import { Component, inject, OnInit, PLATFORM_ID, signal } from '@angular/core';
import { MusicSettingRowComponent } from '../../../../components/music-setting-row/music-setting-row.component';
import { MusicToastService } from '../../../../services/music-toast.service';
import { MUSIC_STORAGE_PREFIX } from '../../../../utils/music-storage';

export interface StorageArea { area: string; keys: number; bytes: number }
export type ApiStatus = { state: 'idle' } | { state: 'checking' } | { state: 'ok'; ms: number } | { state: 'down'; detail: string };

/** IndexedDB caches that "Clear caches" deletes (user data such as backups and downloads is kept). */
export const MUSIC_CACHE_DBS = [
  'fiesta-music-lyrics', 'fiesta-music-waveform', 'fiesta-music-waveforms', 'fiesta-music-autoeq',
  'fiesta-music-cache', 'fiesta-music-covers',
];

/** Groups `fiesta:music:*` localStorage entries by area (the first key segment). UTF-16: 2 bytes per char. */
export function groupStorage(entries: [string, string][]): StorageArea[] {
  const map = new Map<string, StorageArea>();
  for (const [key, value] of entries) {
    if (!key.startsWith(MUSIC_STORAGE_PREFIX)) continue;
    const rest = key.slice(MUSIC_STORAGE_PREFIX.length);
    const area = rest.split(':')[0] || 'other';
    const row = map.get(area) ?? { area, keys: 0, bytes: 0 };
    row.keys++;
    row.bytes += (key.length + value.length) * 2;
    map.set(area, row);
  }
  return [...map.values()].sort((a, b) => b.bytes - a.bytes);
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${i === 0 ? v : v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

interface StorageEstimateEx extends StorageEstimate { usageDetails?: Record<string, number> }

/** Music settings: System section (storage, caches, API status, version). Owned by package P11. */
@Component({
  selector: 'app-music-settings-system',
  imports: [MusicSettingRowComponent],
  templateUrl: './music-settings-system.component.html',
  host: { class: 'block' },
})
export class MusicSettingsSystemComponent implements OnInit {
  private readonly browser = isPlatformBrowser(inject(PLATFORM_ID));
  private readonly toast = inject(MusicToastService);

  protected readonly local = signal<StorageArea[]>([]);
  protected readonly dbNames = signal<string[]>([]);
  protected readonly idbBytes = signal<number | null>(null);
  protected readonly quota = signal<number | null>(null);
  protected readonly clearing = signal(false);
  protected readonly lastFreed = signal<string>('');
  protected readonly api = signal<ApiStatus>({ state: 'idle' });
  protected readonly version = this.buildId();
  protected readonly formatBytes = formatBytes;

  ngOnInit(): void {
    void this.refresh();
    void this.ping();
  }

  protected localTotal(): number {
    return this.local().reduce((n, r) => n + r.bytes, 0);
  }

  async refresh(): Promise<void> {
    if (!this.browser) return;
    try {
      const entries: [string, string][] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k?.startsWith(MUSIC_STORAGE_PREFIX)) entries.push([k, localStorage.getItem(k) ?? '']);
      }
      this.local.set(groupStorage(entries));
    } catch {
      this.local.set([]);
    }
    this.dbNames.set(await this.listDbs());
    const est = await this.estimate();
    this.idbBytes.set(est ? (est.usageDetails?.['indexedDB'] ?? est.usage ?? null) : null);
    this.quota.set(est?.quota ?? null);
  }

  async clearCaches(): Promise<void> {
    if (!this.browser || this.clearing()) return;
    this.clearing.set(true);
    try {
      const before = (await this.estimate())?.usageDetails?.['indexedDB'];
      const names = new Set([...MUSIC_CACHE_DBS, ...(await this.listDbs()).filter((n) => MUSIC_CACHE_DBS.includes(n))]);
      const results = await Promise.all([...names].map((n) => this.deleteDb(n)));
      await this.refresh();
      const after = this.idbBytes();
      const freed = typeof before === 'number' && after !== null ? Math.max(0, before - after) : null;
      const failed = results.filter((r) => !r).length;
      const msg = freed !== null ? `Caches cleared, ${formatBytes(freed)} freed.` : 'Caches cleared.';
      this.lastFreed.set(msg);
      this.toast.show({
        message: failed ? `${msg} ${failed} database(s) are in use and will clear after a reload.` : msg,
        tone: failed ? 'warn' : 'info',
      });
    } finally {
      this.clearing.set(false);
    }
  }

  async ping(): Promise<void> {
    if (!this.browser) return;
    this.api.set({ state: 'checking' });
    const t0 = performance.now();
    try {
      const res = await fetch('/api/music?action=search&q=test', { cache: 'no-store', signal: AbortSignal.timeout?.(10000) });
      const ms = Math.round(performance.now() - t0);
      this.api.set(res.ok ? { state: 'ok', ms } : { state: 'down', detail: `HTTP ${res.status}` });
    } catch (e) {
      this.api.set({ state: 'down', detail: e instanceof Error ? e.message : 'unreachable' });
    }
  }

  private async listDbs(): Promise<string[]> {
    try {
      const dbs = await indexedDB.databases?.();
      if (dbs) return dbs.map((d) => d.name ?? '').filter((n) => n.startsWith('fiesta-music-')).sort();
    } catch {
      // fall through to the known list
    }
    return [];
  }

  private async estimate(): Promise<StorageEstimateEx | null> {
    try {
      return (await navigator.storage?.estimate?.()) ?? null;
    } catch {
      return null;
    }
  }

  private deleteDb(name: string): Promise<boolean> {
    return new Promise((resolve) => {
      try {
        const req = indexedDB.deleteDatabase(name);
        const timer = setTimeout(() => resolve(false), 2000);
        req.onsuccess = () => { clearTimeout(timer); resolve(true); };
        req.onerror = () => { clearTimeout(timer); resolve(false); };
        req.onblocked = () => { /* wait for the timeout; the delete completes once connections close */ };
      } catch {
        resolve(false);
      }
    });
  }

  /** Build id from the hashed main bundle name (e.g. main-ABC123.js); 'development' when unhashed. */
  private buildId(): string {
    if (typeof document === 'undefined') return 'unknown';
    // Follow-up (docs/handoff.md, Music follow-ups): show a git sha once the build injects one; package.json is 0.0.0.
    const src = Array.from(document.scripts).map((s) => s.src).find((s) => /\/main[-.]/.test(s)) ?? '';
    const m = src.match(/main-([A-Z0-9]+)\.js/i);
    return m ? `build ${m[1]}` : 'development build';
  }
}
