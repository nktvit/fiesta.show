// Ported from Monochrome (Apache-2.0), js/equalizer.js and js/storage.js (equalizerSettings) - adapted for Fiesta.
import { DspBiquadBand, DspFilterType, logSpace } from './music-dsp-biquad';
import { EQ_PRESET_FREQUENCIES, EQ_PRESETS, EQ_STRUCTURE_PRESETS } from './music-eq-presets';

export type EqFilterType = DspFilterType;
export type EqChannel = 'stereo' | 'mid' | 'side';
export type EqMode = 'graphic' | 'parametric' | 'autoeq';

export interface EqBand extends DspBiquadBand {
  type: EqFilterType;
  freq: number;
  gain: number;
  q: number;
  channel: EqChannel;
  enabled: boolean;
}

export const EQ_MIN_BANDS = 3;
export const EQ_MAX_BANDS = 32;
export const EQ_DEFAULT_GRAPHIC_BANDS = 10;
export const EQ_PREAMP_MIN = -20;
export const EQ_PREAMP_MAX = 20;
export const EQ_GAIN_LIMIT = 24;
export const EQ_FREQ_MIN = 10;
export const EQ_FREQ_MAX = 22000;
export const EQ_Q_MIN = 0.1;
export const EQ_Q_MAX = 20;
/** Slider range of the graphic EQ (dB). */
export const EQ_GRAPHIC_RANGE = 12;

/** Persisted EQ settings (`fiesta:music:eq`). */
export interface EqState {
  v: 1;
  enabled: boolean;
  mode: EqMode;
  preamp: number;
  graphicCount: number;
  graphicGains: number[];
  /** Id of the preset the graphic gains came from; '' = custom. */
  graphicPreset: string;
  /** The parametric band set. */
  bands: EqBand[];
  parametricPreset: string;
  /** The band set an AutoEQ run (or profile) produced. */
  autoeqBands: EqBand[];
  autoeqLabel: string;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const num = (v: unknown, fb: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fb);

export const clampBandCount = (n: number): number => Math.round(clamp(num(n, EQ_DEFAULT_GRAPHIC_BANDS), EQ_MIN_BANDS, EQ_MAX_BANDS));
export const clampGain = (g: number): number => clamp(num(g, 0), -EQ_GAIN_LIMIT, EQ_GAIN_LIMIT);
export const clampFreq = (f: number): number => clamp(num(f, 1000), EQ_FREQ_MIN, EQ_FREQ_MAX);
export const clampQ = (q: number): number => clamp(num(q, 1), EQ_Q_MIN, EQ_Q_MAX);
export const clampPreamp = (p: number): number => clamp(num(p, 0), EQ_PREAMP_MIN, EQ_PREAMP_MAX);

/** Log-spaced, rounded frequencies (Hz) for `count` bands. */
export function generateFrequencies(count: number, min = 20, max = 20000): number[] {
  const n = clampBandCount(count);
  return logSpace(Math.max(10, min), Math.min(96000, max), n).map((f) => Math.round(f));
}

/** Centre frequencies of the graphic EQ: the octave set for 10, the ISO set for 16, else log-spaced. */
export function graphicFrequencies(count: number): number[] {
  const n = clampBandCount(count);
  if (n === 10) return [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
  if (n === 16) return [...EQ_PRESET_FREQUENCIES];
  return generateFrequencies(n, 25, 20000);
}

/** "63", "1K", "1.6K", "16K". */
export function freqLabel(freq: number): string {
  if (freq < 1000) return String(Math.round(freq));
  const k = freq / 1000;
  return (Number.isInteger(k) || freq >= 10000 ? k.toFixed(0) : k.toFixed(1)) + 'K';
}

/** Constant-Q for log-spaced bands: neighbours meet at their half-gain points. */
export function graphicQ(freqs: readonly number[]): number {
  if (freqs.length < 2) return 1;
  const octaves = Math.log2(freqs[freqs.length - 1] / freqs[0]) / (freqs.length - 1);
  const p = Math.pow(2, Math.max(0.05, octaves));
  return Math.round((Math.sqrt(p) / (p - 1)) * 100) / 100;
}

/** Linear resample of a gain curve onto `count` bands (index-proportional, 0.1 dB steps). */
export function interpolateGains(gains: readonly number[], count: number): number[] {
  const n = clampBandCount(count);
  if (gains.length === 0) return new Array<number>(n).fill(0);
  if (gains.length === n) return [...gains];
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const src = (i / (n - 1)) * (gains.length - 1);
    const lo = Math.floor(src);
    const hi = Math.min(Math.ceil(src), gains.length - 1);
    const v = gains[lo] + (gains[hi] - gains[lo]) * (src - lo);
    out.push(Math.round(v * 10) / 10);
  }
  return out;
}

/** Gains of built-in preset `id` on `count` bands, or null for an unknown id. */
export function presetGains(id: string, count: number): number[] | null {
  const p = EQ_PRESETS.find((x) => x.id === id);
  return p ? interpolateGains(p.gains, count) : null;
}

export function defaultBands(count = EQ_DEFAULT_GRAPHIC_BANDS): EqBand[] {
  const freqs = graphicFrequencies(count);
  const q = graphicQ(freqs);
  return freqs.map((freq) => ({ type: 'peaking', freq, gain: 0, q, channel: 'stereo', enabled: true }));
}

export function defaultEqState(): EqState {
  return {
    v: 1,
    enabled: false,
    mode: 'graphic',
    preamp: 0,
    graphicCount: EQ_DEFAULT_GRAPHIC_BANDS,
    graphicGains: new Array<number>(EQ_DEFAULT_GRAPHIC_BANDS).fill(0),
    graphicPreset: 'flat',
    bands: defaultBands(),
    parametricPreset: '',
    autoeqBands: [],
    autoeqLabel: '',
  };
}

export function sanitizeBand(raw: unknown): EqBand | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const type: EqFilterType = r['type'] === 'lowshelf' || r['type'] === 'highshelf' ? r['type'] : 'peaking';
  const channel: EqChannel = r['channel'] === 'mid' || r['channel'] === 'side' ? r['channel'] : 'stereo';
  return {
    type,
    channel,
    freq: clampFreq(num(r['freq'], 1000)),
    gain: clampGain(num(r['gain'], 0)),
    q: clampQ(num(r['q'], 1)),
    enabled: r['enabled'] !== false,
  };
}

