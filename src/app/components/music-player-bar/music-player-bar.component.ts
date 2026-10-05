import { Component, DestroyRef, computed, effect, inject, untracked } from '@angular/core';
import { Router } from '@angular/router';
import { MusicPlayerService } from '../../services/music-player.service';
import { MusicSettingsService } from '../../services/music-settings.service';
import { MusicUiService } from '../../services/music-ui.service';
import { MusicTrack } from '../../services/music.service';
import { time } from '../../utils/music-format';
import { hapticTap } from '../../utils/music-haptics';
import { MusicLikeButtonComponent } from '../music-like-button/music-like-button.component';
import { MusicSeekBarComponent } from '../music-seek-bar/music-seek-bar.component';
import { MusicSleepTimerComponent } from '../music-sleep-timer/music-sleep-timer.component';
import { MusicSpeedPopoverComponent } from '../music-speed-popover/music-speed-popover.component';
import { MusicVolumeControlComponent } from '../music-volume-control/music-volume-control.component';

const QUALITY_LABEL: Record<string, string> = { LOW: 'AAC', HIGH: 'AAC', LOSSLESS: 'Lossless', HI_RES_LOSSLESS: 'Hi-Res' };

/** Persistent player. Sits above the mobile tab bar, flush to the bottom on desktop. */
@Component({
  selector: 'app-music-player-bar',
  imports: [
    MusicLikeButtonComponent, MusicSeekBarComponent, MusicSleepTimerComponent,
    MusicSpeedPopoverComponent, MusicVolumeControlComponent,
  ],
  templateUrl: './music-player-bar.component.html',
})
export class MusicPlayerBarComponent {
  protected readonly player = inject(MusicPlayerService);
  protected readonly settings = inject(MusicSettingsService);
  protected readonly ui = inject(MusicUiService);
  private readonly router = inject(Router);
  protected readonly time = time;

  protected readonly badge = computed(() => {
    if (this.player.presentation() === 'PREVIEW') return 'Preview';
    return QUALITY_LABEL[this.player.quality()] ?? '';
  });

  protected readonly badgeTitle = computed(() => {
    const b = this.badge();
    if (b === 'Preview') return 'Sign in with TIDAL to hear full tracks';
    const from = this.player.qualityFallback();
    if (from) return `This browser can't play ${QUALITY_LABEL[from] ?? from}, so it is playing ${b} instead.`;
    return b === 'Hi-Res' ? 'Hi-Res Lossless' : b === 'Lossless' ? 'Lossless (CD quality)' : b ? 'AAC' : '';
  });

  protected readonly message = computed(() => {
    switch (this.player.error()) {
      case 'session_expired': return 'TIDAL session expired';
      case 'unsupported': return "This browser can't play this audio format";
      case 'network': return 'Network problem - check your connection';
      case 'unavailable': return "Couldn't play this track";
      default: return null;
    }
  });

  protected readonly sleepChip = computed(() => {
    const s = this.player.sleep();
    if (s.endOfTrack) return 'End of track';
    const left = this.player.sleepRemaining();
    return s.endsAt !== null && left !== null ? time(left) : null;
  });

  protected readonly progress = computed(() => (this.player.duration() ? (this.player.position() / this.player.duration()) * 100 : 0));

  private baseTitle = '';
  private appliedTitle: string | null = null;

  constructor() {
    this.syncDocumentTitle();
  }

  protected tap(action: () => void): void {
    hapticTap(this.settings.haptics());
    action();
  }

  protected albumLink(t: MusicTrack): string {
    return t.albumId ? `/music/album/${t.albumId}` : '/music';
  }

  /** Cover/title tap: Now Playing or the album, per settings.coverClickAction. Modified clicks keep the browser's link behaviour. */
  protected onCoverClick(e: MouseEvent, t: MusicTrack): void {
    if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    if (this.settings.coverClickAction() === 'nowPlaying') this.ui.openNowPlaying();
    else void this.router.navigateByUrl(this.albumLink(t));
  }

  protected seek(seconds: number): void {
    this.player.seek(seconds);
  }

  /** UI07: "▶ Title · Artist" tab-title prefix while playing; the page's own title is restored on pause/stop. */
  private syncDocumentTitle(): void {
    if (typeof document === 'undefined') return;
    let current: MusicTrack | null = null;
    const apply = (): void => {
      if (this.appliedTitle === null || document.title !== this.appliedTitle) this.baseTitle = document.title;
      if (current) {
        this.appliedTitle = `▶ ${current.title} · ${current.artist}`;
        if (document.title !== this.appliedTitle) document.title = this.appliedTitle;
      } else if (this.appliedTitle !== null) {
        this.appliedTitle = null;
        document.title = this.baseTitle;
      }
    };
    effect(() => {
      const t = this.player.track();
      const playing = this.player.playing();
      current = playing && t ? t : null;
      untracked(apply);
    });
    // Pages set their own title (also after NavigationEnd): take it as the new base and keep the prefix.
    const el = document.querySelector('title');
    if (el && typeof MutationObserver !== 'undefined') {
      const mo = new MutationObserver(() => {
        if (this.appliedTitle !== null && document.title !== this.appliedTitle) apply();
      });
      mo.observe(el, { childList: true, characterData: true, subtree: true });
      inject(DestroyRef).onDestroy(() => mo.disconnect());
    }
  }
}
