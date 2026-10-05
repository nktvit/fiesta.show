// Ported from Monochrome (Apache-2.0), js/visualizer.js - adapted for Fiesta.

/** Per-frame audio statistics every preset draws from (beat detection state). */
export interface VizStats {
  /** 0..1, jumps to 1 on a kick and decays. */
  kick: number;
  intensity: number;
  energyAverage: number;
  lastBeatTime: number;
  lastIntensity: number;
  upbeatSmoother: number;
  sensitivity: number;
}

export function createVizStats(): VizStats {
  return { kick: 0, intensity: 0, energyAverage: 0.3, lastBeatTime: 0, lastIntensity: 0, upbeatSmoother: 0, sensitivity: 1 };
}

export interface VizAnalysisInput {
  /** Byte frequency data (analyser.getByteFrequencyData), or null when there is no analyser. */
  data: Uint8Array | null;
  sampleRate: number;
  fftSize: number;
  /** Element volume 0..1; the bass reading is divided by it so quiet playback still pulses. */
  volume: number;
  sensitivity: number;
  /** performance.now() */
  now: number;
}

/** Updates `stats` in place from one frame of frequency data (bass band up to ~250 Hz). */
export function updateVizStats(stats: VizStats, inp: VizAnalysisInput): VizStats {
  const { data } = inp;
  if (!data || !data.length || !inp.fftSize) {
    stats.kick *= 0.92;
    stats.intensity *= 0.92;
    stats.energyAverage *= 0.98;
    stats.upbeatSmoother *= 0.95;
    stats.sensitivity = inp.sensitivity;
    return stats;
  }
  // Upstream divided by 10 * volume, which capped intensity at 0.1 so no beat could ever fire; here the
  // bass reading is only compensated for volume and clamped to 0..1.
  const volume = Math.max(inp.volume, 0.1);
  const binSize = inp.sampleRate / inp.fftSize;
  const startBin = 1;
  const numBins = Math.max(1, Math.floor(250 / binSize));
  let maxVal = 0;
  for (let i = 0; i < numBins && startBin + i < data.length; i++) {
    if (data[startBin + i] > maxVal) maxVal = data[startBin + i];
  }
  const bass = Math.min(1, maxVal / 255 / volume);
  const intensity = bass * bass * 1.5;

  stats.energyAverage = stats.energyAverage * 0.99 + intensity * 0.01;
  stats.upbeatSmoother = stats.upbeatSmoother * 0.92 + intensity * 0.08;

  const threshold = stats.energyAverage < 0.3 ? 0.5 + (0.3 - stats.energyAverage) * 2 : 0.5;
  if (intensity > threshold * 0.7) {
    if (intensity > stats.lastIntensity + 0.03 && inp.now - stats.lastBeatTime > 50) {
      stats.kick = 1;
      stats.lastBeatTime = inp.now;
    } else if (stats.upbeatSmoother > 0.6 && stats.energyAverage > 0.4) {
      const upbeat = (stats.upbeatSmoother - 0.6) / 0.4;
      if (stats.kick < upbeat) stats.kick = upbeat;
      else stats.kick *= 0.95;
    } else {
      stats.kick *= 0.9;
    }
  } else {
    stats.kick *= 0.95;
  }
  stats.lastIntensity = intensity;
  stats.intensity = intensity;
  stats.sensitivity = inp.sensitivity;
  return stats;
}
