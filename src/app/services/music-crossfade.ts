// Ported from Monochrome (Apache-2.0), js/player.js (crossfadeToNext) - adapted for Fiesta.

/** Equal-power gains at progress `p` (0..1): outgoing cos, incoming sin, so power stays constant. */
export function equalPowerGains(p: number): { out: number; incoming: number } {
  const c = Math.min(1, Math.max(0, p));
  return { out: Math.cos((c * Math.PI) / 2), incoming: Math.sin((c * Math.PI) / 2) };
}

/** Clock and frame scheduler; tests inject fakes. */
export interface CrossfadeClock {
  now(): number;
  /** Runs `cb` on the next frame (or soon, when the page is hidden); returns a cancel function. */
  schedule(cb: () => void): () => void;
}

/** requestAnimationFrame while visible; a 100 ms timer when hidden (rAF is paused there). */
export const browserClock: CrossfadeClock = {
  now: () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
  schedule(cb) {
    let done = false;
    const run = () => {
      if (done) return;
      done = true;
      cancel();
      cb();
    };
    const hidden = typeof document !== 'undefined' && document.hidden;
    const raf = !hidden && typeof requestAnimationFrame === 'function' ? requestAnimationFrame(run) : null;
    // rAF stalls when the tab hides mid-fade; the timer keeps the fade moving.
    const timer = setTimeout(run, raf === null ? 100 : 250);
    function cancel(): void {
      done = true;
      if (raf !== null) cancelAnimationFrame(raf);
      clearTimeout(timer);
    }
    return cancel;
  },
};

/**
 * Crossfade between the two decks with an equal-power curve over `seconds`.
 *
 * `gain(el, g)` sets an element's crossfade multiplier (0..1); the player folds
 * it into the element volume. Resolves when the fade is done; when `signal`
 * aborts, snaps to the incoming track (incoming 1, outgoing 0) and resolves.
 */
export function crossfade(
  out: HTMLAudioElement,
  incoming: HTMLAudioElement,
  seconds: number,
  gain: (el: HTMLAudioElement, g: number) => void,
  signal: AbortSignal,
  clock: CrossfadeClock = browserClock,
): Promise<void> {
  const finish = () => {
    gain(incoming, 1);
    gain(out, 0);
  };
  if (!(seconds > 0) || signal.aborted) {
    finish();
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    const ms = seconds * 1000;
    const t0 = clock.now();
    let cancel: (() => void) | null = null;
    const end = () => {
      signal.removeEventListener('abort', end);
      cancel?.();
      cancel = null;
      finish();
      resolve();
    };
    const step = () => {
      cancel = null;
      if (signal.aborted) return end();
      const p = (clock.now() - t0) / ms;
      if (p >= 1) return end();
      const g = equalPowerGains(p);
      gain(out, g.out);
      gain(incoming, g.incoming);
      cancel = clock.schedule(step);
    };
    signal.addEventListener('abort', end, { once: true });
    gain(out, 1);
    gain(incoming, 0);
    cancel = clock.schedule(step);
  });
}

let volumeProbe: boolean | null = null;

/** Writes then reads back a volume on a fresh element; iOS keeps it read-only. */
export function probeVolume(make: () => { volume: number }): boolean {
  try {
    const probe = make();
    probe.volume = 0.5;
    return Math.abs(probe.volume - 0.5) < 0.01;
  } catch {
    return false;
  }
}

/**
 * Whether element volume can be changed from script. iOS keeps it read-only
 * (hardware buttons only), so crossfade is disabled there with a note.
 */
export function supportsElementVolume(): boolean {
  if (volumeProbe !== null) return volumeProbe;
  volumeProbe = typeof Audio === 'undefined' ? false : probeVolume(() => new Audio());
  return volumeProbe;
}
