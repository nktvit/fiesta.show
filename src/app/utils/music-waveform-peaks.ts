// Ported from Monochrome (Apache-2.0), js/waveform.js (getSilenceBoundaries) - adapted for Fiesta.

/** How many peaks a track is reduced to. */
export const WAVEFORM_BUCKETS = 1000;

/**
 * Max-abs per bucket over all channels, normalised so the loudest bucket is 1.
 * Returns zeros for silent or empty input.
 */
export function computePeaks(channels: ArrayLike<number>[], buckets: number = WAVEFORM_BUCKETS): Float32Array {
  const out = new Float32Array(buckets);
  const len = channels.reduce((m, c) => Math.max(m, c.length), 0);
  if (!len || buckets < 1) return out;
  const per = len / buckets;
  for (const ch of channels) {
    for (let b = 0; b < buckets; b++) {
      const from = Math.floor(b * per);
      const to = Math.min(ch.length, Math.max(from + 1, Math.floor((b + 1) * per)));
      let m = out[b];
      for (let i = from; i < to; i++) {
        const v = Math.abs(ch[i]);
        if (v > m) m = v;
      }
      out[b] = m;
    }
  }
  let max = 0;
  for (let b = 0; b < buckets; b++) if (out[b] > max) max = out[b];
  if (max > 0) for (let b = 0; b < buckets; b++) out[b] /= max;
  return out;
}

export interface SilenceBoundaries {
  leadingSilenceSeconds: number;
  trailingSilenceStartTime: number;
  crossfadeStartTime: number;
  crossfadeDurationSeconds: number;
  hasTrailingSilence: boolean;
}

/** Default threshold on normalised peaks (Monochrome used 5 on a 0..255 scale). */
export const SILENCE_THRESHOLD = 5 / 255;

/**
 * Where the audible part of a track starts and ends. `samples` are normalised
 * peaks (0..1) spread evenly over `duration` seconds. A track that never reaches
 * the threshold is never trimmed.
 */
export function getSilenceBoundaries(
  samples: ArrayLike<number> | null | undefined,
  duration: number,
  threshold: number = SILENCE_THRESHOLD,
  crossfadeDurationSeconds = 3,
): SilenceBoundaries {
  const none = (): SilenceBoundaries => ({
    leadingSilenceSeconds: 0,
    trailingSilenceStartTime: duration || 0,
    crossfadeStartTime: duration || 0,
    crossfadeDurationSeconds: 0,
    hasTrailingSilence: false,
  });
  if (!samples || !samples.length || !duration || duration <= 0) return none();

  let first = 0;
  while (first < samples.length && samples[first] < threshold) first++;
  let last = samples.length - 1;
  while (last >= 0 && samples[last] < threshold) last--;
  if (last < 0 || first >= samples.length) return none();

  const leadingSilenceSeconds = (first / samples.length) * duration;
  const trailingSilenceStartTime = ((last + 1) / samples.length) * duration;
  const hasTrailingSilence = duration - trailingSilenceStartTime > 0.5;
  const transitionEnd = hasTrailingSilence ? trailingSilenceStartTime : duration;
  const available = Math.max(0, Math.min(crossfadeDurationSeconds, transitionEnd - leadingSilenceSeconds));
  return {
    leadingSilenceSeconds,
    trailingSilenceStartTime,
    crossfadeStartTime: transitionEnd - available,
    crossfadeDurationSeconds: available,
    hasTrailingSilence,
  };
}

/** The keys to evict so at most `max` remain, oldest `at` first. */
export function lruEvictions(entries: { key: number; at: number }[], max: number): number[] {
  if (entries.length <= max) return [];
  return [...entries].sort((a, b) => a.at - b.at).slice(0, entries.length - max).map((e) => e.key);
}

/** SVG path data for a mirrored peak strip in a `w` x `h` box (x from 0..w). Empty for no peaks. */
export function peaksToPath(peaks: ArrayLike<number> | null | undefined, w = 1000, h = 100, bars = 200): string {
  if (!peaks || !peaks.length) return '';
  const mid = h / 2;
  const step = w / bars;
  const per = peaks.length / bars;
  let d = '';
  for (let b = 0; b < bars; b++) {
    let m = 0;
    const from = Math.floor(b * per);
    const to = Math.max(from + 1, Math.floor((b + 1) * per));
    for (let i = from; i < to && i < peaks.length; i++) if (peaks[i] > m) m = peaks[i];
    const half = Math.max(1, m * mid * 0.95);
    const x = (b * step + step * 0.15).toFixed(2);
    const bw = (step * 0.7).toFixed(2);
    d += `M${x} ${(mid - half).toFixed(2)}h${bw}v${(half * 2).toFixed(2)}h-${bw}z`;
  }
  return d;
}
