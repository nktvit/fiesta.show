import { CrossfadeClock, crossfade, equalPowerGains, probeVolume, supportsElementVolume } from './music-crossfade';

/** A manual clock: `advance(ms)` runs the scheduled frame, if any. */
function fakeClock() {
  let t = 0;
  let cb: (() => void) | null = null;
  const clock: CrossfadeClock = {
    now: () => t,
    schedule: (f) => { cb = f; return () => { if (cb === f) cb = null; }; },
  };
  return {
    clock,
    advance(ms: number) { t += ms; const f = cb; cb = null; f?.(); },
    get pending() { return cb !== null; },
  };
}

describe('music-crossfade', () => {
  const el = () => ({} as HTMLAudioElement);

  it('equalPowerGains: both ~0.707 at the midpoint, constant power', () => {
    const g = equalPowerGains(0.5);
    expect(g.out).toBeCloseTo(0.7071, 3);
    expect(g.incoming).toBeCloseTo(0.7071, 3);
    for (const p of [0, 0.2, 0.5, 0.9, 1]) {
      const x = equalPowerGains(p);
      expect(x.out * x.out + x.incoming * x.incoming).toBeCloseTo(1, 6);
    }
    expect(equalPowerGains(-1)).toEqual({ out: 1, incoming: 0 });
  });

  it('ramps out down and incoming up along the curve (fake elements + clock)', async () => {
    const out = el();
    const inc = el();
    const gains = new Map<HTMLAudioElement, number>();
    const c = fakeClock();
    const done = crossfade(out, inc, 5, (e, g) => gains.set(e, g), new AbortController().signal, c.clock);

    expect(gains.get(out)).toBe(1);
    expect(gains.get(inc)).toBe(0);
    c.advance(2500); // 50 %
    expect(gains.get(out)).toBeCloseTo(0.7071, 3);
    expect(gains.get(inc)).toBeCloseTo(0.7071, 3);
    c.advance(1250); // 75 %
    expect(gains.get(out)!).toBeLessThan(0.7071);
    expect(gains.get(inc)!).toBeGreaterThan(0.7071);

    c.advance(1250); // 100 %
    await done;
    expect(gains.get(out)).toBe(0);
    expect(gains.get(inc)).toBe(1);
    expect(c.pending).toBe(false);
  });

  it('aborting snaps to the incoming track and stops scheduling', async () => {
    const out = el();
    const inc = el();
    const gains = new Map<HTMLAudioElement, number>();
    const c = fakeClock();
    const ac = new AbortController();
    const done = crossfade(out, inc, 8, (e, g) => gains.set(e, g), ac.signal, c.clock);
    c.advance(1000);
    expect(gains.get(inc)!).toBeLessThan(1);
    ac.abort();
    await done;
    expect(gains.get(inc)).toBe(1);
    expect(gains.get(out)).toBe(0);
    expect(c.pending).toBe(false);
  });

  it('zero seconds or an already-aborted signal cuts immediately', async () => {
    const out = el();
    const inc = el();
    const gains = new Map<HTMLAudioElement, number>();
    await crossfade(out, inc, 0, (e, g) => gains.set(e, g), new AbortController().signal, fakeClock().clock);
    expect(gains.get(inc)).toBe(1);
    expect(gains.get(out)).toBe(0);
    const ac = new AbortController();
    ac.abort();
    gains.clear();
    await crossfade(out, inc, 5, (e, g) => gains.set(e, g), ac.signal, fakeClock().clock);
    expect(gains.get(inc)).toBe(1);
  });

  it('works with the real browser clock', async () => {
    const gains = new Map<HTMLAudioElement, number>();
    const out = el();
    const inc = el();
    await crossfade(out, inc, 0.15, (e, g) => gains.set(e, g), new AbortController().signal);
    expect(gains.get(inc)).toBe(1);
  });

  it('probeVolume is false when volume is read-only, true when writable', () => {
    expect(probeVolume(() => ({ get volume() { return 1; }, set volume(_v: number) { /* ignored, like iOS */ } }))).toBe(false);
    expect(probeVolume(() => { throw new Error('no Audio'); })).toBe(false);
    expect(probeVolume(() => ({ volume: 1 }))).toBe(true);
  });

  it('supportsElementVolume probes a writable volume and caches', () => {
    const first = supportsElementVolume();
    expect(typeof first).toBe('boolean');
    expect(supportsElementVolume()).toBe(first);
    // Headless Chrome allows volume writes.
    expect(first).toBe(true);
  });
});
