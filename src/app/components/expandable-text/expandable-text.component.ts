import {
  AfterViewInit,
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  ElementRef,
  inject,
  input,
  NgZone,
  OnDestroy,
  ViewChild,
} from '@angular/core';

/**
 * Collapsible prose (person biographies, movie plots) that slides open and
 * closed instead of snapping.
 *
 * The collapsed state is a measured pixel height rather than `line-clamp`,
 * because a clamp can't be transitioned — swapping the class is what made the
 * old person-page/movie-page toggles pop. Heights come from the DOM
 * (line-height x collapsedLines) rather than a character-count guess: font
 * size, viewport width and paragraph breaks all change how much text N lines
 * actually holds.
 */
@Component({
  selector: 'app-expandable-text',
  templateUrl: './expandable-text.component.html',
  styleUrl: './expandable-text.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ExpandableTextComponent implements AfterViewInit, OnDestroy {
  /** Already split on blank lines by the caller, and referentially stable. */
  readonly paragraphs = input.required<string[]>();
  readonly collapsedLines = input<number>(4);
  readonly moreLabel = input<string>('Read More');
  readonly lessLabel = input<string>('Show Less');
  /**
   * Page background the collapsed fade blends into. The fade is a real
   * gradient overlay rather than `mask-image` so it can be transitioned out on
   * expand (mask-image can't be) and so it behaves on Safari 15.
   */
  readonly fadeColor = input<string>('#0a0a0a');

  @ViewChild('content') private contentRef?: ElementRef<HTMLDivElement>;

  expanded = false;
  /** Only true when the text actually overflows the collapsed height. */
  canToggle = false;

  private collapsedHeight = 0;
  private resizeObserver?: ResizeObserver;
  private settleTimer?: ReturnType<typeof setTimeout>;

  private readonly cdr = inject(ChangeDetectorRef);
  private readonly zone = inject(NgZone);

  ngAfterViewInit() {
    const el = this.contentRef?.nativeElement;
    if (!el) return;
    this.measure();

    // Re-measure on resize/rotation: the same text needs a different number of
    // lines at a different width, so both the collapsed height and whether a
    // toggle is needed at all can change. Kept out of the zone so layout
    // changes don't each trigger an app-wide change detection pass.
    this.zone.runOutsideAngular(() => {
      this.resizeObserver = new ResizeObserver(() => this.measure());
      this.resizeObserver.observe(el);
    });
  }

  ngOnDestroy() {
    this.resizeObserver?.disconnect();
    clearTimeout(this.settleTimer);
  }

  private get prefersReducedMotion(): boolean {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  private measure() {
    const el = this.contentRef?.nativeElement;
    if (!el) return;

    const styles = getComputedStyle(el);
    let lineHeight = parseFloat(styles.lineHeight);
    if (!isFinite(lineHeight) || lineHeight <= 0) {
      // `line-height: normal` doesn't resolve to a px value in every engine;
      // 1.5em is the Tailwind `leading-relaxed` neighbourhood this is used in.
      lineHeight = parseFloat(styles.fontSize) * 1.5;
    }
    this.collapsedHeight = Math.round(lineHeight * this.collapsedLines());

    const overflows = el.scrollHeight > this.collapsedHeight + 2;

    if (!this.expanded) {
      el.style.height = overflows ? `${this.collapsedHeight}px` : 'auto';
    }

    if (overflows !== this.canToggle) {
      this.canToggle = overflows;
      // May be running outside the zone (ResizeObserver), so re-enter to get
      // the OnPush view actually re-rendered.
      this.zone.run(() => this.cdr.markForCheck());
    }
  }

  toggle() {
    const el = this.contentRef?.nativeElement;
    if (!el) return;

    this.expanded = !this.expanded;
    this.cdr.markForCheck();

    if (this.prefersReducedMotion) {
      el.style.transition = '';
      el.style.height = this.expanded ? 'auto' : `${this.collapsedHeight}px`;
      return;
    }

    const target = this.expanded ? el.scrollHeight : this.collapsedHeight;
    // Pin the current height to a number so the browser has a start value,
    // then force a style/layout flush before changing it. WebKit 15 will
    // otherwise coalesce both writes into one frame and snap instead of
    // transitioning — a single requestAnimationFrame is not enough on its own.
    el.style.height = `${this.expanded ? this.collapsedHeight : el.scrollHeight}px`;
    void el.offsetHeight;

    this.zone.runOutsideAngular(() => {
      requestAnimationFrame(() => {
        el.style.transition = 'height 330ms cubic-bezier(.4,0,.2,1)';
        el.style.height = `${target}px`;
        this.settle();
      });
    });
  }

  /**
   * transitionend is unreliable (interrupted transitions, 0->0 no-ops), so the
   * settle is driven by a timer instead. Once expanded the height goes back to
   * `auto` so later reflow (a late-loading font rewrapping the text) isn't
   * clipped.
   */
  private settle() {
    clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => {
      const el = this.contentRef?.nativeElement;
      if (!el) return;
      el.style.transition = '';
      if (this.expanded) el.style.height = 'auto';
    }, 360);
  }
}
