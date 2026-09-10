import {
  AfterViewInit,
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  ElementRef,
  HostListener,
  inject,
  input,
  NgZone,
  OnChanges,
  OnDestroy,
  output,
  SimpleChanges,
  ViewChild,
} from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { Subscription } from 'rxjs';
import { IMovie } from '../../interfaces/movie.interface';
import { MovieSummary, MovieSummaryService } from '../../services/movie-summary.service';
import { ExpandableTextComponent } from '../expandable-text/expandable-text.component';

/** Milliseconds for the open/close height transition. */
const TRANSITION_MS = 420;
/**
 * Decelerating curve. The stock ease-in-out reads as mechanical on a box this
 * large: it starts slowly, so the row appears to hesitate before opening.
 */
const EASING = 'cubic-bezier(.22,.61,.36,1)';
/** How long to wait for muted autoplay before falling back to the backdrop. */
const AUTOPLAY_GRACE_MS = 1500;
/**
 * The backdrop is held for a few seconds after playback starts. YouTube shows
 * the video title, a bottom control strip and a centre play/pause glyph over
 * the opening seconds of any embed, and no player parameter suppresses them —
 * `modestbranding` has been a no-op since 2023. The title and bottom strip are
 * cropped away in CSS; the centre glyph can't be, so the backdrop simply stays
 * up until it has gone. Holding a still before the trailer fades in is also
 * what Netflix does, so the delay reads as intentional rather than slow.
 */
const CHROME_SETTLE_MS = 4500;

/**
 * The in-grid detail panel: backdrop cross-fading into an autoplaying,
 * chrome-less trailer, plus the essentials from the movie page.
 *
 * Everything to do with the YouTube player runs outside the Angular zone. The
 * player posts progress messages several times a second while playing, and
 * each one would otherwise trigger an application-wide change detection pass
 * for as long as the panel is open.
 */
