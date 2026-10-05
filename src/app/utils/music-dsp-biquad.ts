// Ported from Monochrome (Apache-2.0), js/autoeq-engine.js (calculateBiquadResponse) - adapted for Fiesta.

/** The filter shapes the EQ supports (the names Web Audio's BiquadFilterNode uses). */
export type DspFilterType = 'peaking' | 'lowshelf' | 'highshelf';

/** What the response maths needs to know about one filter. */
export interface DspBiquadBand {
  type: DspFilterType;
  freq: number;
  gain: number;
  q: number;
  enabled?: boolean;
}

export const DSP_DEFAULT_SAMPLE_RATE = 48000;

/**
 * Magnitude response (dB) of one RBJ biquad at `f` Hz.
 *
 * Web Audio ignores Q on the two shelf types (it always uses a shelf slope of 1,
 * which equals Q = 1/sqrt(2)), so the maths does the same: what the graph draws
 * is what the BiquadFilterNode does.
 */
export function biquadResponseDb(f: number, band: DspBiquadBand, sampleRate = DSP_DEFAULT_SAMPLE_RATE): number {
  if (band.enabled === false) return 0;
  if (!(band.freq > 0) || !(f > 0)) return 0;
  const w = (2 * Math.PI * band.freq) / sampleRate;
  const p = (2 * Math.PI * f) / sampleRate;
  const q = band.type === 'peaking' ? Math.max(0.01, band.q) : Math.SQRT1_2;
  const s = Math.sin(w) / (2 * q);
  const A = Math.pow(10, band.gain / 40);
  const c = Math.cos(w);
  let b0: number, b1: number, b2: number, a0: number, a1: number, a2: number;
  if (band.type === 'peaking') {
    b0 = 1 + s * A;
    b1 = -2 * c;
    b2 = 1 - s * A;
    a0 = 1 + s / A;
    a1 = -2 * c;
    a2 = 1 - s / A;
  } else if (band.type === 'lowshelf') {
    const sq = 2 * Math.sqrt(A) * s;
    b0 = A * (A + 1 - (A - 1) * c + sq);
    b1 = 2 * A * (A - 1 - (A + 1) * c);
    b2 = A * (A + 1 - (A - 1) * c - sq);
    a0 = A + 1 + (A - 1) * c + sq;
    a1 = -2 * (A - 1 + (A + 1) * c);
    a2 = A + 1 + (A - 1) * c - sq;
  } else {
    const sq = 2 * Math.sqrt(A) * s;
    b0 = A * (A + 1 + (A - 1) * c + sq);
    b1 = -2 * A * (A - 1 + (A + 1) * c);
    b2 = A * (A + 1 + (A - 1) * c - sq);
    a0 = A + 1 - (A - 1) * c + sq;
    a1 = 2 * (A - 1 - (A + 1) * c);
    a2 = A + 1 - (A - 1) * c - sq;
  }
  const inv = 1 / a0;
  const b0n = b0 * inv, b1n = b1 * inv, b2n = b2 * inv, a1n = a1 * inv, a2n = a2 * inv;
  const cp = Math.cos(p);
  const c2p = Math.cos(2 * p);
  const num = b0n * b0n + b1n * b1n + b2n * b2n + 2 * (b0n * b1n + b1n * b2n) * cp + 2 * b0n * b2n * c2p;
  const den = 1 + a1n * a1n + a2n * a2n + 2 * (a1n + a1n * a2n) * cp + 2 * a2n * c2p;
  const ratio = num / den;
  return ratio > 0 ? 10 * Math.log10(ratio) : -120;
}

/** Summed response (dB) of every enabled band at `f` Hz. */
export function sumResponseDb(bands: readonly DspBiquadBand[], f: number, sampleRate = DSP_DEFAULT_SAMPLE_RATE): number {
  let sum = 0;
  for (const b of bands) sum += biquadResponseDb(f, b, sampleRate);
  return sum;
}

/** Log-spaced frequencies from `min` to `max` (inclusive), `points` of them. */
export function logSpace(min: number, max: number, points: number): number[] {
  const out: number[] = [];
  const n = Math.max(2, points);
  for (let i = 0; i < n; i++) out.push(min * Math.pow(max / min, i / (n - 1)));
  return out;
}

/**
 * Preamp (<= 0 dB) that keeps the summed response from clipping: minus the
 * highest boost the bands add anywhere in 20 Hz - 20 kHz (24 points per octave).
 */
export function clippingSafePreamp(bands: readonly DspBiquadBand[], sampleRate = DSP_DEFAULT_SAMPLE_RATE): number {
  let peak = 0;
  for (let f = 20; f <= 20000; f *= Math.pow(2, 1 / 24)) {
    const v = sumResponseDb(bands, f, sampleRate);
    if (v > peak) peak = v;
  }
  return peak > 0 ? -Math.round(peak * 10) / 10 : 0;
}
