import { contrastWithWhite, ensureContrast, hslToRgb, rgbToHsl, toHex, vibrantFromPixels } from './music-color';

function solid(r: number, g: number, b: number, n = 64, a = 255): Uint8ClampedArray {
  const d = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) d.set([r, g, b, a], i * 4);
  return d;
}
function mix(...parts: Uint8ClampedArray[]): Uint8ClampedArray {
  const out = new Uint8ClampedArray(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

describe('music-color', () => {
  it('round-trips rgb <-> hsl', () => {
    const [h, s, l] = rgbToHsl(200, 50, 80);
    const c = hslToRgb(h, s, l);
    expect(Math.abs(c.r - 200)).toBeLessThanOrEqual(1);
    expect(Math.abs(c.g - 50)).toBeLessThanOrEqual(1);
    expect(Math.abs(c.b - 80)).toBeLessThanOrEqual(1);
  });

  it('toHex pads and clamps', () => {
    expect(toHex({ r: 0, g: 5, b: 300 })).toBe('#0005ff');
  });

  it('white text contrast is 21 on black and 1 on white', () => {
    expect(contrastWithWhite({ r: 0, g: 0, b: 0 })).toBeCloseTo(21, 0);
    expect(contrastWithWhite({ r: 255, g: 255, b: 255 })).toBeCloseTo(1, 0);
  });

  it('ensureContrast darkens light colours to >= 4.5 and leaves dark ones alone', () => {
    const out = ensureContrast({ r: 250, g: 220, b: 60 });
    expect(contrastWithWhite(out)).toBeGreaterThanOrEqual(4.5);
    const dark = { r: 20, g: 30, b: 90 };
    expect(ensureContrast(dark)).toEqual(dark);
  });

  it('picks the dominant vibrant hue, not a stray pixel', () => {
    const data = mix(solid(30, 60, 220, 200), solid(220, 30, 30, 5), solid(240, 240, 240, 100));
    const c = vibrantFromPixels(data)!;
    expect(c.b).toBeGreaterThan(c.r);
    expect(c.b).toBeGreaterThan(c.g);
    expect(contrastWithWhite(c)).toBeGreaterThanOrEqual(4.5);
  });

  it('two different covers give different colours', () => {
    const a = toHex(vibrantFromPixels(solid(220, 40, 40))!);
    const b = toHex(vibrantFromPixels(solid(40, 200, 80))!);
    expect(a).not.toBe(b);
  });

  it('skips transparent pixels and returns null for pure black/white/transparent', () => {
    expect(vibrantFromPixels(solid(255, 0, 0, 16, 0))).toBeNull();
    expect(vibrantFromPixels(solid(0, 0, 0))).toBeNull();
    expect(vibrantFromPixels(solid(255, 255, 255))).toBeNull();
  });

  it('falls back to muted colours when nothing is vibrant', () => {
    const c = vibrantFromPixels(solid(120, 120, 120));
    expect(c).not.toBeNull();
  });
});