@Component({
  selector: 'app-movie-detail-panel',
  imports: [RouterLink, DecimalPipe, ExpandableTextComponent],
  templateUrl: './movie-detail-panel.component.html',
  styleUrl: './movie-detail-panel.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MovieDetailPanelComponent implements OnChanges, AfterViewInit, OnDestroy {
  readonly movie = input.required<IMovie>();
  readonly closed = output<void>();

  @ViewChild('content') private contentRef?: ElementRef<HTMLDivElement>;
  @ViewChild('media') private mediaRef?: ElementRef<HTMLDivElement>;
  @ViewChild('closeButton') private closeButtonRef?: ElementRef<HTMLButtonElement>;

  summary: MovieSummary | null = null;
  overviewParagraphs: string[] = [];
  loadingSummary = true;
  /** True once the trailer is actually playing, which is when it fades in. */
  showVideo = false;
  muted = true;
  autoplayBlocked = false;

  private player: any = null;
  private currentTrailerKey: string | null = null;
  private summarySub?: Subscription;
  private settleTimer?: ReturnType<typeof setTimeout>;
  private watchdogTimer?: ReturnType<typeof setTimeout>;
  private revealTimer?: ReturnType<typeof setTimeout>;
  private contentObserver?: ResizeObserver;
  private destroyed = false;

  private readonly host = (inject(ElementRef) as ElementRef<HTMLElement>).nativeElement;
  private readonly cdr = inject(ChangeDetectorRef);
  private readonly zone = inject(NgZone);
  private readonly summaries = inject(MovieSummaryService);

  /** The YouTube IFrame API script is fetched once per app, on first use. */
  private static apiReady?: Promise<void>;

  private get prefersReducedMotion(): boolean {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  ngOnChanges(changes: SimpleChanges) {
    if (!changes['movie']) return;
    // The panel is reused (not recreated) when another card in the same row is
    // clicked, so a new movie has to fully reset it — including tearing the
    // player down, or the previous trailer keeps playing.
    this.teardownPlayer();
    this.summarySub?.unsubscribe();
    this.summary = null;
    this.overviewParagraphs = [];
    this.showVideo = false;
    this.muted = true;
    this.autoplayBlocked = false;
    this.loadingSummary = true;
    this.load();
  }

  ngAfterViewInit() {
    this.animateOpen();
    this.closeButtonRef?.nativeElement.focus({ preventScroll: true });

    // Retarget the open animation if late-arriving content changes the height
    // mid-flight. The layout reserves space for the media box and the text, so
    // this is a safety net rather than the common path.
    const content = this.contentRef?.nativeElement;
    if (content) {
      this.zone.runOutsideAngular(() => {
        this.contentObserver = new ResizeObserver(() => {
          if (this.host.style.height === 'auto' || !this.host.style.transition) return;
          this.host.style.height = `${content.scrollHeight}px`;
          this.settle(TRANSITION_MS + 20);
        });
        this.contentObserver.observe(content);
      });
    }
  }

  ngOnDestroy() {
    this.destroyed = true;
    this.teardownPlayer();
    this.summarySub?.unsubscribe();
    this.contentObserver?.disconnect();
    clearTimeout(this.settleTimer);
    clearTimeout(this.watchdogTimer);
    clearTimeout(this.revealTimer);
  }

  @HostListener('document:keydown.escape')
  onEscape() {
    this.closed.emit();
  }

  close() {
    this.closed.emit();
  }

  // --- data ---------------------------------------------------------------

  private load() {
    this.summarySub = this.summaries.summaryFor(this.movie()).subscribe(summary => {
      if (this.destroyed) return;
      this.summary = summary;
      this.overviewParagraphs = summary.overview
        ? summary.overview.split(/\n{2,}/).map(p => p.trim()).filter(Boolean)
        : [];
      this.loadingSummary = false;
      this.cdr.markForCheck();
      if (summary.trailerKey) this.mountPlayer(summary.trailerKey);
    });
  }

  get year(): string {
    const date = this.summary?.releaseDate;
    if (!date) return '';
    return String(date).slice(0, 4);
  }

  get movieLink(): (string | number)[] {
    const movie = this.movie();
    return ['/movie', movie.imdbID || movie.tmdbId || ''];
  }

  get movieQueryParams(): Record<string, string> {
    return this.movie().mediaType === 'tv' ? { type: 'tv' } : {};
  }

  // --- trailer ------------------------------------------------------------

  private loadApi(): Promise<void> {
    return (MovieDetailPanelComponent.apiReady ??= new Promise<void>(resolve => {
      const win = window as any;
      if (win.YT?.Player) {
        resolve();
        return;
      }
      const previous = win.onYouTubeIframeAPIReady;
      win.onYouTubeIframeAPIReady = () => {
        previous?.();
        resolve();
      };
      const script = document.createElement('script');
      script.src = 'https://www.youtube.com/iframe_api';
      document.head.appendChild(script);
    }));
  }

  private async mountPlayer(key: string) {
    this.currentTrailerKey = key;
    await this.loadApi();
    const media = this.mediaRef?.nativeElement;
    // The panel may have been closed, or switched to another movie, while the
    // API script was in flight.
    if (this.destroyed || !media || this.currentTrailerKey !== key) return;

    const wrapper = document.createElement('div');
    wrapper.className = 'panel-video';
    const mount = document.createElement('div');
    wrapper.appendChild(mount);
    media.appendChild(wrapper);

    this.zone.runOutsideAngular(() => {
      this.player = new (window as any).YT.Player(mount, {
        videoId: key,
        // nocookie and the JS API work together; `host` is how you get both.
        host: 'https://www.youtube-nocookie.com',
        playerVars: {
          autoplay: 1,
          mute: 1,
          controls: 0,
          rel: 0,
          playsinline: 1,
          iv_load_policy: 3,
          disablekb: 1,
          fs: 0,
        },
        events: {
          onReady: (event: any) => {
            event.target.mute();
            event.target.playVideo();
            // iOS in Low Power Mode blocks autoplay even when muted; if
            // nothing is playing shortly we stay on the backdrop and offer a
            // manual play instead of showing a black rectangle.
            this.watchdogTimer = setTimeout(() => {
              if (this.player?.getPlayerState?.() !== 1) {
                this.zone.run(() => {
                  this.autoplayBlocked = true;
                  this.cdr.markForCheck();
                });
              }
            }, AUTOPLAY_GRACE_MS);
          },
          onStateChange: (event: any) => {
            if (event.data === 1) {
              clearTimeout(this.watchdogTimer);
              this.zone.run(() => {
                this.autoplayBlocked = false;
                this.cdr.markForCheck();
              });
              clearTimeout(this.revealTimer);
              this.revealTimer = setTimeout(() => {
                this.zone.run(() => {
                  this.showVideo = true;
                  this.cdr.markForCheck();
                });
              }, CHROME_SETTLE_MS);
            } else if (event.data === 0) {
              // Cross-fade back to the backdrop instead of looping, which
              // reloads the player and flashes.
              this.zone.run(() => {
                this.showVideo = false;
                this.cdr.markForCheck();
              });
            }
          },
          onError: () => {
            this.zone.run(() => {
              this.showVideo = false;
              this.cdr.markForCheck();
            });
          },
        },
      });
    });
  }

  private teardownPlayer() {
    clearTimeout(this.watchdogTimer);
    clearTimeout(this.revealTimer);
    this.currentTrailerKey = null;
    // destroy(), not just detaching the node: a detached-but-live iframe keeps
    // playing audio on iOS.
    try {
      this.player?.destroy?.();
    } catch {
      /* player already gone */
    }
    this.player = null;
    const media = this.mediaRef?.nativeElement;
    media?.querySelectorAll('.panel-video').forEach(node => node.remove());
  }

  toggleMute() {
    if (!this.player) return;
    this.muted = !this.muted;
    if (this.muted) {
      this.player.mute?.();
    } else {
      this.player.setVolume?.(50);
      this.player.unMute?.();
    }
  }

  startPlayback() {
    this.autoplayBlocked = false;
    this.player?.playVideo?.();
  }

  // --- open/close animation ----------------------------------------------

  private animateOpen() {
    const content = this.contentRef?.nativeElement;
    if (!content) return;

    if (this.prefersReducedMotion) {
      this.host.style.height = 'auto';
      this.host.style.opacity = '1';
      return;
    }

    this.zone.runOutsideAngular(() => {
      this.host.style.overflow = 'hidden';
      this.host.style.height = '0px';
      this.host.style.opacity = '0';
      // Force a style/layout flush before the change. WebKit 15 will otherwise
      // coalesce both writes into one frame and snap open instead of animating.
      void this.host.offsetHeight;
      requestAnimationFrame(() => {
        this.host.style.transition =
          `height ${TRANSITION_MS}ms ${EASING}, opacity 260ms ease-out`;
        this.host.style.height = `${content.scrollHeight}px`;
        this.host.style.opacity = '1';
        this.settle(TRANSITION_MS + 20);
      });
    });
  }

  /** Called by the host collection just before it removes the panel. */
  animateClose() {
    const content = this.contentRef?.nativeElement;
    if (!content || this.prefersReducedMotion) return;

    clearTimeout(this.settleTimer);
    this.zone.runOutsideAngular(() => {
      this.host.style.transition = '';
      this.host.style.overflow = 'hidden';
      this.host.style.height = `${content.scrollHeight}px`;
      void this.host.offsetHeight;
      requestAnimationFrame(() => {
        this.host.style.transition =
          `height ${TRANSITION_MS}ms ${EASING}, opacity 200ms ease-in`;
        this.host.style.height = '0px';
        this.host.style.opacity = '0';
      });
    });
  }

  /**
   * transitionend is unreliable (interrupted transitions, 0->0 no-ops), so a
   * timer settles the element back to `height: auto` — and only then to
   * `overflow: visible`, or focus rings and shadows get clipped.
   */
  private settle(ms: number) {
    clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => {
      if (this.destroyed) return;
      this.host.style.transition = '';
      this.host.style.height = 'auto';
      this.host.style.overflow = 'visible';
    }, ms);
  }
}
