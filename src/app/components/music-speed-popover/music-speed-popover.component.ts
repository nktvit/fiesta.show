import { Component, ElementRef, HostListener, inject, signal } from '@angular/core';
import { MusicPlayerService } from '../../services/music-player.service';

export const MUSIC_SPEED_PRESETS = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;

/** Playback speed button with a presets popover and a 'Keep pitch' switch. */
@Component({
  selector: 'app-music-speed-popover',
  templateUrl: './music-speed-popover.component.html',
  host: { class: 'relative hidden md:block' },
})
export class MusicSpeedPopoverComponent {
  protected readonly player = inject(MusicPlayerService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  protected readonly open = signal(false);
  protected readonly presets = MUSIC_SPEED_PRESETS;

  protected label(r: number): string {
    return `${+r.toFixed(2)}x`;
  }

  protected toggle(): void {
    this.open.update((v) => !v);
  }

  protected choose(r: number): void {
    this.player.setPlaybackRate(r);
  }

  @HostListener('document:pointerdown', ['$event'])
  protected onOutside(e: Event): void {
    if (this.open() && !this.host.nativeElement.contains(e.target as Node)) this.open.set(false);
  }

  protected onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape' && this.open()) {
      e.stopPropagation();
      this.open.set(false);
      this.host.nativeElement.querySelector<HTMLElement>('[data-speed-trigger]')?.focus();
    }
  }
}
