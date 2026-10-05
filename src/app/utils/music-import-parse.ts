// Ported from Monochrome (Apache-2.0), js/playlist-importer.js - adapted for Fiesta.
/**
 * Playlist/library file parsers for the import wizard: CSV (Spotify, Exportify,
 * generic; quote-aware via papaparse), JSPF, XSPF, generic XML and M3U/M3U8.
 * They only read; matching rows to the catalogue is MusicImportService.
 */

export type ImportFormat = 'csv' | 'jspf' | 'xspf' | 'xml' | 'm3u';
export type ImportRowType = 'track' | 'album' | 'artist';

export interface ImportRow {
  type: ImportRowType;
  title: string;
  artist: string;
  album: string;
  isrc: string;
  /** Source playlist name for CSVs that hold several. */
  playlist?: string;
  /** The source marked it a favourite. */
  favorite?: boolean;
}

export interface ParsedImport {
  format: ImportFormat;
  /** Human label: "Spotify CSV", "XSPF playlist"... */
  label: string;
  name: string;
  description: string;
  cover: string;
  rows: ImportRow[];
}

export const IMPORT_ACCEPT = '.csv,.json,.jspf,.xspf,.xml,.m3u,.m3u8,.txt,text/csv,application/json,text/xml,application/xml';

const MAX_ROWS = 5000;

const HEADER_MAPPINGS: Record<string, string[]> = {
  track: ['track name', 'title', 'song', 'name', 'track', 'track title', 'song name'],
  artist: ['artist name(s)', 'artist name', 'artist', 'artists', 'creator', 'artist names', 'performer'],
  album: ['album', 'album name'],
  type: ['type', 'category', 'kind'],
  isrc: ['isrc', 'isrc code'],
  spotifyId: ['spotify - id', 'spotify id', 'spotify_id', 'spotifyid'],
  trackUri: ['track uri'],
  playlistName: ['playlist name', 'playlist', 'playlist title'],
};

export interface MappedHeaders {
  track?: number;
  artist?: number;
  album?: number;
  type?: number;
  isrc?: number;
  spotifyId?: number;
  trackUri?: number;
  playlistName?: number;
}

function normalizeHeader(h: unknown): string {
  return String(h ?? '').replace(/^﻿/, '').toLowerCase().trim().replace(/[_\s]+/g, ' ');
}

export function mapHeaders(raw: string[]): MappedHeaders {
  const out: MappedHeaders = {};
  const bag = out as Record<string, number | undefined>;
  raw.forEach((h, i) => {
    const n = normalizeHeader(h);
    for (const [key, aliases] of Object.entries(HEADER_MAPPINGS)) {
      if (aliases.includes(n) && bag[key] === undefined) {
        bag[key] = i;
        break;
      }
    }
  });
  return out;
}

export interface CsvKind {
  /** 'tracks' = playlist-like, 'library' = mixed or artist/album rows. */
  layout: 'playlist' | 'library' | 'artists';
  label: string;
}

export function detectCsvKind(m: MappedHeaders): CsvKind {
  const label = m.trackUri !== undefined ? 'Exportify CSV' : m.spotifyId !== undefined ? 'Spotify CSV' : 'CSV';
  if (m.track !== undefined && m.artist !== undefined) {
    return { layout: m.type !== undefined || m.playlistName === undefined ? 'library' : 'playlist', label };
  }
  if (m.artist !== undefined) return { layout: 'artists', label };
  return { layout: 'playlist', label };
}

