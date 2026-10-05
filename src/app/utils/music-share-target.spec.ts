import { MusicLibraryItem, MusicTrack } from '../services/music.service';
import { musicSharePath, musicShareTarget, musicShareUrl } from './music-share-target';

const track: MusicTrack = {
  id: 42, title: 'One More Time', artist: 'Daft Punk', artistId: 8847, album: 'Discovery', albumId: 1550545,
  cover: '', duration: 320, explicit: false, trackNumber: 1, quality: 'LOSSLESS',
};

describe('music-share-target', () => {
  it('builds site paths per kind', () => {
    expect(musicSharePath({ kind: 'track', data: track })).toBe('/music/track/42');
    expect(musicSharePath({ kind: 'album', data: { id: 7 } as never })).toBe('/music/album/7');
    expect(musicSharePath({ kind: 'artist', data: { id: 9 } as never })).toBe('/music/artist/9');
    expect(musicSharePath({ kind: 'playlist', data: { uuid: 'abc-def' } as never })).toBe('/music/playlist/abc-def');
    expect(musicSharePath({ kind: 'mix', data: { id: 'mixid1' } as never })).toBe('/music/mix/mixid1');
    expect(musicSharePath({ kind: 'userPlaylist', data: {} as never })).toBeNull();
  });

  it('joins origin and path without doubling slashes', () => {
    expect(musicShareUrl('/music/track/1', 'https://fiesta.show')).toBe('https://fiesta.show/music/track/1');
    expect(musicShareUrl('/music/track/1', 'https://fiesta.show/')).toBe('https://fiesta.show/music/track/1');
  });

  it('describes a track share with an absolute Fiesta URL', async () => {
    const t = await musicShareTarget({ kind: 'track', data: track }, 'https://fiesta.show');
    expect(t).toEqual({ title: 'One More Time', text: 'One More Time - Daft Punk', url: 'https://fiesta.show/music/track/42' });
  });

  it('shares a visitor playlist as a /music/shared payload link, and nothing when it is empty', async () => {
    const pl = { id: 'p', name: 'Mine', description: '', tracks: [{ ...track, addedAt: 1 }], createdAt: 1, updatedAt: 1 };
    const item: MusicLibraryItem = { kind: 'userPlaylist', data: pl };
    const t = await musicShareTarget(item, 'https://fiesta.show');
    expect(t?.url).toContain('/music/shared?d=');
    expect(await musicShareTarget({ kind: 'userPlaylist', data: { ...pl, tracks: [] } })).toBeNull();
  });
});
