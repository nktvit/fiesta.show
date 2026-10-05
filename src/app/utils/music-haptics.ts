// Ported from Monochrome (Apache-2.0), js/haptics.js - adapted for Fiesta.

/** Short tick for transport taps. No-op when disabled or unsupported (iOS, desktop, SSR). Returns whether it fired. */
export function hapticTap(enabled: boolean, ms = 10): boolean {
  if (!enabled || typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return false;
  try {
    return navigator.vibrate(ms);
  } catch {
    return false;
  }
}
