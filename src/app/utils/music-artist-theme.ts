import { ArtistPalette } from './music-color';

function rgb(hex: string): [number, number, number] {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}

function rgba(hex: string, a: number): string {
  const [r, g, b] = rgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

/** `hex` pulled `t` of the way towards white. */
function lighten(hex: string, t: number): string {
  const c = rgb(hex).map((v) => Math.round(v + (255 - v) * t));
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}

/**
 * CSS custom properties of the artist theme (`--ag-*`), bound on the page root with
 * [style.--ag-accent] etc. Templates read them with fallbacks (var(--ag-accent, #4f46e5)),
 * so a page without a palette keeps the indigo look and a navigation resets by dropping them.
 */
export function artistThemeVars(p: ArtistPalette | null): Record<string, string | null> {
  const names = ['--ag-accent', '--ag-accent-text', '--ag-secondary', '--ag-mid', '--ag-deep', '--ag-panel', '--ag-glow-a', '--ag-glow-b', '--ag-deep-a'];
  if (!p) return Object.fromEntries(names.map((n) => [n, null]));
  return {
    '--ag-accent': p.accent,
    '--ag-accent-text': p.accentText,
    '--ag-secondary': p.secondary,
    '--ag-mid': p.mid,
    '--ag-deep': p.deep,
    // Opaque stand-in for a glass panel (no backdrop-filter, reduced transparency).
    '--ag-panel': lighten(p.deep, 0.07),
    '--ag-glow-a': rgba(p.secondary, 0.34),
    '--ag-glow-b': rgba(p.accent, 0.3),
    '--ag-deep-a': rgba(p.deep, 0.55),
  };
}
