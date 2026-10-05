import { artistThemeVars } from './music-artist-theme';
import { paletteFromHue } from './music-color';

describe('music-artist-theme', () => {
  it('maps a palette to --ag-* variables', () => {
    const v = artistThemeVars(paletteFromHue(0.05, 0.6));
    expect(v['--ag-accent']).toMatch(/^#[0-9a-f]{6}$/);
    expect(v['--ag-glow-a']).toMatch(/^rgba\(\d+, \d+, \d+, 0\.34\)$/);
    expect(v['--ag-panel']).toMatch(/^rgb\(/);
  });

  it('clears every variable without a palette (no leaking between artists)', () => {
    const v = artistThemeVars(null);
    expect(Object.keys(v).length).toBeGreaterThan(5);
    expect(Object.values(v).every((x) => x === null)).toBeTrue();
  });

  it('different palettes give different variables', () => {
    expect(artistThemeVars(paletteFromHue(0.0, 0.7))['--ag-deep']).not.toBe(artistThemeVars(paletteFromHue(0.5, 0.7))['--ag-deep']);
  });
});
