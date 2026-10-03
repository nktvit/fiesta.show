import { estimateOffset, fitLine, fragmentDecodeTime, initTimescale, speechMask } from './subsync';

// Speech on [start, end) seconds, sampled at 10 ms from t0, length n bins.
function maskFrom(spans: [number, number][], t0: number, n: number): Float32Array {
  const m = new Float32Array(n);
  for (const [a, b] of spans) {
    for (let i = Math.round((a - t0) * 100); i < Math.round((b - t0) * 100); i++) if (i >= 0 && i < n) m[i] = 1;
  }
  return m;
}

// Irregular dialogue: a cue every 3-6 s lasting 1-3 s (deterministic).
function dialogue(from: number, to: number): { start: number; end: number }[] {
  const cues = [];
  let t = from;
  let k = 7;
  while (t < to) {
    k = (k * 1103515245 + 12345) % 2147483648;
    const len = 1 + (k % 2000) / 1000;
    cues.push({ start: t, end: t + len });
    t += len + 1 + ((k >> 8) % 3000) / 1000;
  }
  return cues;
}

describe('subsync', () => {
  const t0 = 1000;
  const cues = dialogue(900, 1300);

  it('finds a subtitle that is 2.5 s late (offset -2.5)', () => {
    // speech happens 2.5 s BEFORE the cue times
    const speech = cues.map((c) => [c.start - 2.5, c.end - 2.5] as [number, number]);
    const e = estimateOffset(maskFrom(speech, t0, 12000), t0, cues, 0, 20)!;
    expect(e.offset).toBeCloseTo(-2.5, 1);
    expect(e.ratio).toBeLessThan(0.8);
  });

  it('finds a large early offset with a wide search', () => {
    const speech = cues.map((c) => [c.start + 41.3, c.end + 41.3] as [number, number]);
    const shifted = cues.map((c) => c); // same file times
    const e = estimateOffset(maskFrom(speech, t0, 12000), t0, shifted, 0, 90)!;
    expect(e.offset).toBeCloseTo(41.3, 1);
  });

  it('ignores unknown (NaN) bins instead of treating them as silence', () => {
    const speech = cues.map((c) => [c.start + 1, c.end + 1] as [number, number]);
    const m = maskFrom(speech, t0, 12000);
    for (let i = 4000; i < 7000; i++) m[i] = NaN;
    const e = estimateOffset(m, t0, cues, 0, 20)!;
    expect(e.offset).toBeCloseTo(1, 1);
  });

  it('is unsure when the audio has no relation to the cues', () => {
    const noise = maskFrom(dialogue(950, 1250).map((c) => [c.start * 1.37 - 400, c.end * 1.37 - 400] as [number, number]), t0, 12000);
    const e = estimateOffset(noise, t0, cues, 0, 20);
    expect(e === null || e.ratio > 0.6).toBeTrue();
  });

  it('recovers offset and slope of a drifting file (1.85% fast)', () => {
    // audio = 1.0185 * file - 3.6 (Breaking Bad S1E1, file 1951736854)
    const a = 1.0185;
    const b = -3.6;
    const speech = cues.map((c) => [a * c.start + b, a * c.end + b] as [number, number]);
    const slopes = Array.from({ length: 41 }, (_, i) => (i - 20) * 0.0025);
    const tref = 1060;
    const e = estimateOffset(maskFrom(speech, t0, 12000), t0, cues, 0, 90, slopes, tref)!;
    // shift at tref: tref - x where a*x + b = tref
    expect(e.offset).toBeCloseTo(tref - (tref - b) / a, 0);
    expect(Math.abs(e.slope - 0.0185)).toBeLessThan(0.0026);
    expect(e.ratio).toBeLessThan(0.8);
  });

  it('fitLine needs 3 points over a minimum span', () => {
    expect(fitLine([{ x: 0, t: 1 }, { x: 500, t: 511 }], 120)).toBeNull();
    expect(fitLine([{ x: 0, t: 1 }, { x: 10, t: 11 }, { x: 20, t: 21 }], 120)).toBeNull();
    const f = fitLine([{ x: 0, t: 13 }, { x: 1000, t: 1055 }, { x: 2000, t: 2097 }], 120)!;
    expect(f.a).toBeCloseTo(1.042, 3);
    expect(f.b).toBeCloseTo(13, 1);
  });

  it('returns null with nothing to compare', () => {
    expect(estimateOffset(new Float32Array(100).fill(NaN), t0, cues, 0, 5)).toBeNull();
    expect(estimateOffset(new Float32Array(100), t0, [], 0, 5)).toBeNull();
  });

  it('speechMask marks syllable bursts above the local baseline and keeps NaN', () => {
    const e = new Float32Array(1000).fill(-3);
    // 2 s of speech: 150 ms syllables, 100 ms dips (a constant tone is not speech)
    for (let i = 400; i < 600; i++) e[i] = (i - 400) % 25 < 15 ? -1 : -2.6;
    e[10] = NaN;
    const m = speechMask(e);
    expect(m[500]).toBe(1);
    expect(m[100]).toBe(0);
    expect(Number.isNaN(m[10])).toBeTrue();
  });

  it('reads mdhd timescale and tfdt from fMP4 boxes', () => {
    const box = (type: string, body: number[]) => {
      const size = 8 + body.length;
      return [size >>> 24, (size >> 16) & 255, (size >> 8) & 255, size & 255, ...[...type].map((c) => c.charCodeAt(0)), ...body];
    };
    const u32 = (v: number) => [v >>> 24, (v >> 16) & 255, (v >> 8) & 255, v & 255];
    const mdhd = box('mdhd', [0, 0, 0, 0, ...u32(0), ...u32(0), ...u32(44100), ...u32(0), 0, 0, 0, 0]);
    const init = new Uint8Array(box('moov', box('trak', box('mdia', mdhd))));
    expect(initTimescale(init)).toBe(44100);
    const tfdt = box('tfdt', [0, 0, 0, 0, ...u32(441000)]);
    const seg = new Uint8Array([...box('moof', box('traf', tfdt)), ...box('mdat', [1, 2])]);
    expect(fragmentDecodeTime(seg)).toBe(441000);
  });
});
