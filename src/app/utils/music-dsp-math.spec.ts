import {
  CROSSFEED_PRESETS, crossfeedParams, defaultDspState, dspAnyEnabled, matchCrossfeedPreset, monoSample, sanitizeDspState, widenerGains, widenSample,
} from './music-dsp-math';

describe('music-dsp-math', () => {
  it('widener: width 1 is identity, 0 is mono, 2 doubles the side', () => {
    const [l1, r1] = widenSample(1, 0.2, 1);
    expect(l1).toBeCloseTo(1);
    expect(r1).toBeCloseTo(0.2);
    const [l0, r0] = widenSample(1, 0.2, 0);
    expect(l0).toBeCloseTo(0.6);
    expect(r0).toBeCloseTo(0.6);
    const [l2, r2] = widenSample(1, 0.2, 2);
    expect(l2).toBeCloseTo(1.4);
    expect(r2).toBeCloseTo(-0.2);
    expect(widenerGains(5).side).toBe(2);
  });

  it('mono downmix averages the channels', () => {
    expect(monoSample(1, -1)).toEqual([0, 0]);
    expect(monoSample(0.5, 0.1)).toEqual([0.3, 0.3]);
  });

  it('crossfeed params: weaker level means a smaller cross gain', () => {
    const a = crossfeedParams(-3, 700);
    const b = crossfeedParams(-9, 700);
    expect(a.cross).toBeGreaterThan(b.cross);
    expect(a.direct).toBeLessThan(1);
    expect(a.cutoff).toBe(700);
    expect(crossfeedParams(0, 99999).cross).toBeCloseTo(Math.pow(10, -1.5 / 20));
    expect(matchCrossfeedPreset(CROSSFEED_PRESETS.high.level, CROSSFEED_PRESETS.high.cutoff)).toBe('high');
    expect(matchCrossfeedPreset(-5, 600)).toBe('');
  });

  it('sanitizes stored state and reports whether any effect is on', () => {
    expect(sanitizeDspState('x')).toEqual(defaultDspState());
    const s = sanitizeDspState({ mono: true, crossfeed: { enabled: true, level: -99, cutoff: 5 }, widener: { enabled: true, width: 9 } });
    expect(s.crossfeed.level).toBe(-12);
    expect(s.crossfeed.cutoff).toBe(300);
    expect(s.widener.width).toBe(2);
    expect(dspAnyEnabled(s)).toBeTrue();
    expect(dspAnyEnabled(defaultDspState())).toBeFalse();
  });
});
