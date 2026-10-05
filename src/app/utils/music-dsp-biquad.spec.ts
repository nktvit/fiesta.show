import { biquadResponseDb, clippingSafePreamp, logSpace, sumResponseDb } from './music-dsp-biquad';

describe('music-dsp-biquad', () => {
  it('a peaking band reaches its gain at the centre frequency', () => {
    const g = biquadResponseDb(1000, { type: 'peaking', freq: 1000, gain: 6, q: 1 });
    expect(g).toBeCloseTo(6, 1);
  });

  it('is flat far from a peaking band and for disabled or zero-gain bands', () => {
    expect(Math.abs(biquadResponseDb(30, { type: 'peaking', freq: 5000, gain: 6, q: 4 }))).toBeLessThan(0.1);
    expect(biquadResponseDb(1000, { type: 'peaking', freq: 1000, gain: 6, q: 1, enabled: false })).toBe(0);
    expect(biquadResponseDb(1000, { type: 'peaking', freq: 1000, gain: 0, q: 1 })).toBeCloseTo(0, 5);
  });

  it('shelves reach their gain on their own side only, and ignore Q like Web Audio', () => {
    const low = { type: 'lowshelf' as const, freq: 200, gain: 6, q: 0.3 };
    expect(biquadResponseDb(20, low)).toBeCloseTo(6, 0);
    expect(Math.abs(biquadResponseDb(10000, low))).toBeLessThan(0.2);
    expect(biquadResponseDb(500, low)).toBeCloseTo(biquadResponseDb(500, { ...low, q: 5 }), 6);
    const high = { type: 'highshelf' as const, freq: 5000, gain: -4, q: 1 };
    expect(biquadResponseDb(20000, high)).toBeCloseTo(-4, 0);
  });

  it('sums bands and picks a clipping-safe preamp', () => {
    const bands = [
      { type: 'peaking' as const, freq: 100, gain: 5, q: 1 },
      { type: 'peaking' as const, freq: 100, gain: 3, q: 1 },
    ];
    expect(sumResponseDb(bands, 100)).toBeCloseTo(8, 1);
    expect(clippingSafePreamp(bands)).toBeLessThanOrEqual(-7);
    expect(clippingSafePreamp([{ type: 'peaking', freq: 100, gain: -5, q: 1 }])).toBe(0);
  });

  it('logSpace spans the range', () => {
    const f = logSpace(20, 20000, 5);
    expect(f.length).toBe(5);
    expect(f[0]).toBeCloseTo(20);
    expect(f[4]).toBeCloseTo(20000);
  });
});
