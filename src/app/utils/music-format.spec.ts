import { longDuration, proxiedImage, relativeDate, tidalImage, time } from './music-format';

describe('music-format', () => {
  it('time', () => {
    expect(time(0)).toBe('0:00');
    expect(time(7.9)).toBe('0:07');
    expect(time(187)).toBe('3:07');
    expect(time(3725)).toBe('1:02:05');
    expect(time(-4)).toBe('0:00');
    expect(time(NaN)).toBe('0:00');
  });

  it('longDuration', () => {
    expect(longDuration(42 * 60)).toBe('42 min');
    expect(longDuration(65 * 60)).toBe('1 hr 5 min');
    expect(longDuration(120 * 60)).toBe('2 hr');
  });

  it('tidalImage rewrites the size segment of TIDAL URLs only', () => {
    const u = 'https://resources.tidal.com/images/7d3b9810/5634/400c/ad89/50609e0ce800/320x320.jpg';
    expect(tidalImage(u, 640)).toBe('https://resources.tidal.com/images/7d3b9810/5634/400c/ad89/50609e0ce800/640x640.jpg');
    expect(tidalImage('https://example.com/a/320x320.jpg', 640)).toBe('https://example.com/a/320x320.jpg');
    expect(tidalImage('', 640)).toBe('');
  });

  it('proxiedImage encodes TIDAL URLs as base64url', () => {
    const u = 'https://resources.tidal.com/images/a/b/320x320.jpg';
    const p = proxiedImage(u);
    expect(p.startsWith('/api/music?action=img&u=')).toBeTrue();
    const enc = p.split('u=')[1];
    expect(enc).not.toMatch(/[+/=]/);
    expect(atob(enc.replace(/-/g, '+').replace(/_/g, '/'))).toBe(u);
    expect(proxiedImage('data:image/png;base64,xx')).toBe('data:image/png;base64,xx');
  });

  it('relativeDate', () => {
    const now = new Date(2026, 5, 15, 12, 0, 0).getTime();
    expect(relativeDate(now - 10_000, now)).toBe('just now');
    expect(relativeDate(now - 5 * 60_000, now)).toBe('5 min ago');
    expect(relativeDate(now - 60 * 60_000, now)).toBe('1 hour ago');
    expect(relativeDate(now - 3 * 3600_000, now)).toBe('3 hours ago');
    expect(relativeDate(now - 30 * 3600_000, now)).toBe('yesterday');
    expect(relativeDate(now - 4 * 86400_000, now)).toBe('4 days ago');
    expect(relativeDate(now - 40 * 86400_000, now).length).toBeGreaterThan(3);
  });
});
