import { A11yModule } from '@angular/cdk/a11y';
import {
  Component, DestroyRef, ElementRef, computed, effect, inject, signal, untracked, viewChild,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { MusicPlayerService } from '../../services/music-player.service';
import { MusicSettingsService } from '../../services/music-settings.service';
import { MusicUiService } from '../../services/music-ui.service';
import { MusicTrack } from '../../services/music.service';
import { coverColor, NEUTRAL_BACKGROUND } from '../../utils/music-color';
import { tidalImage, time } from '../../utils/music-format';
import { musicScrollLock } from '../../utils/music-scroll-lock';
import { MusicLikeButtonComponent } from '../music-like-button/music-like-button.component';
import { MusicLyricsViewComponent } from '../music-lyrics-view/music-lyrics-view.component';
import { MusicVisualizerComponent } from '../music-visualizer/music-visualizer.component';

const DISMISS_PX = 120;
const MAX_TILT_DEG = 8;

/**
 * Fullscreen Now Playing. Visible when ui.nowPlayingOpen().
 * Large cover (round/square, optional pointer tilt, CD spin), meta links, full
 * transport, next-up preview, lyrics (side by side at lg, a toggle on phones),
 * a visualizer layer, a dynamic gradient taken from the cover, swipe-down to
 * dismiss on phones and tap-the-cover to hide the chrome.
 */
@Component({
  selector: 'app-music-now-playing',
  imports: [A11yModule, RouterLink, MusicLikeButtonComponent, MusicLyricsViewComponent, MusicVisualizerComponent],
  templateUrl: './music-now-playing.component.html',
})
export class MusicNowPlayingComponent {
  protected readonly ui = inject(MusicUiService);
  protected readonly player = inject(MusicPlayerService);
  protected readonly settings = inject(MusicSettingsService);
  protected readonly time = time;

  private readonly shell = viewChild<ElementRef<HTMLElement>>('shell');
  private readonly disc = viewChild<ElementRef<HTMLElement>>('disc');

  /** Cover-only mode: transport, meta and lyrics are removed. */
  protected readonly hideUi = signal(false);
  /** Phone tab under the transport. */
  protected readonly tab = signal<'lyrics' | 'upnext'>('upnext');
  protected readonly visualizer = signal(false);
  /** CD mode: round cover that spins while playing. Persisted at fiesta:music:nowPlayingCd. */
  protected readonly cd = this.settings.scoped('nowPlayingCd', false);

  protected readonly isLg = signal(false);
  protected readonly reducedMotion = signal(false);
  protected readonly dragY = signal(0);
  protected readonly dragging = signal(false);

  /** Accent hex taken from the cover (null while loading, off, or unreadable). */
  protected readonly accent = signal<string | null>(null);
  protected readonly background = computed(() => {
    const a = this.settings.dynamicColor() ? this.accent() : null;
    return a ? `linear-gradient(180deg, ${a} 0%, ${NEUTRAL_BACKGROUND} 90%)` : 'none';
  });
  protected readonly accentForLyrics = computed(() => (this.settings.dynamicColor() ? this.accent() : null));

  protected readonly coverLarge = computed(() => {
    const c = this.player.track()?.cover ?? '';
    return tidalImage(c, 640) || c;
  });
  protected readonly next = computed(() => this.player.upNext()[0] ?? null);
  protected readonly upcoming = computed(() => this.player.upNext().slice(0, 10));
  protected readonly badge = computed(() => {
    if (this.player.presentation() === 'PREVIEW') return 'Preview';
    const q = this.player.quality();
    return q === 'LOSSLESS' ? 'Lossless' : q === 'HI_RES_LOSSLESS' ? 'Hi-Res' : q ? 'AAC' : '';
  });
  protected readonly artists = computed(() => {
    const t = this.player.track();
    if (!t) return [];
    if (t.artists?.length) return t.artists;
    return t.artist ? [{ id: t.artistId, name: t.artist }] : [];
  });

  private release: (() => void) | null = null;
  private spin: Animation | null = null;
  private spinEl: HTMLElement | undefined;
  private colorToken = 0;

  constructor() {
    const destroyRef = inject(DestroyRef);
    if (typeof window !== 'undefined') {
      const lg = window.matchMedia('(min-width: 1024px)');
      const rm = window.matchMedia('(prefers-reduced-motion: reduce)');
      this.isLg.set(lg.matches);
      // Lyrics sit beside the cover at lg; on phones they stay behind the toggle.
      if (lg.matches && this.settings.nowPlayingLyrics()) this.tab.set('lyrics');
      this.reducedMotion.set(rm.matches);
      const onLg = () => this.isLg.set(lg.matches);
      const onRm = () => this.reducedMotion.set(rm.matches);
      lg.addEventListener('change', onLg);
      rm.addEventListener('change', onRm);
      destroyRef.onDestroy(() => { lg.removeEventListener('change', onLg); rm.removeEventListener('change', onRm); });
    }

    effect(() => {
      if (this.ui.nowPlayingOpen()) this.release ??= musicScrollLock.lock();
      else {
        this.release?.();
        this.release = null;
        untracked(() => { this.hideUi.set(false); this.dragY.set(0); });
      }
    });
    destroyRef.onDestroy(() => { this.release?.(); this.spin?.cancel(); });

    // Dynamic colour: re-read whenever the cover changes (cached per URL).
    effect(() => {
      const url = this.ui.nowPlayingOpen() && this.settings.dynamicColor() ? this.player.track()?.cover ?? '' : '';
      const token = ++this.colorToken;
      if (!url) { this.accent.set(null); return; }
      void coverColor(url).then((c) => { if (token === this.colorToken) this.accent.set(c); });
    });

    // Slide-in (skipped under reduced motion).
    effect(() => {
      const el = this.shell()?.nativeElement;
      if (!el || this.reducedMotion() || typeof el.animate !== 'function') return;
      untracked(() => { el.animate([{ transform: 'translateY(8%)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 220, easing: 'ease-out' }); });
    });

    // CD spin: only while playing. It is an explicit, opt-in toggle, so it runs even under
    // prefers-reduced-motion (macOS "Reduce motion" would otherwise make the mode look broken);
    // the incidental motion (slide-in, tilt) still honours the preference.
    effect(() => {
      const el = this.disc()?.nativeElement;
      const mode = this.cd();
      const on = mode && this.player.playing();
      untracked(() => {
        if (this.spin && this.spinEl !== el) { this.spin.cancel(); this.spin = null; }
        if (!el || typeof el.animate !== 'function') return;
        if (!mode) { this.spin?.cancel(); this.spin = null; el.dataset['spinning'] = 'false'; return; }
        if (!this.spin) { this.spin = el.animate([{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }], { duration: 12000, iterations: Infinity }); this.spinEl = el; }
        if (on) this.spin.play(); else this.spin.pause();
        el.dataset['spinning'] = String(on);
      });
    });
  }

  protected onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') { e.stopPropagation(); this.ui.closeNowPlaying(); }
  }

  protected toggleHideUi(): void { this.hideUi.update((v) => !v); }

  protected onSeek(event: Event): void { this.player.seek(+(event.target as HTMLInputElement).value); }

  protected addToPlaylist(t: MusicTrack): void { this.ui.openAddToPlaylist([t]); }

  // ── Cover tilt ───────────────────────────────────────────────────────────
  protected tiltMove(e: PointerEvent): void {
    const wrap = e.currentTarget as HTMLElement;
    if (!this.settings.coverTilt() || this.reducedMotion() || e.pointerType === 'touch') {
      if (wrap.style.transform) wrap.style.transform = '';
      return;
    }
    const r = wrap.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width - 0.5;
    const py = (e.clientY - r.top) / r.height - 0.5;
    wrap.style.transform = `perspective(800px) rotateX(${(-py * 2 * MAX_TILT_DEG).toFixed(2)}deg) rotateY(${(px * 2 * MAX_TILT_DEG).toFixed(2)}deg)`;
  }

  protected tiltLeave(e: PointerEvent): void {
    (e.currentTarget as HTMLElement).style.transform = '';
  }

  // ── Swipe down to dismiss (phones) ───────────────────────────────────────
  protected startDrag(e: PointerEvent): void {
    const handle = e.currentTarget as HTMLElement;
    handle.setPointerCapture?.(e.pointerId);
    const startY = e.clientY;
    const t0 = performance.now();
    this.dragging.set(true);
    const move = (ev: PointerEvent) => this.dragY.set(Math.max(0, ev.clientY - startY));
    const up = (ev: PointerEvent) => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      this.dragging.set(false);
      const dy = Math.max(0, ev.clientY - startY);
      const velocity = dy / Math.max(1, performance.now() - t0);
      if (ev.type !== 'pointercancel' && (dy > DISMISS_PX || (velocity > 0.6 && dy > 40))) this.ui.closeNowPlaying();
      else this.dragY.set(0);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  }

  protected handleKey(e: KeyboardEvent): void {
    if (e.key === 'ArrowDown') { e.preventDefault(); this.ui.closeNowPlaying(); }
  }
}
