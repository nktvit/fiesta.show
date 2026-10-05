// Ported from Monochrome (Apache-2.0), js/visualizers/kawarp.js - adapted for Fiesta.
// `@kawarp/core` is loaded with dynamic import() only when this preset is attached. The cover comes
// from the host (through proxiedImage) instead of a DOM mutation observer.
import type { Kawarp } from '@kawarp/core';
import { proxiedImage } from './music-format';
import { VizEnv, VizFrame, VizPreset } from './music-visualizer-types';

const DEFAULTS = {
  warpIntensity: 1, blurPasses: 8, animationSpeed: 1, transitionDuration: 1000, saturation: 1.5, dithering: 0.008, scale: 1.25,
};
const BEAT_THRESHOLD = 0.75;
const SPEED_MULTIPLIER = 4;
const BOOSTED_SCALE = DEFAULTS.scale + 0.02;
const ANALYSIS_INTERVAL = 100;

export class KawarpPreset implements VizPreset {
  private kawarp: Kawarp | null = null;
  private running = false;
  private lastCover = '';
  private scale = DEFAULTS.scale;
  private targetScale = DEFAULTS.scale;
  private lastAnalysis = 0;
  private buf: Uint8Array<ArrayBuffer> | null = null;
  private disposed = false;

  async attach(canvas: HTMLCanvasElement, env: VizEnv): Promise<boolean> {
    try {
      const { Kawarp: K } = await import('@kawarp/core');
      if (this.disposed) return false;
      this.kawarp = new K(canvas, { ...DEFAULTS });
      this.setCover(env.coverUrl);
      this.kawarp.start();
      this.running = true;
      return true;
    } catch (e) {
      console.warn('[visualizer] Kawarp could not start', e);
      this.destroy();
      return false;
    }
  }

  setCover(url: string): void {
    if (!this.kawarp || !url || url === this.lastCover) return;
    this.lastCover = url;
    this.kawarp.loadImage(proxiedImage(url)).catch(() => undefined);
  }

  resize(): void {
    this.kawarp?.resize();
  }

  pause(): void {
    if (this.kawarp && this.running) {
      this.kawarp.stop();
      this.running = false;
    }
  }

  resume(): void {
    if (this.kawarp && !this.running) {
      this.kawarp.start();
      this.running = true;
    }
  }

  draw(f: VizFrame): void {
    const k = this.kawarp;
    if (!k) return;
    const now = performance.now();
    if (f.analyser && now - this.lastAnalysis >= ANALYSIS_INTERVAL) {
      const n = f.analyser.frequencyBinCount;
      if (!this.buf || this.buf.length !== n) this.buf = new Uint8Array(n);
      f.analyser.getByteTimeDomainData(this.buf);
      let peak = 0;
      for (let i = 0; i < this.buf.length; i++) {
        const a = Math.abs(this.buf[i] - 128) / 128;
        if (a > peak) {
          peak = a;
          if (peak > BEAT_THRESHOLD) break;
        }
      }
      const beat = peak > BEAT_THRESHOLD;
      k.animationSpeed = beat ? DEFAULTS.animationSpeed * SPEED_MULTIPLIER : DEFAULTS.animationSpeed;
      this.targetScale = beat ? BOOSTED_SCALE : DEFAULTS.scale;
      this.lastAnalysis = now;
    }
    const diff = this.targetScale - this.scale;
    if (Math.abs(diff) > 0.001) {
      this.scale += diff * (diff > 0 ? 0.5 : 0.12);
      k.scale = this.scale;
    }
  }

  destroy(): void {
    this.disposed = true;
    if (this.kawarp) {
      try {
        this.kawarp.stop();
        this.kawarp.dispose();
      } catch {
        // already disposed
      }
    }
    this.kawarp = null;
    this.running = false;
  }
}
