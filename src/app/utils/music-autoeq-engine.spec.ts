import { clippingSafePreamp, sumResponseDb } from './music-dsp-biquad';
import { correctedCurve, FrPoint, interpolateFr, normalizationOffset, runAutoEq } from './music-autoeq-engine';

/** A flat 0 dB target and a "headphone" with a +6 dB bump at 3 kHz and a -4 dB dip at 100 Hz (fixture). */
function logGrid(): number[] {
  const out: number[] = [];
  for (let f = 20; f <= 20000; f *= Math.pow(2, 1 / 24)) out.push(f);
  return out;
}
const bump = (f: number, centre: number, db: number, octaves: number) => db * Math.exp(-Math.pow(Math.log2(f / centre) / octaves, 2));

describe('music-autoeq-engine', () => {
  const grid = logGrid();
  const target: FrPoint[] = [{ freq: 20, gain: 75 }, { freq: 20000, gain: 75 }];
  const measurement: FrPoint[] = grid.map((f) => ({ freq: f, gain: 75 + bump(f, 3000, 6, 0.6) + bump(f, 100, -4, 0.7) }));

  it('interpolates and normalises over 250 Hz - 2.5 kHz', () => {
    expect(interpolateFr(150, [{ freq: 100, gain: 0 }, { freq: 200, gain: 10 }])).toBe(5);
    expect(interpolateFr(5, [{ freq: 100, gain: 3 }])).toBe(3);
    const off = normalizationOffset(measurement, target);
    expect(Math.abs(off)).toBeLessThan(3);
    expect(normalizationOffset([{ freq: 1000, gain: 70 }])).toBe(70);
  });

  it('computes a parametric correction that flattens the fixture curve', () => {
    const bands = runAutoEq(measurement, target, { bandCount: 6 });
    expect(bands.length).toBeGreaterThan(0);
    expect(bands.length).toBeLessThanOrEqual(6);
    expect(bands.every((b) => b.type === 'peaking' && b.q >= 0.6 && b.q <= 5)).toBeTrue();
    // Sorted by frequency, with a cut near the 3 kHz bump and a boost near the 100 Hz dip.
    for (let i = 1; i < bands.length; i++) expect(bands[i].freq).toBeGreaterThanOrEqual(bands[i - 1].freq);
    const nearBump = bands.filter((b) => b.freq > 1800 && b.freq < 5500);
    expect(nearBump.some((b) => b.gain < -2)).toBeTrue();
    const nearDip = bands.filter((b) => b.freq > 50 && b.freq < 220);
    expect(nearDip.some((b) => b.gain > 1)).toBeTrue();
    // The corrected curve deviates less from the target than the raw one.
    const rms = (c: FrPoint[]) => Math.sqrt(c.reduce((s, p) => s + Math.pow(p.gain - 75, 2), 0) / c.length);
    const before = rms(correctedCurve(measurement, target, [], 0));
    const after = rms(correctedCurve(measurement, target, bands, 0));
    expect(after).toBeLessThan(before * 0.6);
    // Preamp keeps the sum from clipping.
    expect(clippingSafePreamp(bands)).toBeLessThanOrEqual(0);
    expect(sumResponseDb(bands, 3000)).toBeLessThan(0);
  });

  it('returns nothing for inverted ranges, empty data or an already-flat response', () => {
    expect(runAutoEq(measurement, target, { bandCount: 5, minFreq: 5000, maxFreq: 100 })).toEqual([]);
    expect(runAutoEq([], target, { bandCount: 5 })).toEqual([]);
    const flat = grid.map((f) => ({ freq: f, gain: 75 }));
    expect(runAutoEq(flat, target, { bandCount: 5 })).toEqual([]);
  });
});
