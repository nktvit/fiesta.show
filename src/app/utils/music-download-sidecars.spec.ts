import { MusicTrack } from '../services/music.service';
import { defaultDownloadPrefs, sanitizeDownloadPrefs } from './music-download-prefs';
import { buildSidecars, sidecarNameFor } from './music-download-sidecars';

const tracks = [
  { id: 1, title: 'One', artist: 'Ann', album: 'LP', trackNumber: 1, duration: 100 },
  { id: 2, title: 'Two', artist: 'Ann', album: 'LP', trackNumber: 2, duration: 200 },
] as MusicTrack[];

describe('music-download-sidecars', () => {
  const all = { cover: true, m3u8: true, cue: true, nfo: true, json: true };

  it('builds only the toggled sidecars', () => {
    const names = buildSidecars({ ...all, cue: false, nfo: false }, { title: 'LP', creator: 'Ann' }, tracks, ['01 - One.flac', '02 - Two.flac']).map((s) => s.name);
    expect(names).toEqual(['LP.m3u8', 'LP.json']);
    expect(buildSidecars(all, { title: 'LP' }, tracks, ['a', 'b']).map((s) => s.name)).toEqual(['LP.m3u8', 'LP.cue', 'LP.nfo', 'LP.json']);
  });

  it('writes the saved paths into the M3U8 and skips failed tracks', () => {
    const m3u = buildSidecars({ ...all, cue: false, nfo: false, json: false }, { title: 'LP' }, tracks, ['01 - One.flac', ''])[0].text;
    expect(m3u).toContain('01 - One.flac');
    expect(m3u).not.toContain('Two');
  });

  it('points the CUE at the first saved file', () => {
    const cue = buildSidecars({ ...all, m3u8: false, nfo: false, json: false }, { title: 'LP', creator: 'Ann' }, tracks, ['01 - One.flac', '02 - Two.flac'])[0].text;
    expect(cue).toContain('FILE "01 - One.flac" FLAC');
    expect(cue).toContain('TRACK 02 AUDIO');
  });

  it('swaps the extension for a sidecar name', () => {
    expect(sidecarNameFor('01 - One.flac', 'lrc')).toBe('01 - One.lrc');
    expect(sidecarNameFor('dir.x/Song', 'lrc')).toBe('dir.x/Song.lrc');
  });

  it('sanitises stored preferences', () => {
    expect(sanitizeDownloadPrefs(null)).toEqual(defaultDownloadPrefs());
    const p = sanitizeDownloadPrefs({ quality: 'BOGUS', trackTemplate: '  ', bulkMode: 'files', sidecars: { cue: true, m3u8: 'x' }, lyricsSidecar: 'ttml' });
    expect(p.quality).toBe('LOSSLESS');
    expect(p.trackTemplate).toBe('{artist} - {title}');
    expect(p.bulkMode).toBe('files');
    expect(p.sidecars.cue).toBeTrue();
    expect(p.sidecars.m3u8).toBeTrue();
    expect(p.lyricsSidecar).toBe('ttml');
  });
});
