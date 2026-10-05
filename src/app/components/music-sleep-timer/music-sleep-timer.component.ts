import { Component, inject, signal } from '@angular/core';
import { MusicPlayerService } from '../../services/music-player.service';
import { MusicToastService } from '../../services/music-toast.service';
import { MusicUiService } from '../../services/music-ui.service';
import { MusicDialogComponent } from '../music-dialog/music-dialog.component';

export const MUSIC_SLEEP_PRESETS = [5, 10, 15, 30, 45, 60, 90, 120] as const;

/** Clamp a custom minutes entry to 1..720, or null when it isn't a number. */
export function parseSleepMinutes(raw: string | number): number | null {
  const n = typeof raw === 'number' ? raw : parseFloat(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(720, Math.max(1, Math.round(n)));
}

/** Sleep-timer dialog (open state lives in MusicUiService.sleepTimerOpen). Mounted by the player bar, outside its blurred section. */
@Component({
  selector: 'app-music-sleep-timer',
  imports: [MusicDialogComponent],
  templateUrl: './music-sleep-timer.component.html',
})
export class MusicSleepTimerComponent {
  protected readonly player = inject(MusicPlayerService);
  protected readonly ui = inject(MusicUiService);
  private readonly toast = inject(MusicToastService);
  protected readonly presets = MUSIC_SLEEP_PRESETS;
  protected readonly invalid = signal(false);

  protected armed(): boolean {
    const s = this.player.sleep();
    return s.endsAt !== null || s.endOfTrack;
  }

  protected onOpenChange(open: boolean): void {
    if (!open) this.ui.closeSleepTimer();
  }

  protected choose(minutes: number | 'end-of-track'): void {
    this.player.setSleepTimer(minutes);
    this.toast.show({ message: minutes === 'end-of-track' ? 'Sleep timer: end of track' : `Sleep timer: ${minutes} min` });
    this.ui.closeSleepTimer();
  }

  protected custom(input: HTMLInputElement): void {
    const m = parseSleepMinutes(input.value);
    this.invalid.set(m === null);
    if (m !== null) this.choose(m);
  }

  protected cancel(): void {
    this.player.setSleepTimer(null);
    this.toast.show({ message: 'Sleep timer cancelled' });
    this.ui.closeSleepTimer();
  }
}
