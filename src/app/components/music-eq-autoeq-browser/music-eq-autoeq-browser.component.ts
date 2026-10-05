// Ported from Monochrome (Apache-2.0), js/settings.js L3356-4075 (AutoEQ UI, profiles, custom import) - adapted for Fiesta.
import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { MusicAudioGraphService } from '../../services/music-audio-graph.service';
import { AutoEqProfile, MusicAutoEqService } from '../../services/music-autoeq.service';
import { MusicToastService } from '../../services/music-toast.service';
import { AutoEqEntry, AutoEqTarget, FALLBACK_INDEX, HeadphoneType, searchHeadphones } from '../../utils/music-autoeq-data';
import { FrPoint, interpolateFr, normalizationOffset, runAutoEq } from '../../utils/music-autoeq-engine';
import { biquadResponseDb, clippingSafePreamp } from '../../utils/music-dsp-biquad';
import { addBandInGap, EqBand, removeBandAt, updateBand } from '../../utils/music-eq-core';
import { EqBandEdit, MusicEqBandControlsComponent } from '../music-eq-band-controls/music-eq-band-controls.component';
import { EqBandChange, EqGraphOverlay, MusicEqParametricGraphComponent } from '../music-eq-parametric-graph/music-eq-parametric-graph.component';

/**
 * AutoEQ: pick a headphone model (AutoEq index, cached in IndexedDB `fiesta-music-autoeq`) or import
 * your own measurement CSV, choose a target curve, compute a parametric correction, apply it, and
 * save it as a profile.
 */
@Component({
  selector: 'app-music-eq-autoeq-browser',
  imports: [MusicEqParametricGraphComponent, MusicEqBandControlsComponent],
  templateUrl: './music-eq-autoeq-browser.component.html',
  host: { class: 'block' },
})
export class MusicEqAutoEqBrowserComponent {
  protected readonly graph = inject(MusicAudioGraphService);
  protected readonly autoeq = inject(MusicAutoEqService);
  private toast = inject(MusicToastService);

  protected readonly query = signal('');
  protected readonly typeFilter = signal<'all' | HeadphoneType>('all');
  protected readonly targets = signal<AutoEqTarget[]>([]);
  protected readonly targetId = signal('harman_oe_2018');
  protected readonly bandCount = signal(10);
  protected readonly maxQ = signal(5);
  protected readonly minFreq = signal(20);
  protected readonly maxFreq = signal(16000);
  protected readonly selectedEntry = signal<AutoEqEntry | null>(null);
  protected readonly measurement = signal<FrPoint[] | null>(null);
  protected readonly measurementName = signal('');
  protected readonly customTarget = signal<{ name: string; points: FrPoint[] } | null>(null);
  protected readonly loading = signal(false);
  protected readonly message = signal('');
  protected readonly profileName = signal('');
  protected readonly selectedBand = signal(-1);

  protected readonly state = this.graph.eq;
  protected readonly applied = computed(() => this.state().autoeqBands);

  protected readonly results = computed<AutoEqEntry[]>(() => {
    const q = this.query().trim();
    if (!q && this.typeFilter() === 'all') return [...FALLBACK_INDEX].slice(0, 5);
    return searchHeadphones(q, this.autoeq.entries(), this.typeFilter(), 40);
  });

  protected readonly targetCurve = computed<FrPoint[] | null>(() => {
    const custom = this.customTarget();
    if (custom) return custom.points;
    return this.targets().find((t) => t.id === this.targetId())?.points ?? null;
  });

  /** The correction computed from the loaded measurement (not yet applied). */
  protected readonly preview = computed<EqBand[] | null>(() => {
    const m = this.measurement();
    const t = this.targetCurve();
    if (!m || !t) return null;
    return runAutoEq(m, t, { bandCount: this.bandCount(), maxQ: this.maxQ(), minFreq: this.minFreq(), maxFreq: this.maxFreq() });
  });
  protected readonly previewPreamp = computed(() => clippingSafePreamp(this.preview() ?? []));

  protected readonly graphBands = computed<readonly EqBand[]>(() => this.preview() ?? this.applied());

  protected readonly overlays = computed<EqGraphOverlay[]>(() => {
    const m = this.measurement();
    const t = this.targetCurve();
    const bands = this.preview();
    if (!m || !t || !bands) return [];
    const off = normalizationOffset(m, t);
    const before = m.map((p) => ({ freq: p.freq, gain: p.gain + off - interpolateFr(p.freq, t) }));
    const after = before.map((p) => ({ freq: p.freq, gain: p.gain + bands.reduce((s, b) => s + biquadResponseDb(p.freq, b), 0) }));
    return [
      { label: 'Measurement vs target', points: before, color: 'rgba(255,255,255,0.45)', dashed: true },
      { label: 'After EQ', points: after, color: 'rgba(255,255,255,0.9)' },
    ];
  });

