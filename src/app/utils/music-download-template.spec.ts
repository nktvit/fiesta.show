import { MusicTrack } from '../services/music.service';
import { flatName, formatDownloadName, nameDataFor, previewTemplate, safeName, uniqueName } from './music-download-template';

describe('music-download-template', () => {
  const data = { artist: 'AC/DC', album: 'Back: In Black', title: 'Hells Bells?', track: 3, year: '1980' };

  it('fills every token and sanitises unsafe characters', () => {
    expect(formatDownloadName('{artist} - {title}', data)).toBe('AC DC - Hells Bells');
    expect(formatDownloadName('{track} - {title} ({album}, {year})', data)).toBe('03 - Hells Bells (Back In Black, 1980)');
  });

  it('keeps / in the template as folders and drops dot segments', () => {
    expect(formatDownloadName('{artist}/{album}/../{track} {title}', data)).toBe('AC DC/Back In Black/03 Hells Bells');
    expect(flatName('a/b/c')).toBe('a - b - c');
  });

  it('falls back for empty values and never returns an empty name', () => {
    expect(formatDownloadName('{artist} - {title}', { artist: '', album: '', title: '', track: 0, year: '' })).toBe('Unknown Artist - Unknown Title');
    expect(formatDownloadName('///', data)).toBe('Hells Bells');
    expect(formatDownloadName('{track}', { ...data, track: 0 })).toBe('00');
  });

  it('pads the track number to the requested width', () => {
    expect(formatDownloadName('{track}', { ...data, track: 7 }, 3)).toBe('007');
  });

  it('safeName strips trailing dots and caps the length', () => {
    expect(safeName('Song...')).toBe('Song');
    expect(safeName('x'.repeat(300)).length).toBe(120);
  });

  it('uniqueName adds (2), (3) before the extension', () => {
    const used = new Set<string>();
    expect(uniqueName('a.flac', used)).toBe('a.flac');
    expect(uniqueName('A.flac', used)).toBe('A (2).flac');
    expect(uniqueName('a.flac', used)).toBe('a (3).flac');
  });

  it('nameDataFor prefers the track release year and the bulk position', () => {
    const t = { title: 'S', artist: 'X', album: 'Alb', trackNumber: 5, releaseDate: '1999-02-03', version: 'Live' } as MusicTrack;
    const d = nameDataFor(t, { title: 'Alb', year: '2001', artist: 'X' }, 2);
    expect(d).toEqual({ artist: 'X', album: 'Alb', title: 'S (Live)', track: 2, year: '1999' });
  });

  it('previews the default template as "<Artist> - <Title>.flac"', () => {
    expect(previewTemplate('{artist} - {title}')).toBe('Daft Punk - One More Time.flac');
    expect(previewTemplate('{track} - {title}', 'm4a')).toBe('01 - One More Time.m4a');
  });
});
