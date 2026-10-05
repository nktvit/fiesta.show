import { proxiedImage } from './music-format';

/** Largest allowed size of a custom cover data URL (the library stores it in localStorage). */
export const MUSIC_COVER_MAX_BYTES = 100 * 1024;

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image'));
    img.src = src;
  });
}

function drawCover(ctx: CanvasRenderingContext2D, img: HTMLImageElement, x: number, y: number, w: number): void {
  const s = Math.min(img.naturalWidth, img.naturalHeight) || 1;
  ctx.drawImage(img, (img.naturalWidth - s) / 2, (img.naturalHeight - s) / 2, s, s, x, y, w, w);
}

/** Size in bytes of the payload of a data URL (base64). */
export function dataUrlBytes(url: string): number {
  const i = url.indexOf(',');
  const b64 = i >= 0 ? url.slice(i + 1) : url;
  return Math.floor((b64.length * 3) / 4);
}

function encodeUnderLimit(canvas: HTMLCanvasElement, limit: number): string | null {
  for (const q of [0.85, 0.7, 0.55, 0.4, 0.3]) {
    const url = canvas.toDataURL('image/jpeg', q);
    if (dataUrlBytes(url) <= limit) return url;
  }
  return null;
}

/**
 * A 2x2 collage of the first four distinct covers as a JPEG data URL
 * (<= 100 KB), or null with fewer than four covers or when the canvas is
 * tainted/unavailable. Covers go through the same-origin image proxy.
 */
export async function buildCollage(covers: string[], size = 320): Promise<string | null> {
  if (typeof document === 'undefined' || covers.length < 4) return null;
  try {
    const imgs = await Promise.all(covers.slice(0, 4).map((c) => loadImage(proxiedImage(c))));
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    const h = size / 2;
    imgs.forEach((img, i) => drawCover(ctx, img, (i % 2) * h, Math.floor(i / 2) * h, h));
    return encodeUnderLimit(canvas, MUSIC_COVER_MAX_BYTES);
  } catch {
    return null;
  }
}

/**
 * Downscales an uploaded image file to a square-cropped JPEG data URL of at
 * most 100 KB. Rejects when the file is not a readable image.
 */
export async function imageFileToCover(file: File, size = 400): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error('not an image');
  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await loadImage(objectUrl);
    for (const s of [size, 300, 220, 160]) {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = s;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('canvas');
      drawCover(ctx, img, 0, 0, s);
      const url = encodeUnderLimit(canvas, MUSIC_COVER_MAX_BYTES);
      if (url) return url;
    }
    throw new Error('too large');
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}