  constructor() {
    void this.autoeq.loadIndex();
    this.autoeq.targets().then(
      (list) => this.targets.set(list),
      () => this.message.set('Could not load the target curves. Reload the page and try again.'),
    );
    // Keep the profile name in step with what is being worked on.
    effect(() => {
      const name = this.measurementName();
      untracked(() => {
        if (name) this.profileName.set(name);
      });
    });
  }

  protected async pick(entry: AutoEqEntry): Promise<void> {
    this.selectedEntry.set(entry);
    this.message.set('');
    this.loading.set(true);
    this.measurement.set(null);
    if (!this.customTarget()) this.targetId.set(entry.type === 'in-ear' ? 'harman_ie_2019' : 'harman_oe_2018');
    try {
      const points = await this.autoeq.measurement(entry);
      if (this.selectedEntry() !== entry) return;
      this.measurement.set(points);
      this.measurementName.set(entry.name);
    } catch {
      if (this.selectedEntry() === entry) this.message.set(`No measurement file is available for ${entry.name}. Try another model or import a CSV.`);
    } finally {
      if (this.selectedEntry() === entry) this.loading.set(false);
    }
  }

  protected async importFile(kind: 'measurement' | 'target', ev: Event): Promise<void> {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    this.message.set('');
    try {
      const points = this.autoeq.parseCustomCurve(await file.text());
      const name = file.name.replace(/\.[^.]+$/, '');
      if (kind === 'measurement') {
        this.selectedEntry.set(null);
        this.measurement.set(points);
        this.measurementName.set(name);
      } else {
        this.customTarget.set({ name, points });
      }
    } catch (e) {
      this.message.set(e instanceof Error ? e.message : 'Could not read that file.');
    }
  }

  protected setNumber(sig: { set(v: number): void }, raw: string, min: number, max: number): void {
    const v = parseFloat(raw);
    if (Number.isFinite(v)) sig.set(Math.min(max, Math.max(min, v)));
  }

  protected clearPreview(): void {
    this.measurement.set(null);
    this.measurementName.set('');
    this.selectedEntry.set(null);
  }

  protected useBuiltInTarget(): void {
    this.customTarget.set(null);
  }

  protected apply(): void {
    const bands = this.preview();
    if (!bands || bands.length === 0) {
      this.message.set('This measurement already matches the target closely enough: no bands were needed.');
      return;
    }
    const label = this.measurementName();
    const preamp = this.previewPreamp();
    this.graph.setEq((s) => ({ ...s, enabled: true, mode: 'autoeq', autoeqBands: bands, autoeqLabel: label, preamp }));
    this.toast.show({ message: `AutoEQ applied: ${bands.length} bands, preamp ${preamp.toFixed(1)} dB` });
    this.clearPreview();
  }

  protected saveProfile(): void {
    const bands = this.preview() ?? this.applied();
    if (bands.length === 0) {
      this.message.set('Compute or apply a correction first, then save it.');
      return;
    }
    const preamp = this.preview() ? this.previewPreamp() : this.state().preamp;
    const target = this.customTarget()?.name ?? this.targets().find((t) => t.id === this.targetId())?.label ?? '';
    const p = this.autoeq.saveProfile({
      name: this.profileName() || this.measurementName() || this.state().autoeqLabel || 'AutoEQ profile',
      source: this.measurementName() || this.state().autoeqLabel,
      target,
      preamp,
      bands: [...bands],
    });
    this.toast.show({ message: `Saved profile "${p.name}"` });
  }

  protected applyProfile(p: AutoEqProfile): void {
    this.graph.setEq((s) => ({ ...s, enabled: true, mode: 'autoeq', autoeqBands: p.bands, autoeqLabel: p.name, preamp: p.preamp }));
    this.clearPreview();
    this.toast.show({ message: `Applied profile "${p.name}"` });
  }

  protected deleteProfile(p: AutoEqProfile): void {
    this.autoeq.deleteProfile(p.id);
    this.toast.show({ message: `Deleted profile "${p.name}"` });
  }

  protected reloadIndex(): void {
    void this.autoeq.loadIndex(true);
  }

  // Edits to the applied bands (when there is no preview).
  protected onGraphChange(e: EqBandChange | EqBandEdit): void {
    this.graph.setEq((s) => ({ ...s, autoeqBands: updateBand(s.autoeqBands, e.index, e.band) }));
  }

  protected onRemove(index: number): void {
    this.graph.setEq((s) => ({ ...s, autoeqBands: removeBandAt(s.autoeqBands, index) }));
    this.selectedBand.set(-1);
  }

  protected onAdd(): void {
    this.graph.setEq((s) => ({ ...s, autoeqBands: addBandInGap(s.autoeqBands) }));
  }

  protected formName(e: AutoEqEntry): string {
    return e.path.split('/')[1] ?? '';
  }
}
