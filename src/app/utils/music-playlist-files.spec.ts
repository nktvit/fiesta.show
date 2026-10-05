import { MusicTrack } from '../services/music.service';
import {
  csvEscape, generateCSV, generateCUE, generateFullCSV, generateJSON, generateM3U, generateM3U8, generateNFO,
  generateXML, generateXSPF, playlistFileName,
} from './music-playlist-files';

const track = (over: Partial<MusicTrack> = {}): MusicTrack => ({
  id: 1, title: 'Hello, "World"', artist: 'A & B', artistId: 1, album: 'Alb', albumId: 2, cover: '', duration: 187.4,
  explicit: false, trackNumber: 3, quality: '', ...over,
});

const meta = { title: 'My <list>', creator: 'me', description: 'd' };

describe('music-playlist-files', () => {
  beforeEach(() => jasmine.clock().install().mockDate(new Date('2026-01-02T03:04:05.000Z')));
  afterEach(() => jasmine.clock().uninstall());

  it('csvEscape quotes commas, quotes and newlines', () => {
    expect(csvEscape('plain')).toBe('plain');
    expect(csvEscape('a,b')).toBe('"a,b"');
    expect(csvEscape('say "hi"')).toBe('"say ""hi"""');
    expect(csvEscape('l1\nl2')).toBe('"l1\nl2"');
    expect(csvEscape(null)).toBe('');
  });

  it('generateCSV snapshot', () => {
    expect(generateCSV(meta, [track()])).toBe(
      '"Track Name","Artist Name(s)","Album","Duration"\n"Hello, ""World""","A & B","Alb","3:07"\n',
    );
  });

  it('generateFullCSV quotes fields with commas and newlines', () => {
    const csv = generateFullCSV(meta, [track({ title: 'two\nlines', copyright: '(c) a, b', isrc: 'USX123' })]);
    expect(csv.split('\n')[0]).toBe(
      'Position,Track Name,Artist Name(s),Album,Track Number,Duration (seconds),Duration,ISRC,Release Date,Explicit,Copyright,Track ID,Album ID,Version,Added At',
    );
    expect(csv).toContain('1,"two\nlines",A & B,Alb,3,187,3:07,USX123,,false,"(c) a, b",1,2,,');
  });

  it('generateJSON snapshot (parsed)', () => {
    const j = JSON.parse(generateJSON(meta, [track({ isrc: 'USX123' })]));
    expect(j.format).toBe('fiesta-playlist');
    expect(j.generated).toBe('2026-01-02T03:04:05.000Z');
    expect(j.playlist).toEqual({ title: 'My <list>', description: 'd', creator: 'me', cover: null, numberOfTracks: 1 });
    expect(j.tracks[0]).toEqual(jasmine.objectContaining({ position: 1, id: 1, isrc: 'USX123', duration: 187, album: 'Alb' }));
  });

  it('generateXSPF escapes XML', () => {
    expect(generateXSPF(meta, [track()])).toBe(
      '<?xml version="1.0" encoding="UTF-8"?>\n'
      + '<playlist xmlns="http://xspf.org/ns/0/" version="1">\n'
      + '  <title>My &lt;list&gt;</title>\n  <creator>me</creator>\n  <annotation>d</annotation>\n'
      + '  <date>2026-01-02T03:04:05.000Z</date>\n  <trackList>\n    <track>\n'
      + '      <title>Hello, &quot;World&quot;</title>\n      <creator>A &amp; B</creator>\n      <album>Alb</album>\n'
      + '      <duration>187400</duration>\n    </track>\n  </trackList>\n</playlist>\n',
    );
  });

  it('generateXML and NFO are well-formed', () => {
    for (const xml of [generateXML(meta, [track()]), generateNFO(meta, [track()])]) {
      const doc = new DOMParser().parseFromString(xml, 'application/xml');
      expect(doc.getElementsByTagName('parsererror').length).toBe(0);
      expect(xml).toContain('A &amp; B');
    }
  });

  it('generateM3U snapshot', () => {
    expect(generateM3U(meta, [track()])).toBe(
      '#EXTM3U\n#PLAYLIST:My list\n#ARTIST:me\n#DATE:2026-01-02\n\n'
      + '#EXTINF:187,A & B - Hello, "World"\n01 - A & B - Hello, World.flac\n\n',
    );
  });

  it('generateM3U with explicit paths skips missing ones', () => {
    const out = generateM3U(meta, [track(), track({ id: 2, title: 'Two' })], ['a.flac', '']);
    expect(out).toContain('a.flac');
    expect(out).not.toContain('Two');
  });

  it('generateM3U8 has #EXTINF with duration and a sane target duration', () => {
    const out = generateM3U8(meta, [track(), track({ id: 2, duration: 300 })]);
    expect(out).toContain('#EXT-X-TARGETDURATION:300');
    expect(out).toContain('#EXTINF:187.000,A & B - Hello, "World"');
    expect(out.endsWith('#EXT-X-ENDLIST\n')).toBeTrue();
  });

  it('generateM3U8 on an empty list does not emit -Infinity', () => {
    const out = generateM3U8(meta, []);
    expect(out).toContain('#EXT-X-TARGETDURATION:0');
    expect(out).not.toContain('Infinity');
  });

  it('generateCUE snapshot', () => {
    const album = { id: 2, title: 'Alb', artist: 'Art', cover: '', year: '', tracks: 1, duration: 0, quality: '' };
    expect(generateCUE(album, [track()], 'alb.flac')).toBe(
      'PERFORMER "Art"\nTITLE "Alb"\nFILE "alb.flac" FLAC\n  TRACK 03 AUDIO\n    TITLE "Hello, \'World\'"\n'
      + '    PERFORMER "A & B"\n    INDEX 01 00:00:00\n',
    );
  });

  it('playlistFileName sanitises', () => {
    expect(playlistFileName('a/b:c', 'csv')).toBe('a b c.csv');
    expect(playlistFileName('   ', 'm3u')).toBe('playlist.m3u');
  });
});
