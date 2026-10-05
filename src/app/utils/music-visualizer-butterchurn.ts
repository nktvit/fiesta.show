// Ported from Monochrome (Apache-2.0), js/visualizers/butterchurn.js - adapted for Fiesta.
// `butterchurn` and `butterchurn-presets` are loaded with dynamic import() only when this preset is
// attached (the chunk is not requested for any other preset). Monochrome's script-tag loading of
// /lib/butterchurnPresets.min.js is replaced by the npm package.
import { VizEnv, VizFrame, VizPreset } from './music-visualizer-types';

interface ButterchurnVisualizer {
  connectAudio(node: AudioNode): void;
  disconnectAudio(node: AudioNode): void;
  loadPreset(preset: unknown, blendSeconds: number): void;
  setRendererSize(width: number, height: number): void;
  render(): void;
}
interface ButterchurnModule {
  createVisualizer(
    ctx: AudioContext, canvas: HTMLCanvasElement,
    opts: { width: number; height: number; pixelRatio: number; textureRatio: number },
  ): ButterchurnVisualizer;
}
interface PresetsModule {
  getPresets(): Record<string, unknown>;
}

/** The object that has `key`, looking through CommonJS/ESM interop `default` wrappers (bundlers differ). */
function unwrap<T>(mod: unknown, key: string): T {
  let m = mod as Record<string, unknown> | undefined;
  for (let depth = 0; m && depth < 4; depth++) {
    if (typeof m[key] === 'function') return m as unknown as T;
    m = m['default'] as Record<string, unknown> | undefined;
  }
  throw new Error(`module has no ${key}`);
}

/** Milkdrop presets that are placeholders rather than visuals. */
const SKIP = ['flexi', 'empty', 'test'];

export class ButterchurnPreset implements VizPreset {
  private viz: ButterchurnVisualizer | null = null;
  private analyser: AnalyserNode | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private presets: Record<string, unknown> = {};
  private keys: string[] = [];
  private index = 0;

  async attach(canvas: HTMLCanvasElement, env: VizEnv): Promise<boolean> {
    if (!env.audioContext || !env.analyser) return false;
    try {
      // @ts-ignore - butterchurn ships no type declarations.
      const bcMod = (await import('butterchurn')) as { default?: ButterchurnModule } & ButterchurnModule;
      // @ts-ignore - butterchurn-presets ships no type declarations.
      const prMod = (await import('butterchurn-presets')) as { default?: PresetsModule } & PresetsModule;
      const bc = unwrap<ButterchurnModule>(bcMod, 'createVisualizer');
      const pr = unwrap<PresetsModule>(prMod, 'getPresets');
      this.presets = pr.getPresets() ?? {};
      this.keys = Object.keys(this.presets)
        .filter((k) => !SKIP.some((s) => k.toLowerCase().includes(s)))
        .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
      this.viz = bc.createVisualizer(env.audioContext, canvas, {
        width: canvas.width || 1, height: canvas.height || 1, pixelRatio: 1, textureRatio: 1,
      });
      this.canvas = canvas;
      this.analyser = env.analyser;
      this.viz.connectAudio(env.analyser);
      this.index = Math.floor(Math.random() * Math.max(1, this.keys.length));
      this.load(this.index, 0);
      return true;
    } catch (e) {
      console.warn('[visualizer] Butterchurn could not start', e);
      this.destroy();
      return false;
    }
  }

  private load(i: number, blend: number): void {
    const key = this.keys[i];
    if (!this.viz || key === undefined) return;
    try {
      this.viz.loadPreset(this.presets[key], blend);
    } catch {
      // a broken milkdrop preset: keep the previous one
    }
  }

  /** Picks another Milkdrop preset at random. */
  randomize(): void {
    if (this.keys.length < 2) return;
    this.index = (this.index + 1 + Math.floor(Math.random() * (this.keys.length - 1))) % this.keys.length;
    this.load(this.index, 2.7);
  }

  resize(w: number, h: number): void {
    this.viz?.setRendererSize(Math.max(1, w), Math.max(1, h));
  }

  draw(_f: VizFrame): void {
    try {
      this.viz?.render();
    } catch {
      // a frame failed to render; the next one may work
    }
  }

  destroy(): void {
    try {
      if (this.viz && this.analyser) this.viz.disconnectAudio(this.analyser);
    } catch {
      // not connected
    }
    try {
      const c = this.canvas;
      (c?.getContext('webgl2') ?? c?.getContext('webgl'))?.getExtension('WEBGL_lose_context')?.loseContext();
    } catch {
      // already lost
    }
    this.viz = null;
    this.analyser = null;
    this.canvas = null;
  }
}
