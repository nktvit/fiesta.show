import { dataUrlBytes } from './music-collage';
import { MusicHistoryEntry } from '../services/music-library.service';
import { MusicTrack } from '../services/music.service';
import {
  distinctCovers, filterByName, filterTracks, groupHistory, sortTracks, totalDuration,
} from './music-library-sort';

const t = (id: number, title: string, artist: string, album: string, duration: number, addedAt = 0, cover = ''): MusicTrack & { addedAt: number } =>
  ({ id, title, artist, album, duration, addedAt, cover } as MusicTrack & { addedAt: number });

describe('music-library-sort', () => {
  const list = [
    t(1, 'b song', 'Zed', 'Alpha', 200, 10),
    t(2, 'A song', 'amy', 'Gamma', 100, 30),
    t(3, 'c song', 'Bob', 'Beta', 300, 20),
  ];

  it('sorts recently added newest first', () => {
    expect(sortTracks(list, 'added').map((x) => x.id)).toEqual([2, 3, 1]);
  });
  it('sorts by title ignoring case', () => {
    expect(sortTracks(list, 'title').map((x) => x.id)).toEqual([2, 1, 3]);
  });
  it('sorts by artist, album and duration', () => {
    expect(sortTracks(list, 'artist').map((x) => x.id)).toEqual([2, 3, 1]);
    expect(sortTracks(list, 'album').map((x) => x.id)).toEqual([1, 3, 2]);
    expect(sortTracks(list, 'duration').map((x) => x.id)).toEqual([2, 1, 3]);
  });
  it('keeps order for custom and does not mutate', () => {
    const copy = [...list];
    expect(sortTracks(list, 'custom').map((x) => x.id)).toEqual([1, 2, 3]);
    sortTracks(list, 'title');
    expect(list).toEqual(copy);
  });
  it('keeps given order on equal addedAt', () => {
    const same = [t(1, 'a', 'x', 'y', 1, 5), t(2, 'b', 'x', 'y', 1, 5)];
    expect(sortTracks(same, 'added').map((x) => x.id)).toEqual([1, 2]);
  });
  it('filters tracks by title, artist or album', () => {
    expect(filterTracks(list, 'BOB').map((x) => x.id)).toEqual([3]);
    expect(filterTracks(list, 'alpha').map((x) => x.id)).toEqual([1]);
    expect(filterTracks(list, '  ').length).toBe(3);
  });
  it('filters by name', () => {
    expect(filterByName(['Rock', 'Jazz'], 'ja', (x) => x)).toEqual(['Jazz']);
  });
  it('picks distinct covers', () => {
    const c = [{ cover: 'a' }, { cover: '' }, { cover: 'a' }, { cover: 'b' }, { cover: 'c' }, { cover: 'd' }, { cover: 'e' }];
    expect(distinctCovers(c)).toEqual(['a', 'b', 'c', 'd']);
    expect(distinctCovers(c, 2)).toEqual(['a', 'b']);
  });
  it('sums durations', () => {
    expect(totalDuration(list)).toBe(600);
  });
  it('groups history into Today / Yesterday / Earlier', () => {
    const now = new Date(2026, 9, 5, 15, 0, 0).getTime();
    const e = (playedAt: number): MusicHistoryEntry => ({ track: list[0], playedAt });
    const g = groupHistory([e(now - 1000), e(new Date(2026, 9, 4, 23, 0).getTime()), e(new Date(2026, 9, 1, 12).getTime())], now);
    expect(g.map((x) => x.label)).toEqual(['Today', 'Yesterday', 'Earlier']);
    expect(groupHistory([e(now - 1000)], now).map((x) => x.label)).toEqual(['Today']);
    expect(groupHistory([], now)).toEqual([]);
  });
  it('measures a data URL payload in bytes', () => {
    expect(dataUrlBytes('data:image/jpeg;base64,AAAA')).toBe(3);
    expect(dataUrlBytes('data:image/jpeg;base64,' + 'A'.repeat(400))).toBe(300);
  });
});
