// Ported from Monochrome (Apache-2.0), js/binaural-dsp.js (crossfeed presets, widener gains) - adapted for Fiesta.

/** Persisted DSP settings (`fiesta:music:dsp`). */
export interface DspState {
  v: 1;
  /** (L+R)/2 downmix to both ears. */
  mono: boolean;
  crossfeed: { enabled: boolean; /** Cross-path gain in dB (-12..-1.5): how much of each channel leaks to the other ear. */ level: number; /** Low-pass cutoff of the cross path, Hz. */ cutoff: number };
  widener: { enabled: boolean; /** 0 = mono, 1 = unchanged, 2 = extra wide. */ width: number };
}

export const CROSSFEED_LEVEL_MIN = -12;
export const CROSSFEED_LEVEL_MAX = -1.5;
export const CROSSFEED_CUTOFF_MIN = 300;
export const CROSSFEED_CUTOFF_MAX = 1500;
export const WIDTH_MIN = 0;
export const WIDTH_MAX = 2;

/** bs2b-style presets. */
export const CROSSFEED_PRESETS = {
  low: { cutoff: 500, level: -6 },
  medium: { cutoff: 700, level: -4.5 },
  high: { cutoff: 1000, level: -3 },
} as const;

export type CrossfeedPresetId = keyof typeof CROSSFEED_PRESETS;

export function defaultDspState(): DspState {
  return {
    v: 1,
    mono: false,
    crossfeed: { enabled: false, ...CROSSFEED_PRESETS.medium },
    widener: { enabled: false, width: 1 },
  };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const num = (v: unknown, fb: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fb);

export function sanitizeDspState(raw: unknown): DspState {
  const def = defaultDspState();
  if (!raw || typeof raw !== 'object') return def;
  const r = raw as Record<string, unknown>;
  const cf = (r['crossfeed'] && typeof r['crossfeed'] === 'object' ? r['crossfeed'] : {}) as Record<string, unknown>;
  const wd = (r['widener'] && typeof r['widener'] === 'object' ? r['widener'] : {}) as Record<string, unknown>;
  return {
    v: 1,
    mono: r['mono'] === true,
    crossfeed: {
      enabled: cf['enabled'] === true,
      level: clamp(num(cf['level'], def.crossfeed.level), CROSSFEED_LEVEL_MIN, CROSSFEED_LEVEL_MAX),
      cutoff: clamp(num(cf['cutoff'], def.crossfeed.cutoff), CROSSFEED_CUTOFF_MIN, CROSSFEED_CUTOFF_MAX),
    },
    widener: { enabled: wd['enabled'] === true, width: clamp(num(wd['width'], 1), WIDTH_MIN, WIDTH_MAX) },
  };
}

/** Whether any DSP effect is switched on. */
export const dspAnyEnabled = (s: DspState): boolean => s.mono || s.crossfeed.enabled || s.widener.enabled;

export interface CrossfeedParams {
  /** Linear gain of the cross paths. */
  cross: number;
  /** Linear gain of the direct paths (slightly reduced to keep loudness). */
  direct: number;
  /** Interaural delay of the cross path, seconds. */
  delay: number;
  cutoff: number;
}

/** Node values for a crossfeed setting. */
export function crossfeedParams(level: number, cutoff: number): CrossfeedParams {
  const cross = Math.pow(10, clamp(level, CROSSFEED_LEVEL_MIN, CROSSFEED_LEVEL_MAX) / 20);
  return { cross, direct: 1 - cross * 0.5, delay: 0.0003, cutoff: clamp(cutoff, CROSSFEED_CUTOFF_MIN, CROSSFEED_CUTOFF_MAX) };
}

/** Mid and side gains of the stereo widener: mid untouched, side scaled by `width`. */
export function widenerGains(width: number): { mid: number; side: number } {
  return { mid: 1, side: clamp(width, WIDTH_MIN, WIDTH_MAX) };
}

/** Pure reference of what the widener does to one stereo sample (for the unit spec). */
export function widenSample(l: number, r: number, width: number): [number, number] {
  const mid = (l + r) / 2;
  const side = ((l - r) / 2) * widenerGains(width).side;
  return [mid + side, mid - side];
}

/** Pure reference of the mono downmix. */
export const monoSample = (l: number, r: number): [number, number] => [(l + r) / 2, (l + r) / 2];

/** The preset id whose values match, or ''. */
export function matchCrossfeedPreset(level: number, cutoff: number): CrossfeedPresetId | '' {
  for (const id of Object.keys(CROSSFEED_PRESETS) as CrossfeedPresetId[]) {
    const p = CROSSFEED_PRESETS[id];
    if (p.level === level && p.cutoff === cutoff) return id;
  }
  return '';
}