function clean(s: unknown): string {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

type PapaModule = { parse: (text: string, cfg: { skipEmptyLines: boolean | 'greedy' }) => { data: string[][] } };

/** Rows of a CSV (quoted commas and newlines handled). papaparse loads on first use. */
export async function parseCsvRows(text: string): Promise<string[][]> {
  const mod = (await import('papaparse')) as unknown as { default?: PapaModule } & PapaModule;
  const Papa = mod.default ?? mod;
  return Papa.parse(text.replace(/^﻿/, ''), { skipEmptyLines: 'greedy' }).data;
}

function rowType(v: string[], m: MappedHeaders): ImportRowType {
  if (m.type !== undefined) {
    const t = clean(v[m.type]).toLowerCase();
    if (t === 'album' || t === 'favorite album') return 'album';
    if (t === 'artist' || t === 'favorite artist') return 'artist';
    if (['favorite', 'favorite track', 'track', 'playlist'].includes(t)) return 'track';
  }
  const hasTrack = m.track !== undefined && !!clean(v[m.track]);
  const hasArtist = m.artist !== undefined && !!clean(v[m.artist]);
  const hasAlbum = m.album !== undefined && !!clean(v[m.album]);
  if (hasTrack && hasArtist) return 'track';
  if (hasTrack && hasAlbum && v[m.track as number] === v[m.album as number]) return hasArtist ? 'track' : 'album';
  if (hasAlbum && hasArtist && !hasTrack) return 'album';
  if (hasArtist && !hasTrack && !hasAlbum) return 'artist';
  return 'track';
}

export async function parseCsv(text: string): Promise<ParsedImport> {
  const all = await parseCsvRows(text);
  if (all.length < 2) throw new Error('That CSV has no rows.');
  const m = mapHeaders(all[0]);
  const kind = detectCsvKind(m);
  if (m.track === undefined && m.artist === undefined) {
    throw new Error('No track or artist column found. Expected headers like "Track Name" and "Artist Name(s)".');
  }
  const rows: ImportRow[] = [];
  let name = '';
  for (const v of all.slice(1, MAX_ROWS + 1)) {
    const get = (i: number | undefined) => (i === undefined ? '' : clean(v[i]));
    const type = rowType(v, m);
    const row: ImportRow = {
      type,
      title: type === 'album' ? get(m.album) || get(m.track) : get(m.track),
      artist: get(m.artist),
      album: get(m.album),
      isrc: get(m.isrc),
    };
    if (type === 'artist') row.title = '';
    const pl = get(m.playlistName);
    if (pl) {
      row.playlist = pl;
      name ||= pl;
    }
    if (get(m.type).toLowerCase().includes('favorite')) row.favorite = true;
    if (!row.title && !row.artist) continue;
    rows.push(row);
  }
  return { format: 'csv', label: kind.label, name, description: '', cover: '', rows };
}

// ── JSPF ───────────────────────────────────────────────────────────────────

interface JspfTrack {
  title?: unknown;
  creator?: unknown;
  album?: unknown;
  identifier?: unknown;
  extension?: unknown;
}

function isrcFromIdentifiers(v: unknown): string {
  const list = Array.isArray(v) ? v : v === undefined || v === null ? [] : [v];
  for (const id of list) {
    const m = /isrc[:/]+([A-Za-z0-9-]{8,})/i.exec(String(id));
    if (m) return m[1].replace(/-/g, '').toUpperCase();
  }
  return '';
}

export function parseJspf(text: string): ParsedImport {
  let j: { playlist?: { title?: unknown; annotation?: unknown; image?: unknown; track?: unknown } };
  try {
    j = JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    throw new Error('That file is not valid JSON.');
  }
  const pl = j?.playlist;
  const list = Array.isArray(pl?.track) ? (pl?.track as JspfTrack[]) : null;
  if (!pl || !list) throw new Error('No playlist found in that JSPF file.');
  const rows: ImportRow[] = [];
  for (const t of list.slice(0, MAX_ROWS)) {
    const title = clean(t.title);
    if (!title) continue;
    rows.push({
      type: 'track', title, artist: clean(t.creator), album: clean(t.album), isrc: isrcFromIdentifiers(t.identifier),
    });
  }
  return {
    format: 'jspf', label: 'JSPF playlist', name: clean(pl.title), description: clean(pl.annotation),
    cover: typeof pl.image === 'string' ? pl.image.trim() : '', rows,
  };
}

// ── XSPF / XML ─────────────────────────────────────────────────────────────

function parseXmlDoc(text: string): Document {
  if (typeof DOMParser === 'undefined') throw new Error('XML import needs a browser.');
  const doc = new DOMParser().parseFromString(text.replace(/^﻿/, ''), 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('That file is not valid XML.');
  return doc;
}

function child(el: Element, ...names: string[]): string {
  for (const n of names) {
    for (const c of Array.from(el.children)) {
      if (c.localName.toLowerCase() === n.toLowerCase() && c.textContent?.trim()) return clean(c.textContent);
    }
  }
  return '';
}

function descendants(doc: Document, ...names: string[]): Element[] {
  for (const n of names) {
    const found = Array.from(doc.getElementsByTagNameNS('*', n));
    if (found.length) return found;
  }
  return [];
}

function xmlRows(els: Element[]): ImportRow[] {
  const rows: ImportRow[] = [];
  for (const el of els.slice(0, MAX_ROWS)) {
    const title = child(el, 'title', 'name');
    if (!title) continue;
    const ids = Array.from(el.children).filter((c) => c.localName === 'identifier').map((c) => c.textContent ?? '');
    rows.push({
      type: 'track', title, artist: child(el, 'creator', 'artist', 'performer'), album: child(el, 'album'),
      isrc: child(el, 'isrc') ? normalizeIsrcText(child(el, 'isrc')) : isrcFromIdentifiers(ids),
    });
  }
  return rows;
}

function normalizeIsrcText(s: string): string {
  return s.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

export function parseXspf(text: string): ParsedImport {
  const doc = parseXmlDoc(text);
  const root = doc.documentElement;
  const rows = xmlRows(descendants(doc, 'track', 'song', 'item'));
  if (!rows.length && root.localName !== 'playlist') throw new Error('No playlist found in that XML file.');
  return {
    format: 'xspf', label: 'XSPF playlist', name: child(root, 'title'), description: child(root, 'annotation'),
    cover: child(root, 'image'), rows,
  };
}

export function parseXml(text: string): ParsedImport {
  const doc = parseXmlDoc(text);
  const root = doc.documentElement;
  const rows = xmlRows(descendants(doc, 'track', 'song', 'item'));
  return {
    format: 'xml', label: 'XML playlist', name: child(root, 'name', 'title'), description: child(root, 'description', 'annotation'),
    cover: '', rows,
  };
}

// ── M3U ────────────────────────────────────────────────────────────────────

function splitDisplay(display: string): { artist: string; title: string } {
  const i = display.indexOf(' - ');
  return i > 0 ? { artist: clean(display.slice(0, i)), title: clean(display.slice(i + 3)) } : { artist: '', title: clean(display) };
}

/** "/music/01 - Artist - Title.flac" -> "Artist - Title". */
function displayFromPath(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path;
  return base.replace(/\.[A-Za-z0-9]{2,5}$/, '').replace(/^\d{1,3}\s*[-.]\s*/, '');
}

export function parseM3u(text: string): ParsedImport {
  const rows: ImportRow[] = [];
  let name = '';
  let pending: { artist: string; title: string } | null = null;
  for (const raw of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF:')) {
      const m = /^#EXTINF:\s*-?[\d.]*\s*(?:[^,]*)?,(.*)$/.exec(line);
      pending = m ? splitDisplay(m[1]) : null;
    } else if (line.startsWith('#PLAYLIST:')) {
      name = clean(line.slice(10));
    } else if (!line.startsWith('#')) {
      const info = pending ?? splitDisplay(displayFromPath(line));
      pending = null;
      if (info.title) rows.push({ type: 'track', title: info.title, artist: info.artist, album: '', isrc: '' });
      if (rows.length >= MAX_ROWS) break;
    }
  }
  return { format: 'm3u', label: 'M3U playlist', name, description: '', cover: '', rows };
}

// ── detection ──────────────────────────────────────────────────────────────

export function detectImportFormat(fileName: string, text: string): ImportFormat | null {
  const ext = (fileName.split('.').pop() || '').toLowerCase();
  const head = text.replace(/^﻿/, '').trimStart();
  if (ext === 'm3u' || ext === 'm3u8') return 'm3u';
  if (ext === 'jspf') return 'jspf';
  if (ext === 'xspf') return 'xspf';
  if (ext === 'csv') return 'csv';
  if (head.startsWith('#EXTM3U') || head.startsWith('#EXTINF')) return 'm3u';
  if (head.startsWith('{')) return 'jspf';
  if (head.startsWith('<')) return /xspf\.org|<trackList/i.test(head.slice(0, 2000)) ? 'xspf' : 'xml';
  if (ext === 'xml') return 'xml';
  if (head.includes(',') || head.includes(';') || head.includes('\t')) return 'csv';
  return null;
}

/** Reads any supported playlist file's text. Throws an Error with a user-facing message. */
export async function parseImportText(fileName: string, text: string): Promise<ParsedImport> {
  const format = detectImportFormat(fileName, text);
  let out: ParsedImport;
  switch (format) {
    case 'csv': out = await parseCsv(text); break;
    case 'jspf': out = parseJspf(text); break;
    case 'xspf': out = parseXspf(text); break;
    case 'xml': out = parseXml(text); break;
    case 'm3u': out = parseM3u(text); break;
    default: throw new Error('Unsupported file. Use CSV, JSPF, XSPF, XML, M3U or M3U8.');
  }
  if (!out.rows.length) throw new Error('No tracks found in that file.');
  return out;
}
