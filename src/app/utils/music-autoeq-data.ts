// Ported from Monochrome (Apache-2.0), js/autoeq-data.js (parseRawData) and js/autoeq-importer.js - adapted for Fiesta.
import type { FrPoint } from './music-autoeq-engine';

export type HeadphoneType = 'over-ear' | 'in-ear';

/** One measurement in the AutoEq repository. */
export interface AutoEqEntry {
  name: string;
  type: HeadphoneType;
  /** Folder under results/ (e.g. `Rtings/Bruel & Kjaer 5128 over-ear/Sony WH-1000XM5`). */
  path: string;
  fileName: string;
}

export interface AutoEqTarget {
  id: string;
  label: string;
  points: FrPoint[];
}

/**
 * Parses frequency/gain text (comma, semicolon, tab or whitespace separated,
 * European decimals, optional header) into sorted points. When the header has
 * a `raw` column that one is used, else spl/gain/db/magnitude.
 */
export function parseFrData(raw: string): FrPoint[] {
  if (!raw) return [];
  const lines = raw.replace(/^﻿/, '').trim().split(/\r?\n/);
  if (lines.length === 0) return [];
  const first = lines[0].trim();
  let delimiter: string | RegExp = /\s+/;
  if (first.includes(';')) delimiter = ';';
  else if (first.includes(',')) delimiter = ',';
  else if (first.includes('\t')) delimiter = '\t';

  let freqIdx = 0;
  let gainIdx = 1;
  if (/[a-zA-Z]/.test(first)) {
    const headers = first.split(delimiter).map((h) => h.trim().toLowerCase().replace(/['"]+/g, ''));
    const f = headers.findIndex((h) => h.includes('freq') || h === 'f');
    if (f > -1) freqIdx = f;
    const r = headers.findIndex((h) => h === 'raw');
    if (r > -1) gainIdx = r;
    else {
      const s = headers.findIndex((h) => h.includes('spl') || h.includes('gain') || h.includes('db') || h.includes('mag'));
      if (s > -1 && s !== freqIdx) gainIdx = s;
    }
  }

  const points: FrPoint[] = [];
  for (const line of lines) {
    const clean = line.trim();
    if (!clean || !/^[\d\-.]/.test(clean)) continue;
    const parts = clean.split(delimiter);
    if (parts.length <= Math.max(freqIdx, gainIdx)) continue;
    let fs = parts[freqIdx].trim();
    let gs = parts[gainIdx].trim();
    if (delimiter !== ',') {
      fs = fs.replace(',', '.');
      gs = gs.replace(',', '.');
    }
    const freq = parseFloat(fs);
    const gain = parseFloat(gs);
    if (Number.isFinite(freq) && Number.isFinite(gain) && freq > 0) points.push({ freq, gain });
  }
  return points.sort((a, b) => a.freq - b.freq);
}

/** Sources whose profiles ship EQ presets only: the raw measurement CSV is not in the repo (checked 2026-10: every crinacle path 404s). */
const NO_MEASUREMENT_SOURCES = new Set(['crinacle']);

const INDEX_LINE = /^- \[(.+?)\]\(\.\/(.+)\) by (.+?)(?: on (.+))?$/;

/**
 * Parses AutoEq's `results/INDEX.md` (one `- [Name](./source/form/Name) by source on rig` line per
 * profile) into the headphone index. Monochrome walks the GitHub git-tree instead; that listing is
 * truncated (~52k of the repo's entries) and weighs 18 MB, INDEX.md is complete at under 1 MB.
 */
export function parseIndexMarkdown(md: string): AutoEqEntry[] {
  const entries: AutoEqEntry[] = [];
  for (const raw of md.split(/\r?\n/)) {
    const m = INDEX_LINE.exec(raw.trim());
    if (!m) continue;
    let path: string;
    try {
      path = decodeURIComponent(m[2]);
    } catch {
      continue;
    }
    const parts = path.split('/');
    if (parts.length < 3) continue;
    const folder = parts[parts.length - 1];
    const source = parts[0];
    if (NO_MEASUREMENT_SOURCES.has(source)) continue;
    const lower = path.toLowerCase();
    const type: HeadphoneType = lower.includes('in-ear') || lower.includes('iem') || lower.includes('earbud') ? 'in-ear' : 'over-ear';
    entries.push({ name: `${m[1]} (${source})`, type, path, fileName: `${folder}.csv` });
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

/** Case-insensitive substring search over names, with an optional type filter. */
export function searchHeadphones(query: string, entries: readonly AutoEqEntry[], type: 'all' | HeadphoneType = 'all', limit = 100): AutoEqEntry[] {
  let list = entries;
  if (type !== 'all') list = list.filter((e) => e.type === type);
  const q = query.trim().toLowerCase();
  if (q) {
    const words = q.split(/\s+/);
    list = list.filter((e) => {
      const n = e.name.toLowerCase();
      return words.every((w) => n.includes(w));
    });
  }
  return list.slice(0, limit);
}

/** Raw-file URLs for an entry: GitHub first, jsDelivr as the fallback. */
export function measurementUrls(entry: AutoEqEntry): string[] {
  const p = entry.path.split('/').map(encodeURIComponent).join('/');
  const f = encodeURIComponent(entry.fileName);
  return [
    `https://raw.githubusercontent.com/jaakkopasanen/AutoEq/master/results/${p}/${f}`,
    `https://cdn.jsdelivr.net/gh/jaakkopasanen/AutoEq@master/results/${p}/${f}`,
  ];
}

/** Well-known models, used when neither GitHub nor jsDelivr can be reached. */
export const FALLBACK_INDEX: readonly AutoEqEntry[] = [
  { name: 'Sony WH-1000XM5 (Rtings)', type: 'over-ear', path: 'Rtings/Bruel & Kjaer 5128 over-ear/Sony WH-1000XM5', fileName: 'Sony WH-1000XM5.csv' },
  { name: 'Apple AirPods Pro2 (Rtings)', type: 'in-ear', path: 'Rtings/Bruel & Kjaer 5128 in-ear/Apple AirPods Pro2', fileName: 'Apple AirPods Pro2.csv' },
  { name: 'Sony WF-1000XM5 (Rtings)', type: 'in-ear', path: 'Rtings/Bruel & Kjaer 5128 in-ear/Sony WF-1000XM5', fileName: 'Sony WF-1000XM5.csv' },
  { name: 'Samsung Galaxy Buds3 Pro (Rtings)', type: 'in-ear', path: 'Rtings/Bruel & Kjaer 5128 in-ear/Samsung Galaxy Buds3 Pro', fileName: 'Samsung Galaxy Buds3 Pro.csv' },
  { name: 'Sennheiser HD 600 (Rtings)', type: 'over-ear', path: 'Rtings/Bruel & Kjaer 5128 over-ear/Sennheiser HD 600', fileName: 'Sennheiser HD 600.csv' },
  { name: 'Sennheiser HD 600 (Innerfidelity)', type: 'over-ear', path: 'Innerfidelity/over-ear/Sennheiser HD 600', fileName: 'Sennheiser HD 600.csv' },
  { name: 'Apple AirPods Pro (Super Review)', type: 'in-ear', path: 'Super Review/in-ear/Apple AirPods Pro', fileName: 'Apple AirPods Pro.csv' },
];
