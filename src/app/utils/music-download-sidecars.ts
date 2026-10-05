import { MusicAlbum, MusicTrack } from '../services/music.service';
import { DownloadSidecars } from './music-download-prefs';
import { generateCUE, generateJSON, generateM3U8, generateNFO, PlaylistFileMeta, sanitizeForFilename } from './music-playlist-files';

/** The text sidecar files of a bulk download. Pure. Owned by package P12. */

export interface SidecarFile {
  name: string;
  text: string;
}

/**
 * m3u8 / cue / nfo / json for a bulk download. `paths[i]` is the saved path of
 * track i ('' when that track failed, which the M3U8 then skips).
 */
export function buildSidecars(
  toggles: DownloadSidecars,
  meta: PlaylistFileMeta,
  tracks: MusicTrack[],
  paths: string[],
  album?: MusicAlbum | null,
): SidecarFile[] {
  const base = sanitizeForFilename(meta.title) || 'playlist';
  const out: SidecarFile[] = [];
  if (toggles.m3u8) out.push({ name: `${base}.m3u8`, text: generateM3U8(meta, tracks, paths) });
  if (toggles.cue) {
    const first = paths.find(Boolean) ?? '';
    const cueAlbum: MusicAlbum = album ?? { id: 0, title: meta.title, artist: meta.creator || '', cover: meta.cover || '', year: '', tracks: tracks.length, duration: 0, quality: '' };
    out.push({ name: `${base}.cue`, text: generateCUE(cueAlbum, tracks, first.split('/').pop() || `${base}.flac`) });
  }
  if (toggles.nfo) out.push({ name: `${base}.nfo`, text: generateNFO(meta, tracks) });
  if (toggles.json) out.push({ name: `${base}.json`, text: generateJSON(meta, tracks) });
  return out;
}

/** "01 - Title.flac" -> "01 - Title.lrc" (swap the extension). */
export function sidecarNameFor(audioPath: string, ext: string): string {
  const dot = audioPath.lastIndexOf('.');
  const slash = audioPath.lastIndexOf('/');
  return (dot > slash ? audioPath.slice(0, dot) : audioPath) + '.' + ext;
}
