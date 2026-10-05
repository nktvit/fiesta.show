import { Component, computed, inject, signal } from '@angular/core';
import { MusicAudioGraphService } from '../../services/music-audio-graph.service';
import { MusicToastService } from '../../services/music-toast.service';
import { EQ_GRAPHIC_RANGE, freqLabel, graphicFrequencies } from '../../utils/music-eq-core';

/** Graphic EQ: one vertical slider per band (FX10) plus saving and deleting custom presets (FX11). */
@Component({
  selector: 'app-music-eq-graphic',
  templateUrl: './music-eq-graphic.component.html',
  host: { class: 'block' },
})
export class MusicEqGraphicComponent {
  protected readonly graph = inject(MusicAudioGraphService);
  private toast = inject(MusicToastService);

  protected readonly range = EQ_GRAPHIC_RANGE;
  protected readonly presetName = signal('');

  protected readonly cols = computed(() => {
    const eq = this.graph.eq();
    return graphicFrequencies(eq.graphicCount).map((freq, i) => ({
      freq,
      label: freqLabel(freq),
      gain: eq.graphicGains[i] ?? 0,
    }));
  });

  protected setGain(index: number, value: string): void {
    const v = Math.round(parseFloat(value) * 10) / 10;
    if (!Number.isFinite(v)) return;
    this.graph.setEq((s) => {
      const gains = [...s.graphicGains];
      gains[index] = v;
      return { ...s, graphicGains: gains, graphicPreset: '' };
    });
  }

  protected resetBand(index: number): void {
    this.setGain(index, '0');
  }

  protected saveCurrent(): void {
    const p = this.graph.saveCustomPreset(this.presetName());
    this.presetName.set('');
    this.toast.show({ message: `Saved preset "${p.name}"` });
  }

  protected deleteCustom(id: string, name: string): void {
    this.graph.deleteCustomPreset(id);
    this.toast.show({ message: `Deleted preset "${name}"` });
  }

  protected fmt(g: number): string {
    return (g > 0 ? '+' : '') + g.toFixed(1);
  }
}
