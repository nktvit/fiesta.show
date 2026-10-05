// Ported from Monochrome (Apache-2.0), js/autoeq-importer.js - adapted for Fiesta.
import { computed, inject, Injectable, signal } from '@angular/core';
import {
  AutoEqEntry, AutoEqTarget, FALLBACK_INDEX, measurementUrls, parseFrData, parseIndexMarkdown,
} from '../utils/music-autoeq-data';
import { FrPoint } from '../utils/music-autoeq-engine';
import { EqBand, sanitizeBand } from '../utils/music-eq-core';
import { MusicSettingsService } from './music-settings.service';

/** IndexedDB database holding the cached headphone index (cleared by System settings / reset). */
export const AUTOEQ_DB = 'fiesta-music-autoeq';
const STORE = 'kv';
const INDEX_KEY = 'index-v3';
const INDEX_TTL = 24 * 60 * 60 * 1000;
const INDEX_URLS = [
  'https://raw.githubusercontent.com/jaakkopasanen/AutoEq/master/results/INDEX.md',
  'https://cdn.jsdelivr.net/gh/jaakkopasanen/AutoEq@master/results/INDEX.md',
];
const TARGETS_URL = '/assets/music/autoeq/targets.json';

export type AutoEqIndexSource = 'network' | 'cache' | 'stale-cache' | 'fallback';

/** A saved AutoEQ result. */
export interface AutoEqProfile {
  id: string;
  name: string;
  /** What it was made from (headphone model, or "Custom measurement"). */
  source: string;
  target: string;
  preamp: number;
  bands: EqBand[];
  createdAt: number;
}

function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(AUTOEQ_DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function idbGet<T>(key: string): Promise<T | null> {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
      req.onsuccess = () => {
        db.close();
        resolve((req.result as T | undefined) ?? null);
      };
      req.onerror = () => {
        db.close();
        resolve(null);
      };
    } catch {
      db.close();
      resolve(null);
    }
  });
}

async function idbSet(key: string, value: unknown): Promise<void> {
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(value, key);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        resolve();
      };
      tx.onabort = () => {
        db.close();
        resolve();
      };
    } catch {
      db.close();
      resolve();
    }
  });
}

/** fetch with a timeout (AbortSignal.timeout is not available everywhere). */
async function fetchText(url: string, ms = 12000): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * AutoEQ data: the headphone index (AutoEq repo, cached 24 h in IndexedDB), measurement
 * files, the target-curve library and the user's saved profiles. No keys: everything
 * comes from raw.githubusercontent.com / cdn.jsdelivr.net or this site's own assets.
 */
@Injectable({ providedIn: 'root' })
export class MusicAutoEqService {
  private settings = inject(MusicSettingsService);

  private readonly profilesStored = this.settings.scoped<unknown>('autoeq-profiles', []);
  /** Saved profiles, newest first. */
  readonly profiles = computed<AutoEqProfile[]>(() => sanitizeProfiles(this.profilesStored()));

  readonly entries = signal<AutoEqEntry[]>([]);
  readonly indexLoading = signal(false);
  readonly indexSource = signal<AutoEqIndexSource | null>(null);

  private indexPromise: Promise<AutoEqEntry[]> | null = null;
  private targetsPromise: Promise<AutoEqTarget[]> | null = null;
  private measurements = new Map<string, FrPoint[]>();

  /** Loads (once) the headphone index: cache, then network, then stale cache, then a built-in list. */
  loadIndex(force = false): Promise<AutoEqEntry[]> {
    if (this.indexPromise && !force) return this.indexPromise;
    this.indexLoading.set(true);
    this.indexPromise = this.fetchIndex(force).then((r) => {
      this.entries.set(r.entries);
      this.indexSource.set(r.source);
      this.indexLoading.set(false);
      return r.entries;
    });
    return this.indexPromise;
  }

