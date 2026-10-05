import { formatBytes, groupStorage } from './music-settings-system.component';

describe('music settings system helpers', () => {
  it('groups fiesta:music keys by area and ignores other keys', () => {
    const rows = groupStorage([
      ['fiesta:music:settings', '{"a":1}'],
      ['fiesta:music:secret:lastfm', 'xx'],
      ['fiesta:music:secret:other', 'yy'],
      ['other:key', 'zzzz'],
    ]);
    expect(rows.map((r) => r.area).sort()).toEqual(['secret', 'settings']);
    const secret = rows.find((r) => r.area === 'secret');
    expect(secret?.keys).toBe(2);
    expect(secret?.bytes).toBe(('fiesta:music:secret:lastfm'.length + 2 + 'fiesta:music:secret:other'.length + 2) * 2);
  });

  it('formats bytes', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  });
});
