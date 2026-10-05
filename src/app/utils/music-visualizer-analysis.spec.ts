import { createVizStats, updateVizStats } from './music-visualizer-analysis';

describe('music-visualizer-analysis', () => {
  const frame = (bass: number) => {
    const d = new Uint8Array(512);
    d.fill(bass, 1, 8);
    return d;
  };
  const input = (data: Uint8Array | null, now: number) => ({ data, sampleRate: 48000, fftSize: 1024, volume: 1, sensitivity: 1, now });

  it('fires a kick on a sudden bass jump and then decays', () => {
    const s = createVizStats();
    for (let i = 0; i < 20; i++) updateVizStats(s, input(frame(5), i * 16));
    expect(s.kick).toBeLessThan(0.2);
    updateVizStats(s, input(frame(255), 400));
    expect(s.kick).toBe(1);
    for (let i = 0; i < 30; i++) updateVizStats(s, input(frame(5), 500 + i * 16));
    expect(s.kick).toBeLessThan(0.3);
  });

  it('decays toward zero without data', () => {
    const s = createVizStats();
    s.kick = 1;
    s.intensity = 2;
    for (let i = 0; i < 60; i++) updateVizStats(s, input(null, i));
    expect(s.kick).toBeLessThan(0.02);
    expect(s.intensity).toBeLessThan(0.05);
  });

  it('passes sensitivity through', () => {
    const s = createVizStats();
    updateVizStats(s, { ...input(frame(10), 1), sensitivity: 2 });
    expect(s.sensitivity).toBe(2);
  });
});
