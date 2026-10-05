// Ported from Monochrome (Apache-2.0), js/equalizer.js (preset table), js/settings.js (M/S presets) - adapted for Fiesta.
import type { EqBand } from './music-eq-core';

/** The 16 ISO centre frequencies the built-in presets are defined on. */
export const EQ_PRESET_FREQUENCIES = [25, 40, 63, 100, 160, 250, 400, 630, 1000, 1600, 2500, 4000, 6300, 10000, 16000, 20000];

export interface EqPreset {
  id: string;
  name: string;
  /** Gains in dB at EQ_PRESET_FREQUENCIES. */
  gains: readonly number[];
}

/** The 16 built-in presets (interpolated to any band count by `interpolateGains`). */
export const EQ_PRESETS: readonly EqPreset[] = [
  { id: 'flat', name: 'Flat', gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  { id: 'bass_boost', name: 'Bass Boost', gains: [6, 5, 4.5, 4, 3, 2, 1, 0.5, 0, 0, 0, 0, 0, 0, 0, 0] },
  { id: 'bass_reducer', name: 'Bass Reducer', gains: [-6, -5, -4, -3, -2, -1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  { id: 'treble_boost', name: 'Treble Boost', gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 4, 5, 5.5, 6] },
  { id: 'treble_reducer', name: 'Treble Reducer', gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, -1, -2, -3, -4, -5, -5.5, -6] },
  { id: 'vocal_boost', name: 'Vocal Boost', gains: [-2, -1, 0, 0, 1, 2, 3, 4, 4, 3, 2, 1, 0, 0, -1, -2] },
  { id: 'loudness', name: 'Loudness', gains: [5, 4, 3, 1, 0, -1, -1, 0, 0, 1, 2, 3, 4, 4.5, 4, 3] },
  { id: 'rock', name: 'Rock', gains: [4, 3.5, 3, 2, -1, -2, -1, 1, 2, 3, 3.5, 4, 4, 3, 2, 1] },
  { id: 'pop', name: 'Pop', gains: [-1, 0, 1, 2, 3, 3, 2, 1, 0, 1, 2, 2, 2, 2, 1, 0] },
  { id: 'classical', name: 'Classical', gains: [3, 2, 1, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 3, 2] },
  { id: 'jazz', name: 'Jazz', gains: [3, 2, 1, 1, -1, -1, 0, 1, 2, 2, 2, 2, 2, 2, 2, 2] },
  { id: 'electronic', name: 'Electronic', gains: [4, 3.5, 3, 1, 0, -1, 0, 1, 2, 3, 3, 2, 2, 3, 4, 3.5] },
  { id: 'hip_hop', name: 'Hip-Hop', gains: [5, 4.5, 4, 3, 1, 0, 0, 1, 1, 1, 1, 1, 1, 2, 2, 2] },
  { id: 'r_and_b', name: 'R&B', gains: [3, 5, 4, 2, 1, 0, 1, 1, 1, 1, 2, 2, 2, 1, 1, 1] },
  { id: 'acoustic', name: 'Acoustic', gains: [3, 2, 1, 1, 2, 2, 1, 0, 0, 1, 1, 2, 3, 3, 2, 1] },
  { id: 'podcast', name: 'Podcast / Speech', gains: [-3, -2, -1, 0, 1, 2, 3, 4, 4, 3, 2, 1, 0, -1, -2, -3] },
];

/** A whole-band-set preset for the parametric editor (shelves, peaks and M/S bands). */
export interface EqStructurePreset {
  id: string;
  name: string;
  /** True when it uses mid/side bands. */
  ms: boolean;
  bands: readonly EqBand[];
}

type B = [type: EqBand['type'], freq: number, gain: number, q: number, channel: EqBand['channel']];
const mk = (rows: B[]): EqBand[] =>
  rows.map(([type, freq, gain, q, channel]) => ({ type, freq, gain, q, channel, enabled: true }));

/** Parametric / mid-side presets (shown beside the 16 gain presets in parametric mode). */
export const EQ_STRUCTURE_PRESETS: readonly EqStructurePreset[] = [
  { id: 'shelf_warm', name: 'Warm', ms: false, bands: mk([['lowshelf', 200, 3, 0.7, 'stereo'], ['highshelf', 6000, -2, 0.6, 'stereo'], ['peaking', 3000, -1, 1.2, 'stereo'], ['peaking', 800, 0.5, 0.8, 'stereo']]) },
  { id: 'shelf_bright', name: 'Bright & Airy', ms: false, bands: mk([['highshelf', 8000, 3, 0.5, 'stereo'], ['lowshelf', 150, -1.5, 0.6, 'stereo'], ['peaking', 5000, 1, 1.5, 'stereo'], ['peaking', 2500, 0.5, 1, 'stereo']]) },
  { id: 'shelf_hifi', name: 'Hi-Fi', ms: false, bands: mk([['lowshelf', 80, 2.5, 0.7, 'stereo'], ['highshelf', 10000, 2, 0.5, 'stereo'], ['peaking', 400, -1, 1, 'stereo'], ['peaking', 3000, 0.5, 1.5, 'stereo']]) },
  { id: 'shelf_dark', name: 'Dark & Smooth', ms: false, bands: mk([['highshelf', 5000, -3, 0.5, 'stereo'], ['lowshelf', 150, 2, 0.7, 'stereo'], ['peaking', 2500, -1.5, 1.2, 'stereo'], ['peaking', 600, 0.5, 0.8, 'stereo']]) },
  { id: 'shelf_radio', name: 'Radio Ready', ms: false, bands: mk([['lowshelf', 100, 2, 0.7, 'stereo'], ['peaking', 3000, 2, 1.8, 'stereo'], ['highshelf', 10000, 1.5, 0.5, 'stereo'], ['peaking', 500, -1.5, 1, 'stereo'], ['peaking', 7000, -0.5, 2, 'stereo']]) },
  { id: 'ms_vocal_clarity', name: 'M/S Vocal Clarity', ms: true, bands: mk([['lowshelf', 100, -3.5, 0.6, 'side'], ['peaking', 3500, 2, 2, 'mid'], ['peaking', 350, -1.5, 1.2, 'mid'], ['peaking', 3000, -1.5, 1.5, 'side'], ['highshelf', 12000, 1.5, 0.5, 'side'], ['peaking', 5000, 1, 2, 'mid']]) },
  { id: 'ms_wide_stereo', name: 'M/S Wide Stereo', ms: true, bands: mk([['lowshelf', 100, -4, 0.6, 'side'], ['peaking', 1200, 1.5, 1, 'side'], ['highshelf', 10000, 2, 0.5, 'side'], ['peaking', 5000, 1, 1.2, 'side'], ['peaking', 800, -1, 1, 'mid'], ['lowshelf', 60, 1, 0.7, 'mid']]) },
  { id: 'ms_mono_bass', name: 'M/S Mono Bass', ms: true, bands: mk([['lowshelf', 120, -5, 0.5, 'side'], ['peaking', 60, 2.5, 0.7, 'mid'], ['peaking', 120, 1, 1.2, 'mid'], ['peaking', 400, 1, 0.8, 'side'], ['highshelf', 10000, 1, 0.7, 'stereo']]) },
  { id: 'ms_master_polish', name: 'M/S Master Polish', ms: true, bands: mk([['lowshelf', 100, -3.5, 0.5, 'side'], ['peaking', 60, 1.5, 0.7, 'mid'], ['peaking', 350, -1, 1.2, 'mid'], ['peaking', 3000, 1.5, 2, 'mid'], ['peaking', 3000, -1, 1.5, 'side'], ['highshelf', 12000, 2, 0.5, 'side'], ['peaking', 7000, -0.5, 2, 'stereo'], ['peaking', 500, -0.5, 0.8, 'mid']]) },
  { id: 'ms_rock_master', name: 'M/S Rock Master', ms: true, bands: mk([['lowshelf', 100, -4, 0.5, 'side'], ['peaking', 3500, -2.5, 2, 'side'], ['peaking', 2500, 1.5, 1.8, 'mid'], ['peaking', 60, 1.5, 0.7, 'mid'], ['highshelf', 10000, 1.5, 0.5, 'side'], ['peaking', 400, -1, 1, 'mid'], ['peaking', 800, 1, 1, 'side']]) },
  { id: 'ms_hiphop', name: 'M/S Hip-Hop', ms: true, bands: mk([['lowshelf', 60, 2.5, 0.5, 'mid'], ['lowshelf', 100, -4.5, 0.5, 'side'], ['peaking', 3500, 1.5, 2, 'mid'], ['peaking', 7000, 1.5, 1, 'side'], ['highshelf', 12000, 1.5, 0.5, 'side'], ['peaking', 300, -1, 1, 'mid'], ['peaking', 500, -0.5, 0.8, 'mid']]) },
];
