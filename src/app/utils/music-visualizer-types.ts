import { VizStats } from './music-visualizer-analysis';

/** What a preset needs from the host component when it attaches to a fresh canvas. */
export interface VizEnv {
  analyser: AnalyserNode | null;
  audioContext: AudioContext | null;
  /** Cover URL as given (not yet proxied). */
  coverUrl: string;
}

export interface VizFrame {
  canvas: HTMLCanvasElement;
  analyser: AnalyserNode | null;
  /** Byte frequency data of this frame (analyser.getByteFrequencyData). */
  data: Uint8Array;
  stats: VizStats;
  /** Drawn over the cover: skip the opaque background. */
  blended: boolean;
  /** Accent colour as #rrggbb. */
  color: string;
}

/** One visualizer. Each preset owns its canvas context and is attached to a brand-new canvas. */
export interface VizPreset {
  /** Gets a context from `canvas`. Resolves false when the preset can't run here. */
  attach(canvas: HTMLCanvasElement, env: VizEnv): Promise<boolean>;
  resize(width: number, height: number): void;
  draw(f: VizFrame): void;
  /** The host's frame loop stopped (hidden tab, inactive, reduced motion): stop any loop of your own. */
  pause?(): void;
  resume?(): void;
  setCover?(url: string): void;
  destroy(): void;
}

/** #rrggbb -> [r, g, b] 0..255 (white when malformed). */
export function parseHex(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [255, 255, 255];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** `hex` with every channel scaled by `factor`, as an rgb() string. */
export function scaleColor(hex: string, factor: number): string {
  const [r, g, b] = parseHex(hex);
  const c = (v: number) => Math.min(255, Math.max(0, Math.round(v * factor)));
  return `rgb(${c(r)},${c(g)},${c(b)})`;
}

/** The context type the browser gives for a canvas that has none yet, tried in order. */
export function getGl(canvas: HTMLCanvasElement, opts: WebGLContextAttributes): WebGLRenderingContext | null {
  try {
    return (canvas.getContext('webgl2', opts) ?? canvas.getContext('webgl', opts)) as WebGLRenderingContext | null;
  } catch {
    return null;
  }
}
