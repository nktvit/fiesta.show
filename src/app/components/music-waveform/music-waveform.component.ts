import { Component, computed, inject, input } from '@angular/core';
import { MusicWaveformService } from '../../services/music-waveform.service';
import { peaksToPath } from '../../utils/music-waveform-peaks';

/**
 * SVG peak strip behind the seek bar; fills its parent, pointer-events-none,
 * renders nothing without peaks. Owned by package P5.
 */
@Component({
  selector: 'app-music-waveform',
  templateUrl: './music-waveform.component.html',
  host: { class: 'pointer-events-none absolute inset-0 block' },
})
export class MusicWaveformComponent {
  private readonly waveform = inject(MusicWaveformService);

  readonly trackId = input<number | null>(null);
  /** 0..1 played. */
  readonly progress = input(0);

  private readonly peaks = computed(() => {
    const id = this.trackId();
    return id === null ? null : this.waveform.peaks(id)();
  });

  /** One rect per bar, mirrored around the middle (viewBox 0 0 1000 100). */
  protected readonly path = computed(() => peaksToPath(this.peaks()));

  /** Reveals the played fraction of the highlighted copy. */
  protected readonly clip = computed(() => {
    const p = Math.min(1, Math.max(0, Number.isFinite(this.progress()) ? this.progress() : 0));
    return `inset(0 ${((1 - p) * 100).toFixed(2)}% 0 0)`;
  });
}
