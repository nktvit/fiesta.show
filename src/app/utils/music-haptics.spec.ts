import { hapticTap } from './music-haptics';

describe('hapticTap', () => {
  const original = Object.getOwnPropertyDescriptor(Navigator.prototype, 'vibrate');
  afterEach(() => {
    if (original) Object.defineProperty(Navigator.prototype, 'vibrate', original);
    else delete (Navigator.prototype as unknown as Record<string, unknown>)['vibrate'];
  });

  it('vibrates 10 ms when enabled and supported', () => {
    const spy = jasmine.createSpy('vibrate').and.returnValue(true);
    Object.defineProperty(Navigator.prototype, 'vibrate', { value: spy, configurable: true, writable: true });
    expect(hapticTap(true)).toBeTrue();
    expect(spy).toHaveBeenCalledWith(10);
  });

  it('does nothing when disabled', () => {
    const spy = jasmine.createSpy('vibrate').and.returnValue(true);
    Object.defineProperty(Navigator.prototype, 'vibrate', { value: spy, configurable: true, writable: true });
    expect(hapticTap(false)).toBeFalse();
    expect(spy).not.toHaveBeenCalled();
  });

  it('does nothing when unsupported', () => {
    Object.defineProperty(Navigator.prototype, 'vibrate', { value: undefined, configurable: true, writable: true });
    expect(hapticTap(true)).toBeFalse();
  });

  it('swallows errors', () => {
    Object.defineProperty(Navigator.prototype, 'vibrate', { value: () => { throw new Error('x'); }, configurable: true, writable: true });
    expect(hapticTap(true)).toBeFalse();
  });
});
