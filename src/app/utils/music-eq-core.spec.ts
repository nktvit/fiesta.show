import {
  activeBands, addBandInGap, removeBandAt, sanitizeCustomPresets, updateBand, defaultEqState, EqBand, EqState, freqLabel, generateFrequencies, graphicFrequencies, graphicQ, interpolateGains,
  needsMidSide, parametricFromPreset, presetGains, resizeBands, sanitizeEqState,
} from './music-eq-core';
import { EQ_PRESETS, EQ_STRUCTURE_PRESETS } from './music-eq-presets';
import { exportEqText, importEqText } from './music-eq-text';

describe('music-eq-core', () => {
  it('has the 16 built-in presets', () => {
    expect(EQ_PRESETS.length).toBe(16);
    expect(EQ_PRESETS.every((p) => p.gains.length === 16)).toBeTrue();
  });

  it('graphic frequencies: 10 bands use the octave set and labels are short', () => {
    expect(graphicFrequencies(10)).toEqual([31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]);
    expect(graphicFrequencies(16).length).toBe(16);
    expect(graphicFrequencies(5).length).toBe(5);
    expect(graphicFrequencies(99).length).toBe(32);
    expect(freqLabel(63)).toBe('63');
    expect(freqLabel(1000)).toBe('1K');
    expect(freqLabel(1600)).toBe('1.6K');
    expect(freqLabel(16000)).toBe('16K');
  });

  it('constant Q for the octave set is about 1.41', () => {
    expect(graphicQ(graphicFrequencies(10))).toBeCloseTo(1.41, 1);
  });

  it('interpolates presets to any band count and keeps the end points', () => {
    for (const n of [3, 10, 16, 32]) {
      const g = presetGains('bass_boost', n);
      expect(g?.length).toBe(n);
      expect(g?.[0]).toBe(6);
    }
    expect(interpolateGains([0, 10], 3)).toEqual([0, 5, 10]);
    expect(presetGains('nope', 10)).toBeNull();
  });

  it('sanitizes garbage into a valid state', () => {
    const s = sanitizeEqState({ enabled: true, mode: 'weird', preamp: 99, graphicCount: 1, graphicGains: [1, 2], bands: [{ freq: -5, gain: 99, q: 0 }], autoeqBands: 'x' });
    expect(s.enabled).toBeTrue();
    expect(s.mode).toBe('graphic');
    expect(s.preamp).toBe(20);
    expect(s.graphicCount).toBe(3);
    expect(s.graphicGains.length).toBe(3);
    expect(s.bands.length).toBeGreaterThanOrEqual(3);
    expect(s.autoeqBands).toEqual([]);
    expect(sanitizeEqState(null)).toEqual(defaultEqState());
  });

  it('activeBands follows the mode and drops disabled bands', () => {
    const s: EqState = { ...defaultEqState(), graphicGains: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] };
    expect(activeBands(s).map((b) => b.gain)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const p: EqState = { ...s, mode: 'parametric', bands: [{ ...s.bands[0], enabled: false }, s.bands[1], s.bands[2]] };
    expect(activeBands(p).length).toBe(2);
    const a: EqState = { ...s, mode: 'autoeq', autoeqBands: [] };
    expect(activeBands(a)).toEqual([]);
  });

  it('M/S detection, resize and preset application', () => {
    const ms = EQ_STRUCTURE_PRESETS.find((p) => p.ms);
    expect(needsMidSide(ms!.bands)).toBeTrue();
    expect(needsMidSide(defaultEqState().bands)).toBeFalse();
    expect(resizeBands(defaultEqState().bands, 20).length).toBe(20);
    const cur = defaultEqState().bands;
    const applied = parametricFromPreset('rock', cur)!;
    expect(applied.length).toBe(cur.length);
    expect(applied.some((b) => b.gain !== 0)).toBeTrue();
    expect(parametricFromPreset('ms_hiphop', cur)!.some((b) => b.channel === 'side')).toBeTrue();
    expect(generateFrequencies(5, 20, 20000)[0]).toBe(20);
  });
});

describe('music-eq-text (EqualizerAPO)', () => {
  const bands: EqBand[] = [
    { type: 'peaking', freq: 100, gain: 3.5, q: 1.2, channel: 'stereo', enabled: true },
    { type: 'lowshelf', freq: 60, gain: -2, q: 0.71, channel: 'stereo', enabled: true },
    { type: 'highshelf', freq: 9000, gain: 1.5, q: 0.5, channel: 'stereo', enabled: false },
    { type: 'peaking', freq: 3500, gain: -4.2, q: 4.5, channel: 'stereo', enabled: true },
  ];

  it('exports Preamp and Filter lines', () => {
    const t = exportEqText(-3.2, bands);
    expect(t.split('\n')[0]).toBe('Preamp: -3.2 dB');
    expect(t).toContain('Filter 1: ON PK Fc 100 Hz Gain 3.5 dB Q 1.20');
    expect(t).toContain('Filter 2: ON LSC Fc 60 Hz Gain -2.0 dB Q 0.71');
    expect(t).toContain('Filter 3: OFF HSC Fc 9000 Hz Gain 1.5 dB Q 0.50');
  });

  it('round-trips: import(export(x)) restores the same bands', () => {
    const r = importEqText(exportEqText(-3.2, bands))!;
    expect(r.preamp).toBe(-3.2);
    expect(r.bands).toEqual(bands);
  });

  it('imports the AutoEQ / Peace variants and skips noise', () => {
    const r = importEqText('# comment\nPreamp: -4.9 dB\nFilter: ON PK Fc 31 Hz Gain 2.4 dB Q 1.20\nFilter 2: ON LP Fc 5000 Hz\nFilter 3: ON HSC Fc 10000 Hz Gain -3 dB')!;
    expect(r.preamp).toBe(-4.9);
    expect(r.bands.length).toBe(2);
    expect(r.bands[1].type).toBe('highshelf');
    expect(r.bands[1].q).toBeCloseTo(Math.SQRT1_2, 5);
    expect(importEqText('nothing here')).toBeNull();
  });
});

describe('music-eq-core band editing', () => {
  it('updates, removes (never below 3) and adds bands in the widest gap', () => {
    const bands = defaultEqState().bands;
    const edited = updateBand(bands, 2, { ...bands[2], gain: 99, freq: 1234 });
    expect(edited[2].gain).toBe(24);
    expect(edited[2].freq).toBe(1234);
    expect(edited.length).toBe(bands.length);
    expect(removeBandAt(bands, 0).length).toBe(bands.length - 1);
    expect(removeBandAt(bands.slice(0, 3), 0).length).toBe(3);
    const three = bands.slice(0, 3);
    const added = addBandInGap(three);
    expect(added.length).toBe(4);
    expect(added[3].freq).toBeGreaterThan(three[2].freq);
    expect(addBandInGap(resizeBands(bands, 32)).length).toBe(32);
  });

  it('custom presets sanitize', () => {
    expect(sanitizeCustomPresets('x')).toEqual([]);
    const c = sanitizeCustomPresets([{ id: 'a', name: 'N', count: 3, gains: [1, 2, 3] }, { id: 1 }, null]);
    expect(c).toEqual([{ id: 'a', name: 'N', count: 3, gains: [1, 2, 3] }]);
  });
});
