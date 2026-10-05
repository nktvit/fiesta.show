import { activeGap, activeLineIndex, findInstrumentalGaps, interpolatePosition, isLineSounding, syllableProgress } from './music-lyrics-sync';
import type { MusicLyricLine } from './music-lyrics-types';

const lines: MusicLyricLine[] = [
  { start: 10, end: 14, text: 'a' },
  { start: 14, end: 16, text: 'b' },
  { start: 15, end: 16, text: 'bg', background: true },
  { start: 30, end: 33, text: 'c' },
  { start: 34, end: 36, text: 'd' },
];

describe('music-lyrics-sync', () => {
  it('finds the active line by binary search, skipping background lines', () => {
    expect(activeLineIndex(lines, 0)).toBe(-1);
    expect(activeLineIndex(lines, 10)).toBe(0);
    expect(activeLineIndex(lines, 13.9)).toBe(0);
    expect(activeLineIndex(lines, 14)).toBe(1);
    expect(activeLineIndex(lines, 15.5)).toBe(1);
  });

  it('is -1 inside an instrumental gap and after the last line', () => {
    expect(activeLineIndex(lines, 20)).toBe(-1);
    expect(activeLineIndex(lines, 30)).toBe(3);
    expect(activeLineIndex(lines, 33.5)).toBe(3); // gap of 1 s: stays on the line
    expect(activeLineIndex(lines, 34)).toBe(4);
    expect(activeLineIndex(lines, 40)).toBe(-1);
  });

  it('detects gaps over 5 s, including before the first line', () => {
    expect(findInstrumentalGaps(lines)).toEqual([
      { beforeIndex: 0, start: 0, end: 10 },
      { beforeIndex: 3, start: 16, end: 30 },
    ]);
    expect(findInstrumentalGaps([{ start: 1, end: 2, text: 'x' }, { start: 6.9, end: 8, text: 'y' }])).toEqual([]);
    expect(findInstrumentalGaps([{ start: 1, end: 2, text: 'x' }, { start: 7, end: 8, text: 'y' }]).length).toBe(1);
    expect(findInstrumentalGaps([])).toEqual([]);
    const gaps = findInstrumentalGaps(lines);
    expect(activeGap(gaps, 20)?.beforeIndex).toBe(3);
    expect(activeGap(gaps, 12)).toBeNull();
  });

  it('computes syllable progress', () => {
    const s = { start: 2, end: 4 };
    expect(syllableProgress(s, 1)).toBe(0);
    expect(syllableProgress(s, 3)).toBe(0.5);
    expect(syllableProgress(s, 5)).toBe(1);
    expect(syllableProgress({ start: 2, end: 2 }, 2.1)).toBe(1);
    expect(isLineSounding(lines[0], 12)).toBeTrue();
    expect(isLineSounding(lines[0], 14)).toBeFalse();
  });

  it('interpolates the player clock between timeupdates', () => {
    const anchor = { position: 10, at: 1000 };
    expect(interpolatePosition(anchor, 1500, true, 1, 100)).toBeCloseTo(10.5, 5);
    expect(interpolatePosition(anchor, 1500, true, 2, 100)).toBeCloseTo(11, 5);
    expect(interpolatePosition(anchor, 1500, false, 1, 100)).toBe(10);
    expect(interpolatePosition(anchor, 9000, true, 1, 12)).toBe(12);
  });
});