function sanitizeBands(raw: unknown): EqBand[] {
  if (!Array.isArray(raw)) return [];
  const out: EqBand[] = [];
  for (const b of raw.slice(0, EQ_MAX_BANDS)) {
    const s = sanitizeBand(b);
    if (s) out.push(s);
  }
  return out;
}

/** Makes whatever was stored (or imported) into a valid EqState. */
export function sanitizeEqState(raw: unknown): EqState {
  const def = defaultEqState();
  if (!raw || typeof raw !== 'object') return def;
  const r = raw as Record<string, unknown>;
  const graphicCount = clampBandCount(num(r['graphicCount'], def.graphicCount));
  const gains = Array.isArray(r['graphicGains']) ? (r['graphicGains'] as unknown[]).map((g) => clampGain(num(g, 0))) : [];
  let bands = sanitizeBands(r['bands']);
  if (bands.length < EQ_MIN_BANDS) bands = def.bands;
  const mode: EqMode = r['mode'] === 'parametric' || r['mode'] === 'autoeq' ? r['mode'] : 'graphic';
  return {
    v: 1,
    enabled: r['enabled'] === true,
    mode,
    preamp: clampPreamp(num(r['preamp'], 0)),
    graphicCount,
    graphicGains: gains.length === graphicCount ? gains : interpolateGains(gains, graphicCount),
    graphicPreset: typeof r['graphicPreset'] === 'string' ? r['graphicPreset'] : '',
    bands,
    parametricPreset: typeof r['parametricPreset'] === 'string' ? r['parametricPreset'] : '',
    autoeqBands: sanitizeBands(r['autoeqBands']),
    autoeqLabel: typeof r['autoeqLabel'] === 'string' ? r['autoeqLabel'].slice(0, 120) : '',
  };
}