  private async fetchIndex(force: boolean): Promise<{ entries: AutoEqEntry[]; source: AutoEqIndexSource }> {
    const cached = await idbGet<{ timestamp: number; data: AutoEqEntry[] }>(INDEX_KEY);
    const valid = !!cached && Array.isArray(cached.data) && cached.data.length > 0;
    if (!force && valid && Date.now() - cached.timestamp < INDEX_TTL) return { entries: cached.data, source: 'cache' };
    for (const url of INDEX_URLS) {
      try {
        const entries = parseIndexMarkdown(await fetchText(url, 20000));
        if (entries.length > 100) {
          void idbSet(INDEX_KEY, { timestamp: Date.now(), data: entries });
          return { entries, source: 'network' };
        }
      } catch {
        // try the next host
      }
    }
    if (valid) return { entries: cached.data, source: 'stale-cache' };
    return { entries: [...FALLBACK_INDEX], source: 'fallback' };
  }

  /** The measurement curve of one model (GitHub raw, then jsDelivr). Throws when neither has it. */
  async measurement(entry: AutoEqEntry): Promise<FrPoint[]> {
    const key = `${entry.path}/${entry.fileName}`;
    const hit = this.measurements.get(key);
    if (hit) return hit;
    for (const url of measurementUrls(entry)) {
      try {
        const text = await fetchText(url, 10000);
        const t = text.trimStart();
        if (t.startsWith('<!') || t.startsWith('<html')) continue;
        const points = parseFrData(text);
        if (points.length > 10) {
          this.measurements.set(key, points);
          return points;
        }
      } catch {
        // next mirror
      }
    }
    throw new Error(`No measurement available for ${entry.name}`);
  }

  /** The built-in target curves (lazy: fetched on first use). */
  targets(): Promise<AutoEqTarget[]> {
    this.targetsPromise ??= fetch(TARGETS_URL)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<AutoEqTarget[]>;
      })
      .then((list) => list.filter((t) => t && Array.isArray(t.points) && t.points.length >= 2))
      .catch((e) => {
        this.targetsPromise = null;
        throw e;
      });
    return this.targetsPromise;
  }

  /** Parses a custom measurement / target file the user picked. Throws a readable error on bad data. */
  parseCustomCurve(text: string): FrPoint[] {
    const points = parseFrData(text);
    if (points.length < 10) throw new Error('Could not find a frequency/dB table in that file (need at least 10 rows).');
    return points;
  }

  saveProfile(p: Omit<AutoEqProfile, 'id' | 'createdAt'>): AutoEqProfile {
    const profile: AutoEqProfile = {
      ...p,
      id: `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      createdAt: Date.now(),
      name: p.name.trim().slice(0, 80) || 'Untitled',
    };
    this.profilesStored.set([profile, ...this.profiles()].slice(0, 100));
    return profile;
  }

  deleteProfile(id: string): void {
    this.profilesStored.set(this.profiles().filter((p) => p.id !== id));
  }
}

function sanitizeProfiles(raw: unknown): AutoEqProfile[] {
  if (!Array.isArray(raw)) return [];
  const out: AutoEqProfile[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    if (typeof o['id'] !== 'string' || !Array.isArray(o['bands'])) continue;
    const bands = (o['bands'] as unknown[]).map(sanitizeBand).filter((b): b is EqBand => !!b);
    if (bands.length === 0) continue;
    out.push({
      id: o['id'],
      name: typeof o['name'] === 'string' ? o['name'] : 'Untitled',
      source: typeof o['source'] === 'string' ? o['source'] : '',
      target: typeof o['target'] === 'string' ? o['target'] : '',
      preamp: typeof o['preamp'] === 'number' && Number.isFinite(o['preamp']) ? Math.min(20, Math.max(-20, o['preamp'])) : 0,
      bands,
      createdAt: typeof o['createdAt'] === 'number' ? o['createdAt'] : 0,
    });
  }
  return out;
}
