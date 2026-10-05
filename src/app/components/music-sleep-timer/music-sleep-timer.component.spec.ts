import { MUSIC_SLEEP_PRESETS, parseSleepMinutes } from './music-sleep-timer.component';

describe('parseSleepMinutes', () => {
  it('parses and rounds', () => {
    expect(parseSleepMinutes('20')).toBe(20);
    expect(parseSleepMinutes(7.4)).toBe(7);
  });
  it('clamps to 1..720', () => {
    expect(parseSleepMinutes('0.2')).toBe(1);
    expect(parseSleepMinutes('5000')).toBe(720);
  });
  it('rejects junk and non-positive', () => {
    expect(parseSleepMinutes('')).toBeNull();
    expect(parseSleepMinutes('abc')).toBeNull();
    expect(parseSleepMinutes(-5)).toBeNull();
  });
  it('has the documented presets', () => {
    expect([...MUSIC_SLEEP_PRESETS]).toEqual([5, 10, 15, 30, 45, 60, 90, 120]);
  });
});
