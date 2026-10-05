// Ported from Monochrome (Apache-2.0), js/lyrics.js cleanTrackerSearch - adapted for Fiesta.
// Title/artist normalisation also follows @uimaxbai/am-lyrics (MPL-2.0) parseQueryMetadata.
import type { MusicTrack } from '../services/music.service';

export interface MusicLyricsQuery {
  trackId: number;
  title: string;
  artist: string;
  album?: string;
  /** Seconds. */
  durationSec?: number;
  isrc?: string;
}

/** Strips emoji, symbols and "[v 3]" tags that confuse lyric search. */
export function cleanTrackerSearch(text: string): string {
  if (!text) return '';
  let cleaned = text.replace(
    /[\p{Extended_Pictographic}\p{Emoji_Presentation}\p{Emoji_Modifier}\p{Emoji_Modifier_Base}\p{Symbol}]/gu,
    '',
  );
  cleaned = cleaned.replace(/[☀-➿⭐⬆↔↪⤴‼⁉〰〽㊗㊙]/g, '');
  cleaned = cleaned.replace(/\[v\s*\d+\s*\]/gi, '');
  return cleaned.replace(/\s+/g, ' ').trim();
}

const FEAT = /\s*[([]\s*(?:feat\.?|ft\.?|featuring|with|prod\.?)\s[^)\]]*[)\]]/gi;
const VERSION_PAREN =
  /\s*[([][^)\]]*\b(?:remaster(?:ed)?|remix|mono|stereo|deluxe|anniversary|bonus|radio edit|single version|album version|explicit|clean|version|edit|live|acoustic|demo|instrumental)\b[^)\]]*[)\]]/gi;
const VERSION_DASH =
  /\s+-\s+(?:\d{4}\s+)?(?:remaster(?:ed)?(?:\s+\d{4})?|remix|mono|stereo|deluxe.*|\d+(?:th)? anniversary.*|radio edit|single version|album version|live.*|acoustic.*|demo.*|bonus track|version.*)\s*$/i;
const TRAILING_FEAT = /\s+(?:feat\.?|ft\.?|featuring)\s+.+$/i;

/** "Song (feat. X) - 2011 Remaster" -> "Song". Falls back to the input when cleaning empties it. */
export function cleanTitle(title: string): string {
  let t = cleanTrackerSearch(title);
  t = t.replace(FEAT, '').replace(VERSION_PAREN, '').replace(VERSION_DASH, '').replace(TRAILING_FEAT, '');
  t = t.replace(/\s+/g, ' ').trim();
  return t || cleanTrackerSearch(title) || title.trim();
}

/** The lead artist: first credited artist, else the first name in "A, B & C" / "A feat. B". */
export function primaryArtist(track: Pick<MusicTrack, 'artist' | 'artists'>): string {
  const credited = track.artists?.[0]?.name?.trim();
  if (credited) return cleanTrackerSearch(credited);
  const first = track.artist.split(/\s*(?:,|&|;|\bfeat\.?\s|\bft\.?\s|\bfeaturing\s|\bwith\s|\sx\s)\s*/i)[0];
  return cleanTrackerSearch(first || track.artist);
}

/** Splits "Title - Artist" or "Title by Artist" free text. */
export function parseQueryMetadata(raw: string): { title?: string; artist?: string } | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  const dash = trimmed.split(/\s[-–—]\s/);
  if (dash.length >= 2) {
    const title = dash[0].trim();
    const artist = dash.slice(1).join(' - ').trim();
    if (title && artist) return { title, artist };
  }
  const by = trimmed.split(/\s+by\s+/i);
  if (by.length === 2) {
    const [title, artist] = by.map((p) => p.trim());
    if (title && artist) return { title, artist };
  }
  return null;
}

/** What the providers are asked for, from a catalogue track. */
export function lyricsQueryFor(track: MusicTrack): MusicLyricsQuery {
  let title = cleanTitle(track.title ?? '');
  let artist = primaryArtist(track);
  if (!artist) {
    const parsed = parseQueryMetadata(track.title ?? '');
    if (parsed?.artist) {
      title = cleanTitle(parsed.title ?? title);
      artist = cleanTrackerSearch(parsed.artist);
    }
  }
  const q: MusicLyricsQuery = { trackId: track.id, title, artist };
  const album = cleanTrackerSearch(track.album ?? '');
  if (album) q.album = album;
  if (track.duration > 0) q.durationSec = Math.round(track.duration);
  if (track.isrc?.trim()) q.isrc = track.isrc.trim();
  return q;
}
