import { Component, computed, inject, signal } from '@angular/core';
import { MusicEqAutoEqBrowserComponent } from '../../../../components/music-eq-autoeq-browser/music-eq-autoeq-browser.component';
import { EqBandEdit, MusicEqBandControlsComponent } from '../../../../components/music-eq-band-controls/music-eq-band-controls.component';
import { MusicEqDspComponent } from '../../../../components/music-eq-dsp/music-eq-dsp.component';
import { MusicEqGraphicComponent } from '../../../../components/music-eq-graphic/music-eq-graphic.component';
import { EqBandChange, MusicEqParametricGraphComponent } from '../../../../components/music-eq-parametric-graph/music-eq-parametric-graph.component';
import { MusicEqSwitchComponent } from '../../../../components/music-eq-switch/music-eq-switch.component';
import { MusicAudioGraphService } from '../../../../services/music-audio-graph.service';
import { MusicToastService } from '../../../../services/music-toast.service';
import {
  activeBands, addBandInGap, clampPreamp, defaultBands, defaultEqState, EQ_MAX_BANDS, EQ_MIN_BANDS, EQ_PREAMP_MAX, EQ_PREAMP_MIN, EqBand,
  EqMode, interpolateGains, parametricFromPreset, presetGains, removeBandAt, resizeBands, updateBand,
} from '../../../../utils/music-eq-core';
import { EQ_PRESETS, EQ_STRUCTURE_PRESETS } from '../../../../utils/music-eq-presets';
import { exportEqText, importEqText } from '../../../../utils/music-eq-text';

/** Music settings: Audio section (equalizer, AutoEQ, mono/crossfeed/widener). Owned by package P4. */
@Component({
  selector: 'app-music-settings-audio',
  imports: [
    MusicEqSwitchComponent, MusicEqGraphicComponent, MusicEqParametricGraphComponent, MusicEqBandControlsComponent,
    MusicEqAutoEqBrowserComponent, MusicEqDspComponent,
  ],
  templateUrl: './music-settings-audio.component.html',
  host: { class: 'block' },
})
export class MusicSettingsAudioComponent {
  protected readonly graph = inject(MusicAudioGraphService);
  private toast = inject(MusicToastService);

  protected readonly eq = this.graph.eq;
  protected readonly modes: { id: EqMode; label: string }[] = [
    { id: 'graphic', label: 'Graphic' },
    { id: 'parametric', label: 'Parametric' },
    { id: 'autoeq', label: 'AutoEQ' },
  ];
  protected readonly presets = EQ_PRESETS;
  protected readonly structurePresets = EQ_STRUCTURE_PRESETS;
  protected readonly preampMin = EQ_PREAMP_MIN;
  protected readonly preampMax = EQ_PREAMP_MAX;
  protected readonly counts = Array.from({ length: EQ_MAX_BANDS - EQ_MIN_BANDS + 1 }, (_, i) => EQ_MIN_BANDS + i);
  protected readonly selectedBand = signal(-1);
  protected readonly transferText = signal('');
  protected readonly transferOpen = signal(false);
  protected readonly transferError = signal('');

  protected readonly bandCount = computed(() => (this.eq().mode === 'graphic' ? this.eq().graphicCount : this.eq().bands.length));
  protected readonly presetValue = computed(() => (this.eq().mode === 'graphic' ? this.eq().graphicPreset : this.eq().parametricPreset));

  protected setEnabled(on: boolean): void {
    this.graph.setEq({ enabled: on });
  }

  protected setMode(mode: EqMode): void {
    this.selectedBand.set(-1);
    this.graph.setEq({ mode });
  }

  protected setPreamp(raw: string): void {
    const v = parseFloat(raw);
    if (Number.isFinite(v)) this.graph.setEq({ preamp: clampPreamp(v) });
  }

