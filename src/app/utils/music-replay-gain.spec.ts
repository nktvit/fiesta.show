import { effectiveVolume, getReplayGainScale } from './music-replay-gain';

describe('music-replay-gain', () => {
  const rg = { trackReplayGain: -6, trackPeakAmplitude: 0.5, albumReplayGain: -9, albumPeakAmplitude: 0.6 };

  it('is 1 when off or without values', () => {
    expect(getReplayGainScale(rg, { mode: 'off' })).toBe(1);
    expect(getReplayGainScale(null, { mode: 'track' })).toBe(1);
  });

  it('uses the track gain in track mode', () => {
    expect(getReplayGainScale(rg, { mode: 'track' })).toBeCloseTo(Math.pow(10, -6 / 20), 6);
  });

  it('uses the album gain in album mode, falling back to track gain', () => {
    expect(getReplayGainScale(rg, { mode: 'album' })).toBeCloseTo(Math.pow(10, -9 / 20), 6);
    expect(getReplayGainScale({ trackReplayGain: -3 }, { mode: 'album' })).toBeCloseTo(Math.pow(10, -3 / 20), 6);
  });

  it('adds the preamp and clips to the peak', () => {
    // +12 dB on -6 dB = +6 dB = 1.995x; peak 0.5 allows at most 2x -> not clipped.
    expect(getReplayGainScale(rg, { mode: 'track', preampDb: 12 })).toBeCloseTo(Math.pow(10, 6 / 20), 6);
    // +15 dB -> 2.82x * 0.5 > 1 -> capped at 1/peak = 2.
    expect(getReplayGainScale(rg, { mode: 'track', preampDb: 15 })).toBeCloseTo(2, 6);
  });

  it('parses numeric strings and ignores junk', () => {
    expect(getReplayGainScale({ trackReplayGain: '-6' }, { mode: 'track' })).toBeCloseTo(Math.pow(10, -6 / 20), 6);
    expect(getReplayGainScale({ trackReplayGain: 'x' }, { mode: 'track' })).toBe(1);
  });

  it('uses programme loudness when no gain is given', () => {
    expect(getReplayGainScale({ programLoudnessLufs: -14 }, { mode: 'track' })).toBeCloseTo(Math.pow(10, -4 / 20), 6);
  });

  it('effectiveVolume applies mute, the cubic curve and the multipliers', () => {
    expect(effectiveVolume({ volume: 0.3, muted: false, exponential: false })).toBeCloseTo(0.3, 6);
    expect(effectiveVolume({ volume: 0.3, muted: false, exponential: true })).toBeCloseTo(0.027, 6);
    expect(effectiveVolume({ volume: 0.8, muted: true, exponential: false })).toBe(0);
    expect(effectiveVolume({ volume: 1, muted: false, exponential: false, replayGain: 2, fade: 1, deck: 1 })).toBe(1);
    expect(effectiveVolume({ volume: 1, muted: false, exponential: false, replayGain: 0.5, fade: 0.5, deck: 0.5 })).toBeCloseTo(0.125, 6);
  });
});
