// Ported from Monochrome (Apache-2.0), js/vibrant-color.js - adapted for Fiesta.
// Dominant "vibrant" colour of a cover, made safe for white text.
//
// Upstream picked the single most saturated pixel, which flips between covers
// on one noisy pixel. Here candidates vote into 12 hue buckets (weighted by
// saturation), the winning bucket's pixels are averaged, and the result is
// darkened until white text on it has WCAG AA contrast.

import { proxiedImage } from './music-format';

export interface Rgb { r: number; g: number; b: number }

/** Neutral background used when dynamic colour is off or extraction fails. */
export const NEUTRAL_BACKGROUND = '#121212';

const SIZE = 64;
const BUCKETS = 12;

export function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h / 6, s, l];
}

export function hslToRgb(h: number, s: number, l: number): Rgb {
  if (s === 0) { const v = Math.round(l * 255); return { r: v, g: v, b: v }; }
  const hue = (p: number, q: number, t: number): number => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return {
    r: Math.round(hue(p, q, h + 1 / 3) * 255),
    g: Math.round(hue(p, q, h) * 255),
    b: Math.round(hue(p, q, h - 1 / 3) * 255),
  };
}

export function toHex({ r, g, b }: Rgb): string {
  const x = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return `#${x(r)}${x(g)}${x(b)}`;
}

/** WCAG relative luminance, 0..1. */
export function luminance({ r, g, b }: Rgb): number {
  const f = (c: number): number => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/** WCAG contrast ratio of white text on `bg` (1..21). */
export function contrastWithWhite(bg: Rgb): number {
  return 1.05 / (luminance(bg) + 0.05);
}

/** Darkens (keeping hue and saturation) until white text reaches `min` contrast. */
export function ensureContrast(c: Rgb, min = 4.5): Rgb {
  if (contrastWithWhite(c) >= min) return c;
  const [h, s, l0] = rgbToHsl(c.r, c.g, c.b);
  for (let l = l0; l > 0; l -= 0.01) {
    const out = hslToRgb(h, s, Math.max(0, l));
    if (contrastWithWhite(out) >= min) return out;
  }
  return { r: 0, g: 0, b: 0 };
}

/**
 * The most vibrant dominant colour of RGBA pixel data, already safe for white
 * text; null when the image is (nearly) all black, white or transparent.
 */
export function vibrantFromPixels(data: ArrayLike<number>): Rgb | null {
  interface Bucket { weight: number; r: number; g: number; b: number; n: number }
  const strict: Bucket[] = Array.from({ length: BUCKETS }, () => ({ weight: 0, r: 0, g: 0, b: 0, n: 0 }));
  const loose: Bucket[] = Array.from({ length: BUCKETS }, () => ({ weight: 0, r: 0, g: 0, b: 0, n: 0 }));
  for (let i = 0; i + 3 < data.length; i += 4) {
    if (data[i + 3] < 125) continue;
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const [h, s, l] = rgbToHsl(r, g, b);
    const k = Math.min(BUCKETS - 1, Math.floor(h * BUCKETS));
    // Vibrant: saturated, mid lightness. Fallback: anything that is not near black/white.
    const target = s >= 0.3 && l >= 0.3 && l <= 0.8 ? strict[k] : l > 0.1 && l < 0.95 ? loose[k] : null;
    if (!target) continue;
    // Weighted by saturation, favouring mid lightness; achromatic pixels still count a little.
    const w = (s + 0.05) * (1 - Math.abs(l - 0.5));
    target.weight += w; target.r += r * w; target.g += g * w; target.b += b * w; target.n++;
  }
  const pool = strict.some((x) => x.n) ? strict : loose;
  let best: Bucket | null = null;
  for (const bk of pool) if (bk.n && (!best || bk.weight > best.weight)) best = bk;
  if (!best || best.weight <= 0) return null;
  return ensureContrast({ r: best.r / best.weight, g: best.g / best.weight, b: best.b / best.weight });
}

const cache = new Map<string, string | null>();

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('cover failed to load'));
    img.src = src;
  });
}

/**
 * Accent colour (hex, white-text safe) of a cover, read through the same-origin
 * image proxy so the canvas stays untainted. Cached per URL. null on failure.
 */
export async function coverColor(url: string): Promise<string | null> {
  if (!url || typeof document === 'undefined') return null;
  if (cache.has(url)) return cache.get(url) ?? null;
  let out: string | null = null;
  try {
    const img = await loadImage(proxiedImage(url));
    const canvas = document.createElement('canvas');
    canvas.width = SIZE;
    canvas.height = SIZE;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (ctx) {
      ctx.drawImage(img, 0, 0, SIZE, SIZE);
      const rgb = vibrantFromPixels(ctx.getImageData(0, 0, SIZE, SIZE).data);
      out = rgb ? toHex(rgb) : null;
    }
  } catch {
    out = null;
  }
  cache.set(url, out);
  return out;
}
