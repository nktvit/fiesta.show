import {
  detectImportFormat, mapHeaders, parseCsv, parseImportText, parseJspf, parseM3u, parseXml, parseXspf,
} from './music-import-parse';

describe('music-import-parse', () => {
  it('parses an Exportify CSV with quoted commas and newlines', async () => {
    const csv = '﻿"Track URI","Track Name","Album Name","Artist Name(s)","Duration (ms)"\n'
      + '"spotify:track:1","Hello, World","Greatest ""Hits""","Artist A, Artist B",200000\n'
      + '"spotify:track:2","Two\nLines","Alb","Solo",1000\n';
    const p = await parseCsv(csv);
    expect(p.label).toBe('Exportify CSV');
    expect(p.rows.length).toBe(2);
    expect(p.rows[0]).toEqual(jasmine.objectContaining({ type: 'track', title: 'Hello, World', artist: 'Artist A, Artist B', album: 'Greatest "Hits"' }));
    expect(p.rows[1].title).toBe('Two Lines');
  });

  it('parses Spotify-style CSV with ISRC, playlist name and favourites', async () => {
    const csv = 'Type,Track Name,Artist Name,Album,ISRC,Playlist Name,Spotify - id\n'
      + 'Favorite,Song,Art,Alb,US-ABC-12-34567,Mix,abc\n';
    const p = await parseCsv(csv);
    expect(p.label).toBe('Spotify CSV');
    expect(p.name).toBe('Mix');
    expect(p.rows[0]).toEqual(jasmine.objectContaining({ isrc: 'US-ABC-12-34567', favorite: true, playlist: 'Mix', type: 'track' }));
  });

  it('library CSV: album and artist rows', async () => {
    const csv = 'Type,Track Name,Artist Name,Album\nalbum,,Art,Alb\nartist,,Solo,\ntrack,T,Art,Alb\n';
    const p = await parseCsv(csv);
    expect(p.rows.map((r) => r.type)).toEqual(['album', 'artist', 'track']);
    expect(p.rows[0].title).toBe('Alb');
  });

  it('rejects CSVs without usable headers', async () => {
    await expectAsync(parseCsv('a,b\n1,2\n')).toBeRejected();
  });

  it('mapHeaders handles aliases, case and BOM', () => {
    expect(mapHeaders(['﻿TITLE', 'Artists', 'album_name', 'ISRC'])).toEqual({ track: 0, artist: 1, album: 2, isrc: 3 });
  });

  it('parses JSPF and returns name, description and cover', () => {
    const p = parseJspf(JSON.stringify({ playlist: {
      title: 'JS', annotation: 'About', image: 'http://x/y.jpg',
      track: [{ title: 'T1', creator: 'C1', album: 'A1', identifier: ['http://x', 'isrc:USABC1234567'] }, { title: '' }],
    } }));
    expect(p).toEqual(jasmine.objectContaining({ name: 'JS', description: 'About', cover: 'http://x/y.jpg' }));
    expect(p.rows).toEqual([{ type: 'track', title: 'T1', artist: 'C1', album: 'A1', isrc: 'USABC1234567' }]);
  });

  it('parses XSPF', () => {
    const p = parseXspf('<?xml version="1.0"?><playlist xmlns="http://xspf.org/ns/0/" version="1"><title>X</title><annotation>n</annotation>'
      + '<trackList><track><title>A &amp; B</title><creator>Art</creator><album>Al</album></track></trackList></playlist>');
    expect(p.name).toBe('X');
    expect(p.description).toBe('n');
    expect(p.rows[0]).toEqual(jasmine.objectContaining({ title: 'A & B', artist: 'Art', album: 'Al' }));
  });

  it('parses generic XML (song/performer variants)', () => {
    const p = parseXml('<library><name>L</name><song><name>S1</name><performer>P1</performer></song></library>');
    expect(p.name).toBe('L');
    expect(p.rows[0]).toEqual(jasmine.objectContaining({ title: 'S1', artist: 'P1' }));
  });

  it('rejects broken XML', () => {
    expect(() => parseXml('<a><b></a>')).toThrow();
  });

  it('parses M3U/M3U8 with #EXTINF artist - title and falls back to file names', () => {
    const p = parseM3u('#EXTM3U\n#PLAYLIST:Mine\n#EXTINF:187,Daft Punk - One More Time\n/m/01.flac\n\n'
      + '#EXTINF:30.000,Solo Title\nb.flac\n/music/02 - Some Artist - Some Song.mp3\n');
    expect(p.name).toBe('Mine');
    expect(p.rows.map((r) => [r.artist, r.title])).toEqual([
      ['Daft Punk', 'One More Time'], ['', 'Solo Title'], ['Some Artist', 'Some Song'],
    ]);
  });

  it('detects formats by extension and content', () => {
    expect(detectImportFormat('a.m3u8', '')).toBe('m3u');
    expect(detectImportFormat('a.txt', '{"playlist":{}}')).toBe('jspf');
    expect(detectImportFormat('a.xml', '<playlist xmlns="http://xspf.org/ns/0/"/>')).toBe('xspf');
    expect(detectImportFormat('a.xml', '<playlist/>')).toBe('xml');
    expect(detectImportFormat('a.dat', 'a,b\n1,2')).toBe('csv');
    expect(detectImportFormat('a.bin', 'zzz')).toBeNull();
  });

  it('parseImportText throws friendly errors', async () => {
    await expectAsync(parseImportText('x.bin', 'zzz')).toBeRejectedWithError(/Unsupported/);
    await expectAsync(parseImportText('x.m3u', '#EXTM3U\n')).toBeRejectedWithError(/No tracks/);
  });
});