  protected setCount(raw: string): void {
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n)) return;
    this.selectedBand.set(-1);
    this.graph.setEq((s) =>
      s.mode === 'graphic'
        ? { ...s, graphicCount: n, graphicGains: interpolateGains(s.graphicGains, n), graphicPreset: '' }
        : { ...s, bands: resizeBands(s.bands, n), parametricPreset: '' },
    );
  }

  protected setPreset(value: string): void {
    if (!value) return;
    if (value.startsWith('custom:')) {
      const p = this.graph.customPresets().find((x) => `custom:${x.id}` === value);
      if (p) this.graph.setEq((s) => ({ ...s, graphicCount: p.count, graphicGains: [...p.gains], graphicPreset: value }));
      return;
    }
    this.selectedBand.set(-1);
    this.graph.setEq((s) => {
      if (s.mode === 'graphic') {
        const g = presetGains(value, s.graphicCount);
        return g ? { ...s, graphicGains: g, graphicPreset: value } : s;
      }
      const bands = parametricFromPreset(value, s.bands);
      return bands ? { ...s, bands, parametricPreset: value } : s;
    });
  }

  protected reset(): void {
    this.selectedBand.set(-1);
    this.graph.setEq((s) => {
      const def = defaultEqState();
      if (s.mode === 'graphic') return { ...s, graphicGains: new Array<number>(s.graphicCount).fill(0), graphicPreset: 'flat', preamp: 0 };
      if (s.mode === 'parametric') return { ...s, bands: defaultBands(s.bands.length), parametricPreset: '', preamp: 0 };
      return { ...s, autoeqBands: def.autoeqBands, autoeqLabel: '', preamp: 0 };
    });
  }

  // Parametric band editing (graph and numeric controls share these).
  protected onBandChange(e: EqBandChange | EqBandEdit): void {
    this.graph.setEq((s) => ({ ...s, bands: updateBand(s.bands, e.index, e.band), parametricPreset: '' }));
  }

  protected onBandRemove(index: number): void {
    this.selectedBand.set(-1);
    this.graph.setEq((s) => ({ ...s, bands: removeBandAt(s.bands, index), parametricPreset: '' }));
  }

  protected onBandAdd(): void {
    this.graph.setEq((s) => ({ ...s, bands: addBandInGap(s.bands), parametricPreset: '' }));
  }

  // Text import / export (EqualizerAPO / Peace).
  protected toggleTransfer(): void {
    this.transferOpen.set(!this.transferOpen());
    if (this.transferOpen()) this.exportText();
  }

  protected exportText(): void {
    const s = this.eq();
    const bands: EqBand[] = s.mode === 'graphic' ? activeBands({ ...s, mode: 'graphic' }) : s.mode === 'parametric' ? s.bands : s.autoeqBands;
    this.transferText.set(exportEqText(s.preamp, bands));
    this.transferError.set('');
  }

  protected async copyText(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.transferText());
      this.toast.show({ message: 'Equalizer settings copied' });
    } catch {
      this.transferError.set('Copying was blocked by the browser. Select the text and copy it by hand.');
    }
  }

  protected downloadText(): void {
    const url = URL.createObjectURL(new Blob([this.transferText()], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'fiesta-equalizer.txt';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  protected async importFile(ev: Event): Promise<void> {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    this.transferText.set(await file.text());
    this.applyText();
  }

  protected applyText(): void {
    const r = importEqText(this.transferText());
    if (!r) {
      this.transferError.set('No filter lines found. Expected lines like "Filter 1: ON PK Fc 1000 Hz Gain 3.0 dB Q 1.00".');
      return;
    }
    let bands = r.bands;
    while (bands.length < EQ_MIN_BANDS) bands = addBandInGap(bands);
    this.transferError.set('');
    this.selectedBand.set(-1);
    this.graph.setEq((s) => ({ ...s, mode: 'parametric', bands, parametricPreset: '', preamp: r.preamp }));
    this.toast.show({ message: `Imported ${r.bands.length} ${r.bands.length === 1 ? 'band' : 'bands'}, now in Parametric mode` });
  }
}
