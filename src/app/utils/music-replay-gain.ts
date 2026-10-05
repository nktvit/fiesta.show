// Ported from Monochrome (Apache-2.0), js/replay-gain.js - adapted for Fiesta.
// getReplayGainScale is a verbatim port (typed); effectiveVolume is Fiesta's
// volume pipeline around it.

export type ReplayGainMode = 'off' | 'track' | 'album';

/** The loudness fields TIDAL's playbackinfo carries (dB for gains, linear peaks). */
export interface ReplayGainValues {
  trackReplayGain?: number | string | null;
  trackPeakAmplitude?: number | string | null;
  albumReplayGain?: number | string | null;
  albumPeakAmplitude?: number | string | null;
  programLoudnessLufs?: number | string | null;
}

function finiteReplayGainNumber(value: unknown): number | null {
  if (typeof value === 'string' && value.trim() === '') return null;
  const parsed =
    typeof value === 'number' ? value : typeof value === 'string' ? Number.parseFloat(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Linear gain for a track: its ReplayGain (track or album) plus the preamp,
 * capped so the peak never clips (scale * peak <= 1).
 */
export function getReplayGainScale(
  rgValues: ReplayGainValues | null = null,
  { mode = 'off', preampDb = 0 }: { mode?: ReplayGainMode; preampDb?: number } = {},
): number {
  if (mode === 'off' || !rgValues) return 1;

  const trackGainDb = finiteReplayGainNumber(rgValues.trackReplayGain);
  const albumGainDb = finiteReplayGainNumber(rgValues.albumReplayGain);
  const programLoudness = finiteReplayGainNumber(rgValues.programLoudnessLufs);
  const trackPeak = finiteReplayGainNumber(rgValues.trackPeakAmplitude);
  const albumPeak = finiteReplayGainNumber(rgValues.albumPeakAmplitude);
  let gainDb = 0;
  let peak = 1;

  if (mode === 'album' && albumGainDb !== null && albumGainDb !== 0) {
    gainDb = albumGainDb;
    peak = albumPeak !== null && albumPeak > 0 ? albumPeak : 1;
  } else if (trackGainDb !== null && trackGainDb !== 0) {
    gainDb = trackGainDb;
    peak = trackPeak !== null && trackPeak > 0 ? trackPeak : 1;
  } else if (programLoudness !== null) {
    gainDb = -18 - programLoudness;
    peak = trackPeak !== null && trackPeak > 0 ? trackPeak : 1;
  } else {
    gainDb = trackGainDb || 0;
    peak = trackPeak !== null && trackPeak > 0 ? trackPeak : 1;
  }

  gainDb += finiteReplayGainNumber(preampDb) || 0;
  const scale = Math.pow(10, gainDb / 20);
  return scale * peak > 1 ? 1 / peak : scale;
}

export interface VolumeInputs {
  /** 0..1, the slider value. */
  volume: number;
  muted: boolean;
  /** Cubic perceptual curve. */
  exponential: boolean;
  /** From getReplayGainScale. */
  replayGain?: number;
  /** Sleep-timer fade, 0..1. */
  fade?: number;
  /** Per-deck crossfade gain, 0..1. */
  deck?: number;
}

/** The element volume: (muted ? 0 : volume^(exp ? 3 : 1)) * rg * fade * deck, clamped 0..1. */
export function effectiveVolume(v: VolumeInputs): number {
  if (v.muted) return 0;
  const base = Math.min(1, Math.max(0, v.volume));
  const curved = v.exponential ? base * base * base : base;
  const out = curved * (v.replayGain ?? 1) * (v.fade ?? 1) * (v.deck ?? 1);
  return Math.min(1, Math.max(0, Number.isFinite(out) ? out : 0));
}
