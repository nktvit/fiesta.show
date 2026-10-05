import { musicStorage, MUSIC_STORAGE_PREFIX } from './music-storage';

describe('musicStorage', () => {
  const clean = () => {
    for (const k of musicStorage.keys()) musicStorage.remove(k);
  };
  beforeEach(clean);
  afterEach(clean);

  it('round-trips JSON under the fiesta:music: prefix', () => {
    expect(musicStorage.write('t-one', { a: 1, b: [2] })).toBeTrue();
    expect(localStorage.getItem(MUSIC_STORAGE_PREFIX + 't-one')).toBe('{"a":1,"b":[2]}');
    expect(musicStorage.read<unknown>('t-one', null)).toEqual({ a: 1, b: [2] });
  });

  it('falls back on missing or corrupt values', () => {
    expect(musicStorage.read('t-missing', 42)).toBe(42);
    localStorage.setItem(MUSIC_STORAGE_PREFIX + 't-bad', '{not json');
    expect(musicStorage.read('t-bad', 'x')).toBe('x');
  });

  it('lists only music keys, relative, and flags secrets', () => {
    localStorage.setItem('other:key', '1');
    musicStorage.write('t-a', 1);
    musicStorage.write('secret:t-b', 'tok');
    const keys = musicStorage.keys();
    expect(keys).toContain('t-a');
    expect(keys).toContain('secret:t-b');
    expect(keys).not.toContain('other:key');
    expect(musicStorage.isSecret('secret:t-b')).toBeTrue();
    expect(musicStorage.isSecret('t-a')).toBeFalse();
    localStorage.removeItem('other:key');
  });

  it('does not throw when storage refuses writes', () => {
    const spy = spyOn(Storage.prototype, 'setItem').and.throwError('QuotaExceededError');
    expect(musicStorage.write('t-full', 1)).toBeFalse();
    spy.and.callThrough();
  });

  it('removes keys', () => {
    musicStorage.write('t-gone', 1);
    musicStorage.remove('t-gone');
    expect(musicStorage.read('t-gone', null)).toBeNull();
  });
});
