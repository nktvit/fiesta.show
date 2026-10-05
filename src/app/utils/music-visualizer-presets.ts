/** Visualizer preset ids, labels and the cycling helpers (keys `]` `[` `\`). */
export interface MusicVizPresetInfo {
  id: string;
  label: string;
}

export const MUSIC_VIZ_PRESETS: readonly MusicVizPresetInfo[] = [
  { id: 'particles', label: 'Particles' },
  { id: 'lcd', label: 'LCD' },
  { id: 'unknown-pleasures', label: 'Unknown Pleasures' },
  { id: 'butterchurn', label: 'Butterchurn' },
  { id: 'kawarp', label: 'Kawarp' },
];

export const MUSIC_VIZ_DEFAULT_PRESET = 'particles';

/** Persisted under fiesta:music:visualizer (MusicSettingsService.scoped('visualizer', ...)). */
export interface MusicVizScoped {
  cycle: boolean;
  cycleSeconds: number;
  sensitivity: number;
  animateAnyway: boolean;
}

export const MUSIC_VIZ_SCOPED_DEFAULTS: Readonly<MusicVizScoped> = Object.freeze({
  cycle: false,
  cycleSeconds: 30,
  sensitivity: 1,
  animateAnyway: false,
});

export function isVizPreset(id: unknown): id is string {
  return typeof id === 'string' && MUSIC_VIZ_PRESETS.some((p) => p.id === id);
}

/** `current` moved by `dir` steps with wrap-around; unknown ids count as the first preset. */
export function stepPreset(current: string, dir: 1 | -1): string {
  const n = MUSIC_VIZ_PRESETS.length;
  const i = Math.max(0, MUSIC_VIZ_PRESETS.findIndex((p) => p.id === current));
  return MUSIC_VIZ_PRESETS[(i + dir + n) % n].id;
}

/** Reads and writes the current preset / cycle flag; bound by the visualizer component. */
export interface MusicVizControl {
  getPreset(): string;
  setPreset(id: string): void;
  getCycle(): boolean;
  setCycle(on: boolean): void;
}

let control: MusicVizControl | null = null;

/** The visualizer component binds itself here while it exists; returns the unbind function. */
export function bindVizControl(c: MusicVizControl): () => void {
  control = c;
  return () => {
    if (control === c) control = null;
  };
}

/** Switches to the next preset. Returns the new id, or null when no visualizer is mounted. */
export function nextPreset(): string | null {
  if (!control) return null;
  const id = stepPreset(control.getPreset(), 1);
  control.setPreset(id);
  return id;
}

export function prevPreset(): string | null {
  if (!control) return null;
  const id = stepPreset(control.getPreset(), -1);
  control.setPreset(id);
  return id;
}

/** Toggles auto-cycling. Returns the new state, or null when no visualizer is mounted. */
export function toggleCycle(): boolean | null {
  if (!control) return null;
  const on = !control.getCycle();
  control.setCycle(on);
  return on;
}
