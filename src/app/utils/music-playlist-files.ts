// Ported from Monochrome (Apache-2.0), js/playlist-generator.js and js/playlist-importer.js (generators) - adapted for Fiesta.
import { MusicAlbum, MusicTrack } from '../services/music.service';

/**
 * Playlist file generators (CSV, JSON, XSPF, XML, M3U/M3U8, CUE, NFO).
 * Pure functions: tracks in, file text out. Owned by package P7.
 */
export interface PlaylistFileMeta {
  title: string;
  description?: string;
  creator?: string;
  cover?: string;
}

type TrackLike = MusicTrack & { addedAt?: number };

// ── helpers ────────────────────────────────────────────────────────────────

export function escapeXml(text: unknown): string {
  if (text === null || text === undefined) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** RFC 4180 field: quoted when it holds a comma, quote, CR or LF. */
export function csvEscape(value: unknown): string {
  const str = value === null || value === undefined ? '' : String(value);
  return /[",\n\r]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

function csvRow(values: unknown[]): string {
  return values.map(csvEscape).join(',');
}

export function formatMmSs(seconds: number): string {
  const total = Math.max(0, Math.round(seconds || 0));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function artistsOf(t: MusicTrack): string {
  if (t.artists && t.artists.length > 0) return t.artists.map((a) => a.name).join(', ');
  return t.artist || 'Unknown Artist';
}

/** Characters that are unsafe in file names, replaced with a space. */
export function sanitizeForFilename(name: string): string {
  // eslint-disable-next-line no-control-regex
  return (name || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
}

/** "My list" + "csv" -> "My list.csv" (falls back to "playlist"). */
export function playlistFileName(title: string, ext: string): string {
  return `${sanitizeForFilename(title) || 'playlist'}.${ext}`;
}

function isoDate(): string {
  return new Date().toISOString();
}

function dayStamp(): string {
  return isoDate().split('T')[0];
}

function trackFilename(t: MusicTrack, n: number, ext: string): string {
  const num = String(n).padStart(2, '0');
  return `${num} - ${sanitizeForFilename(artistsOf(t))} - ${sanitizeForFilename(t.title || 'Unknown Title')}.${ext}`;
}

function isoOrNull(v: number | string | undefined): string | null {
  if (v === undefined || v === null || v === '') return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// ── CSV / JSON ─────────────────────────────────────────────────────────────

/** Small CSV: Track Name, Artist Name(s), Album, Duration (m:ss). Every field quoted. */
export function generateCSV(meta: PlaylistFileMeta, tracks: MusicTrack[]): string {
  void meta;
  const q = (s: string) => `"${String(s ?? '').replace(/"/g, '""')}"`;
  const lines = [['Track Name', 'Artist Name(s)', 'Album', 'Duration'].map(q).join(',')];
  for (const t of tracks) {
    lines.push([t.title || '', artistsOf(t), t.album || '', formatMmSs(t.duration)].map(q).join(','));
  }
  return lines.join('\n') + '\n';
}

/** Full-metadata CSV (the importer reads this back). */
export function generateFullCSV(meta: PlaylistFileMeta, tracks: MusicTrack[]): string {
  void meta;
  const headers = [
    'Position', 'Track Name', 'Artist Name(s)', 'Album', 'Track Number', 'Duration (seconds)', 'Duration', 'ISRC',
    'Release Date', 'Explicit', 'Copyright', 'Track ID', 'Album ID', 'Version', 'Added At',
  ];
  const lines = [csvRow(headers)];
  (tracks as TrackLike[]).forEach((t, i) => {
    lines.push(csvRow([
      String(i + 1), t.title || '', artistsOf(t), t.album || '', t.trackNumber ? String(t.trackNumber) : '',
      String(Math.round(t.duration || 0)), formatMmSs(t.duration), t.isrc || '', t.releaseDate || '',
      t.explicit ? 'true' : 'false', t.copyright || '', t.id != null ? String(t.id) : '',
      t.albumId != null ? String(t.albumId) : '', t.version || '', isoOrNull(t.addedAt) ?? '',
    ]));
  });
  return lines.join('\n') + '\n';
}

export function generateJSON(meta: PlaylistFileMeta, tracks: MusicTrack[]): string {
  const data = {
    format: 'fiesta-playlist',
    version: '1.0',
    generated: isoDate(),
    playlist: {
      title: meta.title || 'Unknown',
      description: meta.description || null,
      creator: meta.creator || null,
      cover: meta.cover && !meta.cover.startsWith('data:') ? meta.cover : null,
      numberOfTracks: tracks.length,
    },
    tracks: (tracks as TrackLike[]).map((t, i) => ({
      position: i + 1,
      id: t.id ?? null,
      title: t.title || null,
      artist: artistsOf(t),
      artists: (t.artists ?? []).map((a) => ({ id: a.id ?? null, name: a.name ?? null })),
      album: t.album || null,
      albumId: t.albumId ?? null,
      trackNumber: t.trackNumber || null,
      duration: Math.round(t.duration || 0),
      isrc: t.isrc || null,
      explicit: !!t.explicit,
      copyright: t.copyright || null,
      version: t.version || null,
      releaseDate: t.releaseDate || null,
      addedAt: isoOrNull(t.addedAt),
    })),
  };
  return JSON.stringify(data, null, 2);
}

// ── XML formats ────────────────────────────────────────────────────────────

export function generateXSPF(meta: PlaylistFileMeta, tracks: MusicTrack[]): string {
  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
  xml += '<playlist xmlns="http://xspf.org/ns/0/" version="1">\n';
  xml += `  <title>${escapeXml(meta.title || 'Unknown Playlist')}</title>\n`;
  xml += `  <creator>${escapeXml(meta.creator || 'Various Artists')}</creator>\n`;
  if (meta.description) xml += `  <annotation>${escapeXml(meta.description)}</annotation>\n`;
  xml += `  <date>${isoDate()}</date>\n`;
  xml += '  <trackList>\n';
  for (const t of tracks) {
    xml += '    <track>\n';
    xml += `      <title>${escapeXml(t.title || 'Unknown Title')}</title>\n`;
    xml += `      <creator>${escapeXml(artistsOf(t))}</creator>\n`;
    if (t.album) xml += `      <album>${escapeXml(t.album)}</album>\n`;
    if (t.duration) xml += `      <duration>${Math.round(t.duration * 1000)}</duration>\n`;
    if (t.isrc) xml += `      <identifier>isrc:${escapeXml(t.isrc)}</identifier>\n`;
    xml += '    </track>\n';
  }
  xml += '  </trackList>\n</playlist>\n';
  return xml;
}

export function generateXML(meta: PlaylistFileMeta, tracks: MusicTrack[]): string {
  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<playlist>\n';
  xml += `  <name>${escapeXml(meta.title || 'Unknown Playlist')}</name>\n`;
  xml += `  <creator>${escapeXml(meta.creator || 'Various Artists')}</creator>\n`;
  xml += `  <created>${isoDate()}</created>\n`;
  xml += `  <trackCount>${tracks.length}</trackCount>\n  <tracks>\n`;
  tracks.forEach((t, i) => {
    xml += '    <track>\n';
    xml += `      <position>${i + 1}</position>\n`;
    xml += `      <title>${escapeXml(t.title || '')}</title>\n`;
    xml += `      <artist>${escapeXml(artistsOf(t))}</artist>\n`;
    xml += `      <album>${escapeXml(t.album || '')}</album>\n`;
    xml += `      <duration>${Math.round(t.duration || 0)}</duration>\n`;
    if (t.isrc) xml += `      <isrc>${escapeXml(t.isrc)}</isrc>\n`;
    xml += '    </track>\n';
  });
  xml += '  </tracks>\n</playlist>\n';
  return xml;
}

export function generateNFO(meta: PlaylistFileMeta, tracks: MusicTrack[]): string {
  let xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<musicplaylist>\n';
  xml += `  <title>${escapeXml(meta.title || 'Unknown Playlist')}</title>\n`;
  xml += `  <artist>${escapeXml(meta.creator || 'Various Artists')}</artist>\n`;
  xml += `  <dateadded>${isoDate()}</dateadded>\n`;
  tracks.forEach((t, i) => {
    xml += '  <track>\n';
    xml += `    <position>${i + 1}</position>\n`;
    xml += `    <title>${escapeXml(t.title || '')}</title>\n`;
    xml += `    <artist>${escapeXml(artistsOf(t))}</artist>\n`;
    xml += `    <album>${escapeXml(t.album || '')}</album>\n`;
    xml += `    <duration>${Math.round(t.duration || 0)}</duration>\n`;
    xml += `    <musicbrainztrackid>${t.id ?? ''}</musicbrainztrackid>\n`;
    xml += '  </track>\n';
  });
  xml += '</musicplaylist>\n';
  return xml;
}

// ── M3U / M3U8 / CUE ───────────────────────────────────────────────────────

function m3uHeader(meta: PlaylistFileMeta): string {
  let c = '';
  if (meta.title) c += `#PLAYLIST:${sanitizeForFilename(meta.title)}\n`;
  if (meta.creator) c += `#ARTIST:${meta.creator}\n`;
  c += `#DATE:${dayStamp()}\n\n`;
  return c;
}

/** `paths[i]` is the file path of track i; without it a "NN - Artist - Title.flac" name is written. */
export function generateM3U(meta: PlaylistFileMeta, tracks: MusicTrack[], paths?: string[]): string {
  let c = '#EXTM3U\n' + m3uHeader(meta);
  tracks.forEach((t, i) => {
    const path = paths ? paths[i] : trackFilename(t, i + 1, 'flac');
    if (paths && !path) return;
    c += `#EXTINF:${Math.round(t.duration || 0)},${artistsOf(t)} - ${t.title || 'Unknown Title'}\n${path}\n\n`;
  });
  return c;
}

export function generateM3U8(meta: PlaylistFileMeta, tracks: MusicTrack[], paths?: string[]): string {
  // Upstream used Math.max(...[]), which is -Infinity for an empty list.
  const maxDuration = tracks.reduce((m, t) => Math.max(m, Math.round(t.duration || 0)), 0);
  let c = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-PLAYLIST-TYPE:VOD\n';
  c += `#EXT-X-TARGETDURATION:${maxDuration}\n`;
  c += m3uHeader(meta);
  tracks.forEach((t, i) => {
    const path = paths ? paths[i] : trackFilename(t, i + 1, 'flac');
    if (paths && !path) return;
    c += `#EXTINF:${Math.round(t.duration || 0)}.000,${artistsOf(t)} - ${t.title || 'Unknown Title'}\n${path}\n\n`;
  });
  c += '#EXT-X-ENDLIST\n';
  return c;
}

export function generateCUE(album: MusicAlbum, tracks: MusicTrack[], audioFile: string): string {
  const q = (s: string) => String(s).replace(/"/g, "'");
  const ext = (audioFile.split('.').pop() || 'FLAC').toUpperCase();
  let c = `PERFORMER "${q(album.artist || 'Unknown Artist')}"\n`;
  c += `TITLE "${q(album.title || 'Unknown Album')}"\n`;
  c += `FILE "${q(audioFile)}" ${ext}\n`;
  tracks.forEach((t, i) => {
    c += `  TRACK ${String(t.trackNumber || i + 1).padStart(2, '0')} AUDIO\n`;
    c += `    TITLE "${q(t.title || 'Unknown Track')}"\n`;
    c += `    PERFORMER "${q(artistsOf(t) || album.artist)}"\n`;
    c += '    INDEX 01 00:00:00\n';
  });
  return c;
}

/** CSV of the rows an import could not match (re-importable later). */
export function generateMissingCSV(
  rows: { title?: string; artist?: string; album?: string; isrc?: string; type?: string }[],
): string {
  const lines = [csvRow(['Type', 'Track Name', 'Artist Name(s)', 'Album', 'ISRC'])];
  for (const r of rows) lines.push(csvRow([r.type || 'track', r.title || '', r.artist || '', r.album || '', r.isrc || '']));
  return lines.join('\n') + '\n';
}

// ── saving ─────────────────────────────────────────────────────────────────

/** Offers `text` as a download. No-op without a DOM. Returns true when the click was issued. */
export function saveTextFile(fileName: string, text: string, mime = 'text/plain'): boolean {
  if (typeof document === 'undefined' || typeof URL === 'undefined') return false;
  try {
    const blob = new Blob([text], { type: `${mime};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.rel = 'noopener';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    return true;
  } catch {
    return false;
  }
}
