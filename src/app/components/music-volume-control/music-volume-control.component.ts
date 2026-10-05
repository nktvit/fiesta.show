import { Component, computed, inject } from '@angular/core';
import { MusicPlayerService } from '../../services/music-player.service';

/**
 * Mute button plus volume slider. lg+: slider inline. md: it floats in a
 * popover that opens on hover or keyboard focus. Hidden below md (phones use
 * the OS volume). Mouse wheel changes volume by 5 %.
 */
@Component({
  selector: 'app-music-volume-control',
  templateUrl: './music-volume-control.component.html',
  host: { class: 'hidden md:block' },
})
export class MusicVolumeControlComponent {
  protected readonly player = inject(MusicPlayerService);
  protected readonly percent = computed(() => (this.player.muted() ? 0 : Math.round(this.player.volume() * 100)));
  protected readonly level = computed(() => {
    const p = this.percent();
    return p === 0 ? 'off' : p < 34 ? 'low' : p < 67 ? 'mid' : 'high';
  });

  protected step(deltaPercent: number): void {
    const base = this.player.muted() ? 0 : this.player.volume() * 100;
    this.player.setVolume(Math.min(100, Math.max(0, Math.round(base + deltaPercent))) / 100);
  }

  protected onWheel(e: WheelEvent): void {
    if (!e.deltaY) return;
    e.preventDefault();
    this.step(e.deltaY < 0 ? 5 : -5);
  }

  protected onKeydown(e: KeyboardEvent): void {
    const d = e.key === 'ArrowUp' || e.key === 'ArrowRight' ? 5 : e.key === 'ArrowDown' || e.key === 'ArrowLeft' ? -5 : 0;
    if (!d) return;
    e.preventDefault();
    this.step(d);
  }

  protected onInput(e: Event): void {
    this.player.setVolume(+(e.target as HTMLInputElement).value / 100);
  }
}
