import { Component, input, model, output } from '@angular/core';
import { clampFreq, clampGain, clampQ, EqBand, EqChannel, EqFilterType } from '../../utils/music-eq-core';

export interface EqBandEdit {
  index: number;
  band: EqBand;
}

/** Numeric per-band controls: on/off, filter type, frequency, gain, Q, channel (stereo / mid / side), remove. */
@Component({
  selector: 'app-music-eq-band-controls',
  templateUrl: './music-eq-band-controls.component.html',
  host: { class: 'block' },
})
export class MusicEqBandControlsComponent {
  readonly bands = input.required<readonly EqBand[]>();
  readonly selected = model(-1);
  readonly allowRemove = input(true);
  readonly allowAdd = input(true);
  readonly maxBands = input(32);
  readonly bandChange = output<EqBandEdit>();
  readonly bandRemove = output<number>();
  readonly bandAdd = output<void>();

  protected readonly types: { id: EqFilterType; label: string }[] = [
    { id: 'peaking', label: 'Peak' },
    { id: 'lowshelf', label: 'Low shelf' },
    { id: 'highshelf', label: 'High shelf' },
  ];
  protected readonly channels: { id: EqChannel; label: string }[] = [
    { id: 'stereo', label: 'Stereo' },
    { id: 'mid', label: 'Mid' },
    { id: 'side', label: 'Side' },
  ];

  protected patch(index: number, change: Partial<EqBand>): void {
    const band = this.bands()[index];
    if (band) this.bandChange.emit({ index, band: { ...band, ...change } });
  }

  protected setNumber(index: number, field: 'freq' | 'gain' | 'q', raw: string, el: HTMLInputElement): void {
    const v = parseFloat(raw);
    const band = this.bands()[index];
    if (!band) return;
    if (!Number.isFinite(v)) {
      el.value = String(band[field]);
      return;
    }
    const value =
      field === 'freq' ? Math.round(clampFreq(v)) : field === 'gain' ? Math.round(clampGain(v) * 10) / 10 : Math.round(clampQ(v) * 100) / 100;
    el.value = String(value);
    this.patch(index, { [field]: value });
  }

  protected setType(index: number, raw: string): void {
    this.patch(index, { type: raw as EqFilterType });
  }

  protected setChannel(index: number, raw: string): void {
    this.patch(index, { channel: raw as EqChannel });
  }
}
