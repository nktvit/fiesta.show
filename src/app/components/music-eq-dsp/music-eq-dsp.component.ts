import { Component, computed, inject } from '@angular/core';
import { MusicAudioGraphService } from '../../services/music-audio-graph.service';
import {
  CROSSFEED_CUTOFF_MAX, CROSSFEED_CUTOFF_MIN, CROSSFEED_LEVEL_MAX, CROSSFEED_LEVEL_MIN, CROSSFEED_PRESETS, CrossfeedPresetId,
  matchCrossfeedPreset, WIDTH_MAX, WIDTH_MIN,
} from '../../utils/music-dsp-math';
import { MusicEqSwitchComponent } from '../music-eq-switch/music-eq-switch.component';

/** Mono downmix (FX18), crossfeed (FX19) and stereo widener (FX20) in one panel (FX21). Stereo only. */
@Component({
  selector: 'app-music-eq-dsp',
  imports: [MusicEqSwitchComponent],
  templateUrl: './music-eq-dsp.component.html',
  host: { class: 'block' },
})
export class MusicEqDspComponent {
  protected readonly graph = inject(MusicAudioGraphService);
  protected readonly dsp = this.graph.dsp;

  protected readonly levelMin = CROSSFEED_LEVEL_MIN;
  protected readonly levelMax = CROSSFEED_LEVEL_MAX;
  protected readonly cutoffMin = CROSSFEED_CUTOFF_MIN;
  protected readonly cutoffMax = CROSSFEED_CUTOFF_MAX;
  protected readonly widthMin = WIDTH_MIN;
  protected readonly widthMax = WIDTH_MAX;
  protected readonly presets: { id: CrossfeedPresetId; label: string }[] = [
    { id: 'low', label: 'Low' },
    { id: 'medium', label: 'Medium' },
    { id: 'high', label: 'High' },
  ];
  protected readonly activePreset = computed(() => matchCrossfeedPreset(this.dsp().crossfeed.level, this.dsp().crossfeed.cutoff));

  protected setMono(on: boolean): void {
    this.graph.setDsp((s) => ({ ...s, mono: on }));
  }

  protected setCrossfeed(on: boolean): void {
    this.graph.setDsp((s) => ({ ...s, crossfeed: { ...s.crossfeed, enabled: on } }));
  }

  protected setLevel(v: string): void {
    this.graph.setDsp((s) => ({ ...s, crossfeed: { ...s.crossfeed, level: parseFloat(v) } }));
  }

  protected setCutoff(v: string): void {
    this.graph.setDsp((s) => ({ ...s, crossfeed: { ...s.crossfeed, cutoff: parseFloat(v) } }));
  }

  protected setPreset(id: CrossfeedPresetId): void {
    const p = CROSSFEED_PRESETS[id];
    this.graph.setDsp((s) => ({ ...s, crossfeed: { ...s.crossfeed, level: p.level, cutoff: p.cutoff } }));
  }

  protected setWidener(on: boolean): void {
    this.graph.setDsp((s) => ({ ...s, widener: { ...s.widener, enabled: on } }));
  }

  protected setWidth(v: string): void {
    this.graph.setDsp((s) => ({ ...s, widener: { ...s.widener, width: parseFloat(v) } }));
  }

  protected widthLabel(w: number): string {
    return w === 1 ? '1.00 (unchanged)' : w === 0 ? '0.00 (mono)' : w.toFixed(2);
  }
}
