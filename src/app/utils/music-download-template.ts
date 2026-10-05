// Ported from Monochrome (Apache-2.0), js/utils.js formatPathTemplate - adapted for Fiesta.
import { MusicAlbum, MusicTrack } from '../services/music.service';

/** Filename templates for downloads. Pure. Owned by package P12. */

export const DOWNLOAD_TEMPLATE_TOKENS = ['{artist}', '{album}', '{title}', '{track}', '{year}'] as const;
export const DEFAULT_TRACK_TEMPLATE = '{artist} - {title}';
export const DEFAULT_BULK_TEMPLATE = '{track} - {title}';

export interface DownloadNameData {
  artist: string;
  album: string;
  title: string;
  /** 1-based position or album track number; 0 = unknown. */
  track: number;
  year: string;
}

/** One path component made safe for every OS (no separators, control characters, trailing dots). */
export function safeName(value: string, fallback = ''): string {
  // eslint-disable-next-line no-control-regex
  const s = (value || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+/, '').replace(/[. ]+$/, '');
  return (s || fallback).slice(0, 120);
}

export function trackNumberText(n: number, width = 2): string {
  return n > 0 ? String(Math.floor(n)).padStart(width, '0') : '00';
}

/**
 * Fills `template`. Tokens: {artist} {album} {title} {track} {year}. A "/" in the
 * template makes a folder; empty segments, "." and ".." are dropped. Returns the
 * path without an extension (never empty).
 */
export function formatDownloadName(template: string, data: DownloadNameData, trackWidth = 2): string {
  const values: Record<string, string> = {
    artist: safeName(data.artist, 'Unknown Artist'),
    album: safeName(data.album, 'Unknown Album'),
    title: safeName(data.title, 'Unknown Title'),
    track: trackNumberText(data.track, trackWidth),
    year: safeName(data.year, 'Unknown'),
  };
  const filled = (template || DEFAULT_TRACK_TEMPLATE).replace(/\{(artist|album|title|track|year)\}/gi, (_m, k: string) => values[k.toLowerCase()]);
  const path = filled
    .replace(/\\/g, '/')
    .split('/')
    .map((p) => safeName(p))
    .filter((p) => p && p !== '.' && p !== '..')
    .join('/');
  return path || values['title'];
}

/** The name data for a track (album optional); `position` overrides the track number (bulk downloads). */
export function nameDataFor(track: MusicTrack, album?: Pick<MusicAlbum, 'title' | 'year' | 'artist'> | null, position?: number): DownloadNameData {
  const year = track.releaseDate?.slice(0, 4) || album?.year || '';
  return {
    artist: track.artist || album?.artist || '',
    album: track.album || album?.title || '',
    title: track.version ? `${track.title} (${track.version})` : track.title,
    track: position ?? track.trackNumber ?? 0,
    year,
  };
}

/** The same path with browser-download-safe slashes (a plain download cannot make folders). */
export function flatName(path: string): string {
  return path.replace(/\//g, ' - ');
}

/** Adds " (2)", " (3)"... before the extension until `name` is not in `used`; records and returns it. */
export function uniqueName(name: string, used: Set<string>): string {
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  let candidate = name;
  for (let n = 2; used.has(candidate.toLowerCase()); n++) candidate = `${stem} (${n})${ext}`;
  used.add(candidate.toLowerCase());
  return candidate;
}

/** "Artist - Title.flac" style preview for the settings screen. */
export function previewTemplate(template: string, ext = 'flac'): string {
  const sample: DownloadNameData = { artist: 'Daft Punk', album: 'Discovery', title: 'One More Time', track: 1, year: '2001' };
  return `${formatDownloadName(template, sample)}.${ext}`;
}
