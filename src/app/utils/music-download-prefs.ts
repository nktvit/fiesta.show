import { DEFAULT_BULK_TEMPLATE, DEFAULT_TRACK_TEMPLATE } from './music-download-template';

/** Download preferences (persisted at `fiesta:music:downloads`). Owned by package P12. */

export type DownloadQuality = 'LOSSLESS' | 'HIGH' | 'LOW';
export type DownloadBulkMode = 'zip' | 'files';
export type DownloadLyricsSidecar = 'off' | 'lrc' | 'ttml';

export interface DownloadSidecars {
  cover: boolean;
  m3u8: boolean;
  cue: boolean;
  nfo: boolean;
  json: boolean;
}

export interface MusicDownloadPrefs {
  quality: DownloadQuality;
  /** Single tracks: tokens {artist} {album} {title} {track} {year}. */
  trackTemplate: string;
  /** Tracks inside an album/playlist ZIP or folder. */
  bulkTemplate: string;
  bulkMode: DownloadBulkMode;
  sidecars: DownloadSidecars;
  /** A lyrics file next to each track in bulk downloads. */
  lyricsSidecar: DownloadLyricsSidecar;
  embedLyrics: boolean;
  embedCover: boolean;
  /** Write into the chosen folder (File System Access) instead of the browser's download flow. */
  saveToFolder: boolean;
}

export function defaultDownloadPrefs(): MusicDownloadPrefs {
  return {
    quality: 'LOSSLESS',
    trackTemplate: DEFAULT_TRACK_TEMPLATE,
    bulkTemplate: DEFAULT_BULK_TEMPLATE,
    bulkMode: 'zip',
    sidecars: { cover: true, m3u8: true, cue: false, nfo: false, json: false },
    lyricsSidecar: 'lrc',
    embedLyrics: true,
    embedCover: true,
    saveToFolder: false,
  };
}

/** A validated copy of whatever was stored; unknown or malformed fields fall back to the defaults. */
export function sanitizeDownloadPrefs(raw: unknown): MusicDownloadPrefs {
  const d = defaultDownloadPrefs();
  if (!raw || typeof raw !== 'object') return d;
  const r = raw as Record<string, unknown>;
  const bool = (v: unknown, fb: boolean) => (typeof v === 'boolean' ? v : fb);
  const str = (v: unknown, fb: string) => (typeof v === 'string' && v.trim() ? v.slice(0, 200) : fb);
  const sc = r['sidecars'] && typeof r['sidecars'] === 'object' ? (r['sidecars'] as Record<string, unknown>) : {};
  return {
    quality: r['quality'] === 'HIGH' || r['quality'] === 'LOW' || r['quality'] === 'LOSSLESS' ? r['quality'] : d.quality,
    trackTemplate: str(r['trackTemplate'], d.trackTemplate),
    bulkTemplate: str(r['bulkTemplate'], d.bulkTemplate),
    bulkMode: r['bulkMode'] === 'files' ? 'files' : 'zip',
    sidecars: {
      cover: bool(sc['cover'], d.sidecars.cover),
      m3u8: bool(sc['m3u8'], d.sidecars.m3u8),
      cue: bool(sc['cue'], d.sidecars.cue),
      nfo: bool(sc['nfo'], d.sidecars.nfo),
      json: bool(sc['json'], d.sidecars.json),
    },
    lyricsSidecar: r['lyricsSidecar'] === 'off' || r['lyricsSidecar'] === 'ttml' ? r['lyricsSidecar'] : r['lyricsSidecar'] === 'lrc' ? 'lrc' : d.lyricsSidecar,
    embedLyrics: bool(r['embedLyrics'], d.embedLyrics),
    embedCover: bool(r['embedCover'], d.embedCover),
    saveToFolder: bool(r['saveToFolder'], d.saveToFolder),
  };
}
