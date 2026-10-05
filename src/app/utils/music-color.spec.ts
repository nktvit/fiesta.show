import {
  contrastWithWhite, ensureContrast, hslToRgb, luminance, NEUTRAL_PALETTE, paletteFromHue, paletteFromPixels, rgbToHsl, toHex, vibrantFromPixels,
} from './music-color';

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

  describe('artist palette', () => {
    const rgb = (hex: string) => ({ r: parseInt(hex.slice(1, 3), 16), g: parseInt(hex.slice(3, 5), 16), b: parseInt(hex.slice(5, 7), 16) });
    const ratio = (a: string, b: string) => {
      const [x, y] = [luminance(rgb(a)), luminance(rgb(b))].sort((p, q) => q - p);
      return (x + 0.05) / (y + 0.05);
    };

    it('keeps white text >= 4.5 on the accent for every hue', () => {
      for (let i = 0; i < 36; i++) {
        for (const s of [0.1, 0.5, 1]) {
          const p = paletteFromHue(i / 36, s);
          expect(contrastWithWhite(rgb(p.accent))).toBeGreaterThanOrEqual(4.5);
          expect(ratio(p.accentText, p.deep)).toBeGreaterThanOrEqual(4.5);
        }
      }
    });

    it('different dominant hues give different palettes', () => {
      const red = paletteFromPixels(solid(210, 40, 50));
      const green = paletteFromPixels(solid(40, 200, 90));
      expect(red.accent).not.toBe(green.accent);
      expect(red.deep).not.toBe(green.deep);
      expect(red.neutral).toBeFalse();
    });

    it('greys, black, white and empty images get the steel fallback', () => {
      expect(paletteFromPixels(solid(0, 0, 0))).toBe(NEUTRAL_PALETTE);
      expect(paletteFromPixels(solid(128, 128, 128))).toBe(NEUTRAL_PALETTE);
      expect(paletteFromPixels(solid(255, 255, 255))).toBe(NEUTRAL_PALETTE);
      expect(paletteFromPixels(solid(255, 0, 0, 8, 0))).toBe(NEUTRAL_PALETTE);
      expect(NEUTRAL_PALETTE.neutral).toBeTrue();
    });

    it('clamps neon and washed-out saturation', () => {
      const neon = rgbToHsl(...Object.values(rgb(paletteFromHue(0.3, 1).secondary)) as [number, number, number]);
      expect(neon[1]).toBeLessThanOrEqual(0.85);
      const pale = rgbToHsl(...Object.values(rgb(paletteFromHue(0.3, 0.02).deep)) as [number, number, number]);
      expect(pale[1]).toBeGreaterThan(0.05);
    });

    it('uses a distant second hue as the secondary, else shifts the first', () => {
      const two = paletteFromPixels(mix(solid(220, 40, 40, 100), solid(40, 90, 220, 60)));
      const one = paletteFromPixels(solid(220, 40, 40, 100));
      const hue = (hex: string) => rgbToHsl(rgb(hex).r, rgb(hex).g, rgb(hex).b)[0];
      expect(Math.abs(hue(two.secondary) - hue(two.accent))).toBeGreaterThan(0.3);
      expect(Math.abs(hue(one.secondary) - hue(one.accent))).toBeLessThan(0.2);
    });
  });
});
