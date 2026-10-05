// Ported from Monochrome (Apache-2.0), js/autoeq-engine.js - adapted for Fiesta.
// Iterative peak-flattening parametric EQ optimisation (from the Seap engine).
import { biquadResponseDb, DSP_DEFAULT_SAMPLE_RATE } from './music-dsp-biquad';
import type { EqBand } from './music-eq-core';

export interface FrPoint {
  freq: number;
  gain: number;
}

const MAX_BOOST = 30;
const MAX_CUT = 30;
const MIN_Q = 0.6;

/** Linear interpolation of a frequency response at `freq` (flat beyond the ends). */
export function interpolateFr(freq: number, data: readonly FrPoint[]): number {
  if (data.length === 0) return 0;
  if (freq <= data[0].freq) return data[0].gain;
  if (freq >= data[data.length - 1].freq) return data[data.length - 1].gain;
  for (let i = 0; i < data.length - 1; i++) {
    if (freq >= data[i].freq && freq <= data[i + 1].freq) {
      const span = data[i + 1].freq - data[i].freq;
      if (span === 0) return data[i].gain;
      return data[i].gain + ((freq - data[i].freq) / span) * (data[i + 1].gain - data[i].gain);
    }
  }
  return 0;
}

/**
 * Level offset that aligns the 250 Hz - 2.5 kHz average of `measurement` with `target`.
 * With one argument it returns the midrange average of that curve (for graph centring).
 */
export function normalizationOffset(measurement: readonly FrPoint[], target?: readonly FrPoint[]): number {
  if (!target) {
    let sum = 0;
    let count = 0;
    for (const p of measurement) {
      if (p.freq >= 250 && p.freq <= 2500) {
        sum += p.gain;
        count++;
      }
    }
    return count > 0 ? sum / count : interpolateFr(1000, measurement);
  }
  let sumT = 0;
  let sumM = 0;
  let count = 0;
  for (const p of measurement) {
    if (p.freq >= 250 && p.freq <= 2500) {
      sumT += interpolateFr(p.freq, target);
      sumM += p.gain;
      count++;
    }
  }
  if (count > 0) return sumT / count - sumM / count;
  return interpolateFr(1000, target) - interpolateFr(1000, measurement);
}

export interface AutoEqOptions {
  bandCount: number;
  maxFreq?: number;
  minFreq?: number;
  maxQ?: number;
  sampleRate?: number;
}

/**
 * Generates up to `bandCount` peaking bands that move `measurement` toward `target`:
 * find the largest weighted error, place a corrective filter, repeat.
 */
export function runAutoEq(measurement: readonly FrPoint[], target: readonly FrPoint[], opts: AutoEqOptions): EqBand[] {
  const maxFreq = opts.maxFreq ?? 16000;
  const minFreq = opts.minFreq ?? 20;
  const maxQ = opts.maxQ ?? 5;
  const sr = opts.sampleRate ?? DSP_DEFAULT_SAMPLE_RATE;
  if (minFreq > maxFreq || measurement.length === 0 || target.length === 0) return [];

  const off = normalizationOffset(measurement, target);
  let err: FrPoint[] = measurement.map((p) => ({ freq: p.freq, gain: p.gain + off - interpolateFr(p.freq, target) }));
  if (!err.some((p) => p.freq >= minFreq && p.freq <= maxFreq)) return [];

  const out: EqBand[] = [];
  for (let i = 0; i < opts.bandCount; i++) {
    let maxDev = 0;
    let maxWeighted = 0;
    let peakFreq = 1000;
    let peakIdx = 0;
    for (let j = 0; j < err.length; j++) {
      const p = err[j];
      if (p.freq < minFreq || p.freq > maxFreq) continue;
      let v = p.gain;
      if (j > 0 && j < err.length - 1) v = (err[j - 1].gain + v + err[j + 1].gain) / 3;
      const w = p.freq < 300 ? 1.5 : p.freq < 4000 ? 1 : p.freq < 8000 ? 0.5 : 0.25;
      if (Math.abs(v * w) > Math.abs(maxWeighted)) {
        maxWeighted = Math.abs(v * w);
        maxDev = v;
        peakFreq = p.freq;
        peakIdx = j;
      }
    }

    let gain = -maxDev;
    let safeBoost = MAX_BOOST;
    if (peakFreq > 3000) safeBoost = 6;
    if (peakFreq > 6000) safeBoost = 3;
    if (gain > safeBoost) gain = safeBoost;
    if (gain < -MAX_CUT) gain = -MAX_CUT;
    if (Math.abs(gain) < 0.2) break;

    // Bandwidth from the half-gain points of the error peak.
    let lower = peakFreq;
    let upper = peakFreq;
    let foundLower = false;
    let foundUpper = false;
    const threshold = Math.abs(maxDev / 2);
    for (let k = peakIdx; k >= 0; k--) {
      if (Math.abs(err[k].gain) < threshold) {
        lower = err[k].freq;
        foundLower = true;
        break;
      }
    }
    for (let k = peakIdx; k < err.length; k++) {
      if (Math.abs(err[k].gain) < threshold) {
        upper = err[k].freq;
        foundUpper = true;
        break;
      }
    }
    if (!foundLower && foundUpper) lower = (peakFreq * peakFreq) / upper;
    else if (!foundUpper && foundLower) upper = (peakFreq * peakFreq) / lower;
    else if (!foundLower && !foundUpper) {
      lower = peakFreq / Math.SQRT2;
      upper = peakFreq * Math.SQRT2;
    }

    let bandwidth = Math.log2(upper / Math.max(1, lower));
    if (bandwidth < 0.1) bandwidth = 0.1;
    let q = Math.sqrt(Math.pow(2, bandwidth)) / (Math.pow(2, bandwidth) - 1);
    q = Math.max(MIN_Q, Math.min(maxQ, q));
    if (peakFreq > 5000 && q > 3) q = 3;
    if (gain > 0 && q > 2) q = 2;

    const band: EqBand = { type: 'peaking', freq: peakFreq, gain, q, enabled: true, channel: 'stereo' };

    // Cap the cumulative boost at the peak across the bands already placed.
    let cumulative = gain;
    for (const existing of out) cumulative += biquadResponseDb(peakFreq, existing, sr);
    if (cumulative > MAX_BOOST) {
      band.gain = gain - (cumulative - MAX_BOOST);
      if (band.gain < 0.2) continue;
    }

    out.push(band);
    err = err.map((p) => ({ ...p, gain: p.gain + biquadResponseDb(p.freq, band, sr) }));
  }
  return out.sort((a, b) => a.freq - b.freq);
}

/** The corrected response: `measurement` plus the level offset plus every band. */
export function correctedCurve(
  measurement: readonly FrPoint[],
  target: readonly FrPoint[],
  bands: readonly EqBand[],
  preamp = 0,
  sampleRate = DSP_DEFAULT_SAMPLE_RATE,
): FrPoint[] {
  const off = normalizationOffset(measurement, target);
  return measurement.map((p) => {
    let g = p.gain + off + preamp;
    for (const b of bands) g += biquadResponseDb(p.freq, b, sampleRate);
    return { freq: p.freq, gain: g };
  });
}
