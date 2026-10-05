import {
  MUSIC_VIZ_PRESETS, bindVizControl, nextPreset, prevPreset, stepPreset, toggleCycle,
} from './music-visualizer-presets';

describe('music-visualizer-presets', () => {
  it('lists the five presets', () => {
    expect(MUSIC_VIZ_PRESETS.map((p) => p.label)).toEqual(['Particles', 'LCD', 'Unknown Pleasures', 'Butterchurn', 'Kawarp']);
  });

  it('steps with wrap-around and treats unknown ids as the first', () => {
    expect(stepPreset('particles', 1)).toBe('lcd');
    expect(stepPreset('kawarp', 1)).toBe('particles');
    expect(stepPreset('particles', -1)).toBe('kawarp');
    expect(stepPreset('nope', 1)).toBe('lcd');
  });

  it('is a no-op (null) when no visualizer is bound', () => {
    expect(nextPreset()).toBeNull();
    expect(prevPreset()).toBeNull();
    expect(toggleCycle()).toBeNull();
  });

  it('drives the bound control', () => {
    let preset = 'lcd';
    let cycle = false;
    const unbind = bindVizControl({
      getPreset: () => preset, setPreset: (id) => (preset = id), getCycle: () => cycle, setCycle: (v) => (cycle = v),
    });
    expect(nextPreset()).toBe('unknown-pleasures');
    expect(preset).toBe('unknown-pleasures');
    expect(prevPreset()).toBe('lcd');
    expect(toggleCycle()).toBe(true);
    expect(toggleCycle()).toBe(false);
    unbind();
    expect(nextPreset()).toBeNull();
  });
});
