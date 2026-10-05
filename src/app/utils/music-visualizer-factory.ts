import { ButterchurnPreset } from './music-visualizer-butterchurn';
import { KawarpPreset } from './music-visualizer-kawarp';
import { LcdPreset } from './music-visualizer-lcd';
import { ParticlesPreset } from './music-visualizer-particles';
import { UnknownPleasuresPreset } from './music-visualizer-unknown-pleasures';
import { VizPreset } from './music-visualizer-types';

/** A new preset instance for `id` (unknown ids give Particles). */
export function createVizPreset(id: string): VizPreset {
  switch (id) {
    case 'lcd': return new LcdPreset();
    case 'unknown-pleasures': return new UnknownPleasuresPreset();
    case 'butterchurn': return new ButterchurnPreset();
    case 'kawarp': return new KawarpPreset();
    default: return new ParticlesPreset();
  }
}
