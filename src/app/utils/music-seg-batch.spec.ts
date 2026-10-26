import { affordableCount, batchCount, batchUrl, SEG_MAX_BATCH } from './music-seg-batch';

describe('music-seg-batch', () => {
  it('ramps 1 -> 4 -> 8 and never runs past the last segment', () => {
    expect(batchCount(0, 1, 70)).toBe(1);
    expect(batchCount(1, 2, 70)).toBe(4);
    expect(batchCount(2, 6, 70)).toBe(8);
    expect(batchCount(9, 14, 70)).toBe(8);
    expect(batchCount(5, 68, 70)).toBe(3);
    expect(batchCount(5, 70, 70)).toBe(1);
  });

  it('honours a cap (standby deck)', () => {
    expect(batchCount(2, 6, 70, 2)).toBe(2);
  });

  it('keeps the plain URL for a single segment', () => {
    expect(batchUrl('/m?u=x', 3, 1)).toBe('/m?u=x&n=3');
    expect(batchUrl('/m?u=x', 3, 4)).toBe('/m?u=x&n=3&c=4');
  });

  it('a 70-segment track takes <= 12 requests including init', () => {
    let n = 1;
    let step = 0;
    let requests = 1; // init
    const covered: number[] = [];
    while (n <= 70) {
      const c = batchCount(step++, n, 70);
      for (let k = 0; k < c; k++) covered.push(n + k);
      n += c;
      requests++;
    }
    expect(requests).toBeLessThanOrEqual(12);
    expect(covered).toEqual(Array.from({ length: 70 }, (_, i) => i + 1));
  });
});

describe('affordableCount', () => {
  it('is the full batch until a speed is known', () => {
    expect(affordableCount(4, 0, 0)).toBe(SEG_MAX_BATCH);
  });
  it('shrinks to what the buffer can cover at the measured speed', () => {
    // 450 KB segments at 240 KB/s = 1.9 s each; 4 s buffered, 1 s margin -> 1 segment
    expect(affordableCount(4, 240_000, 450_000)).toBe(1);
    // 12 s buffered -> (12 - 1) / 1.9 = 5
    expect(affordableCount(12, 240_000, 450_000)).toBe(5);
  });
  it('never asks for less than one segment', () => {
    expect(affordableCount(0, 100_000, 450_000)).toBe(1);
  });
  it('allows big batches on a fast link', () => {
    expect(affordableCount(4, 6_000_000, 450_000)).toBeGreaterThanOrEqual(SEG_MAX_BATCH);
  });
});
