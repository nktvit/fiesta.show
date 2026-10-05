import { computePeaks, getSilenceBoundaries, lruEvictions, peaksToPath } from './music-waveform-peaks';

describe('music-waveform-peaks', () => {
  it('computePeaks takes max-abs per bucket and normalises', () => {
    const ch = new Float32Array(100);
    ch[5] = -0.5;
    ch[55] = 0.25;
    const p = computePeaks([ch], 10);
    expect(p.length).toBe(10);
    expect(p[0]).toBeCloseTo(1, 6);
    expect(p[5]).toBeCloseTo(0.5, 6);
    expect(p[3]).toBe(0);
  });

  it('computePeaks handles silence and empty input', () => {
    expect(Array.from(computePeaks([new Float32Array(50)], 4))).toEqual([0, 0, 0, 0]);
    expect(Array.from(computePeaks([], 3))).toEqual([0, 0, 0]);
  });

  describe('getSilenceBoundaries (synthetic peaks)', () => {
    // 100 samples over 200 s: first 10 silent, last 5 silent.
    const peaks = Array.from({ length: 100 }, (_, i) => (i < 10 || i >= 95 ? 0 : 0.8));

    it('finds leading and trailing silence', () => {
      const b = getSilenceBoundaries(peaks, 200);
      expect(b.leadingSilenceSeconds).toBeCloseTo(20, 6);
      expect(b.trailingSilenceStartTime).toBeCloseTo(190, 6);
      expect(b.hasTrailingSilence).toBe(true);
      expect(b.crossfadeStartTime).toBeCloseTo(187, 6);
      expect(b.crossfadeDurationSeconds).toBe(3);
    });

    it('reports no silence for a loud track', () => {
      const b = getSilenceBoundaries(Array(50).fill(0.5), 100);
      expect(b.leadingSilenceSeconds).toBe(0);
      expect(b.trailingSilenceStartTime).toBe(100);
      expect(b.hasTrailingSilence).toBe(false);
    });

    it('never trims a track that stays under the threshold, or bad input', () => {
      expect(getSilenceBoundaries(Array(20).fill(0), 60).trailingSilenceStartTime).toBe(60);
      expect(getSilenceBoundaries([], 60).leadingSilenceSeconds).toBe(0);
      expect(getSilenceBoundaries(peaks, 0).crossfadeDurationSeconds).toBe(0);
      expect(getSilenceBoundaries(null, 10).trailingSilenceStartTime).toBe(10);
    });

    it('clamps the crossfade to the audible length', () => {
      const b = getSilenceBoundaries([0, 1, 0], 6, 0.1, 10);
      expect(b.crossfadeDurationSeconds).toBeCloseTo(2, 6);
    });
  });

  it('lruEvictions drops the oldest beyond the cap', () => {
    const e = [1, 2, 3, 4].map((k) => ({ key: k, at: k === 3 ? 1 : 10 + k }));
    expect(lruEvictions(e, 3)).toEqual([3]);
    expect(lruEvictions(e, 4)).toEqual([]);
    expect(lruEvictions(e, 2).sort()).toEqual([1, 3]);
  });

  it('peaksToPath draws one rect per bar, empty without peaks', () => {
    expect(peaksToPath(null)).toBe('');
    const d = peaksToPath(new Float32Array(100).fill(0.5), 1000, 100, 10);
    expect((d.match(/M/g) || []).length).toBe(10);
  });
});
