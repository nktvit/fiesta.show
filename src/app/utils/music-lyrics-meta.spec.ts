import type { MusicTrack } from '../services/music.service';
import { cleanTitle, cleanTrackerSearch, lyricsQueryFor, parseQueryMetadata, primaryArtist } from './music-lyrics-meta';

describe('music-lyrics-meta', () => {
  it('cleans titles of feat., remaster and version noise', () => {
    expect(cleanTitle('Song Name (feat. Someone)')).toBe('Song Name');
    expect(cleanTitle('Song Name - 2011 Remaster')).toBe('Song Name');
    expect(cleanTitle('Song Name - Remastered 2009')).toBe('Song Name');
    expect(cleanTitle('Song Name (Remastered)')).toBe('Song Name');
    expect(cleanTitle('Song Name [Live at Wembley]')).toBe('Song Name');
    expect(cleanTitle('Song Name ft. X')).toBe('Song Name');
    expect(cleanTitle('Live and Let Die')).toBe('Live and Let Die');
    expect(cleanTitle('(Remastered)')).toBe('(Remastered)');
  });

  it('strips emoji and version tags for search', () => {
    expect(cleanTrackerSearch('Fire \u{1F525} Track [v 2]')).toBe('Fire Track');
    expect(cleanTrackerSearch('')).toBe('');
  });

  it('picks the lead artist', () => {
    expect(primaryArtist({ artist: 'A, B & C', artists: [{ id: 1, name: 'A' }, { id: 2, name: 'B' }] })).toBe('A');
    expect(primaryArtist({ artist: 'Alpha & Beta' })).toBe('Alpha');
    expect(primaryArtist({ artist: 'Alpha feat. Beta' })).toBe('Alpha');
  });

  it('parses "Title - Artist" and "Title by Artist"', () => {
    expect(parseQueryMetadata('Hello - Adele')).toEqual({ title: 'Hello', artist: 'Adele' });
    expect(parseQueryMetadata('Hello by Adele')).toEqual({ title: 'Hello', artist: 'Adele' });
    expect(parseQueryMetadata('just words')).toBeNull();
  });

  it('builds the provider query from a track', () => {
    const t = { id: 5, title: 'Song (feat. Z)', artist: 'Main, Z', album: 'LP', duration: 200.4, isrc: ' USXX12345678 ', artists: [{ id: 1, name: 'Main' }] } as MusicTrack;
    expect(lyricsQueryFor(t)).toEqual({ trackId: 5, title: 'Song', artist: 'Main', album: 'LP', durationSec: 200, isrc: 'USXX12345678' });
  });
});