/** The bands the audio graph runs for `state` (graphic gains become peaking bands). Disabled bands are dropped. */
export function activeBands(state: EqState): EqBand[] {
  let bands: EqBand[];
  if (state.mode === 'graphic') {
    const freqs = graphicFrequencies(state.graphicCount);
    const q = graphicQ(freqs);
    bands = freqs.map((freq, i) => ({ type: 'peaking', freq, gain: state.graphicGains[i] ?? 0, q, channel: 'stereo', enabled: true }));
  } else if (state.mode === 'parametric') {
    bands = state.bands;
  } else {
    bands = state.autoeqBands;
  }
  return bands.filter((b) => b.enabled);
}

/** Whether any active band is mid/side only (so the graph needs the M/S chains). */
export function needsMidSide(bands: readonly EqBand[]): boolean {
  return bands.some((b) => b.channel !== 'stereo');
}

/** New band count for the parametric editor: frequencies regenerated, gains resampled. */
export function resizeBands(bands: readonly EqBand[], count: number): EqBand[] {
  const n = clampBandCount(count);
  if (bands.length === n) return bands.map((b) => ({ ...b }));
  const freqs = graphicFrequencies(n);
  const q = graphicQ(freqs);
  const gains = interpolateGains(bands.map((b) => b.gain), n);
  return freqs.map((freq, i) => ({ type: 'peaking', freq, gain: gains[i], q, channel: 'stereo', enabled: true }));
}

/** Parametric bands from a preset id (gain preset on the current band count, or a structure preset). */
export function parametricFromPreset(id: string, current: readonly EqBand[]): EqBand[] | null {
  const s = EQ_STRUCTURE_PRESETS.find((p) => p.id === id);
  if (s) return s.bands.map((b) => ({ ...b }));
  const gains = presetGains(id, current.length);
  if (!gains) return null;
  return current.map((b, i) => ({ ...b, gain: gains[i], type: 'peaking', channel: 'stereo' }));
}

export function sortBandsByFreq(bands: readonly EqBand[]): EqBand[] {
  return [...bands].sort((a, b) => a.freq - b.freq);
}

/** A graphic-EQ preset the user saved. */
export interface EqCustomPreset {
  id: string;
  name: string;
  count: number;
  gains: number[];
}

export function sanitizeCustomPresets(raw: unknown): EqCustomPreset[] {
  if (!Array.isArray(raw)) return [];
  const out: EqCustomPreset[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    if (typeof o['id'] !== 'string' || typeof o['name'] !== 'string' || !Array.isArray(o['gains'])) continue;
    const count = clampBandCount(num(o['count'], (o['gains'] as unknown[]).length));
    const gains = (o['gains'] as unknown[]).map((g) => clampGain(num(g, 0)));
    out.push({ id: o['id'], name: o['name'].slice(0, 60), count, gains: gains.length === count ? gains : interpolateGains(gains, count) });
  }
  return out;
}

/** Replaces band `index` (validated), keeping the list otherwise as is. */
export function updateBand(bands: readonly EqBand[], index: number, band: EqBand): EqBand[] {
  const clean = sanitizeBand(band);
  return bands.map((b, i) => (i === index && clean ? clean : b));
}

/** Drops band `index` unless that would leave fewer than the minimum. */
export function removeBandAt(bands: readonly EqBand[], index: number): EqBand[] {
  if (bands.length <= EQ_MIN_BANDS) return [...bands];
  return bands.filter((_, i) => i !== index);
}

/** Adds a flat peaking band in the widest gap between existing bands (or at 1 kHz). */
export function addBandInGap(bands: readonly EqBand[]): EqBand[] {
  if (bands.length >= EQ_MAX_BANDS) return [...bands];
  const sorted = sortBandsByFreq(bands);
  let freq = 1000;
  let widest = 0;
  const edges = [20, ...sorted.map((b) => b.freq), 20000];
  for (let i = 0; i < edges.length - 1; i++) {
    const span = Math.log(edges[i + 1] / edges[i]);
    if (span > widest) {
      widest = span;
      freq = Math.sqrt(edges[i] * edges[i + 1]);
    }
  }
  return [...bands, { type: 'peaking', freq: Math.round(freq), gain: 0, q: 1.4, channel: 'stereo', enabled: true }];
}
