import {
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  inject,
  input,
  NgZone,
  OnDestroy,
  OnInit,
  signal,
  ViewChild,
} from '@angular/core';
import { NgClass } from '@angular/common';
import { IMovie } from '../../interfaces/movie.interface';
import { PosterComponent } from '../poster/poster.component';
import { MovieDetailPanelComponent } from '../movie-detail-panel/movie-detail-panel.component';
import { CardExpansionService, ExpandableCollection } from '../../services/card-expansion.service';
import { isScrollLocked } from '../../services/scroll-lock';

export type CollectionVariant = 'browse' | 'wide' | 'compact';

/** Must mirror the grid classes below exactly. */
const COLUMN_STEPS: Record<CollectionVariant, ReadonlyArray<readonly [string, number]>> = {
  browse: [
    ['(min-width: 1024px)', 5],
    ['(min-width: 768px)', 4],
    ['(min-width: 640px)', 3],
  ],
  wide: [
    ['(min-width: 1280px)', 6],
    ['(min-width: 1024px)', 5],
    ['(min-width: 768px)', 4],
    ['(min-width: 640px)', 3],
  ],
  compact: [
    ['(min-width: 1024px)', 6],
    ['(min-width: 768px)', 5],
    ['(min-width: 640px)', 4],
  ],
};

const BASE_COLUMNS: Record<CollectionVariant, number> = { browse: 2, wide: 2, compact: 3 };

const GRID_CLASSES: Record<CollectionVariant, string> = {
  browse: 'grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4',
  wide: 'grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3 md:gap-4',
  compact: 'grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 gap-3 md:gap-4',
};

/** Matches the panel's own transition so removal waits for the collapse. */
const TRANSITION_MS = 420;

/**
 * When the panel is scrolled into view, and when the scroll watch below is
 * started: after the height animation has finished moving the layout.
 */
export const PANEL_SETTLE_MS = TRANSITION_MS + 60;

/**
 * How far the page has to travel, in px, before an open panel is dismissed —
 * *on top of* whatever scrolling the panel itself demands (see `armScrollWatch`).
 *
 * Deliberately not "any scroll": nudging the page a little to read the panel
 * is part of using it, so only leaving the row's neighbourhood should close it.
 */
export const SCROLL_DISMISS_PX = 260;

/**
 * Quiet period with no scroll event after which the page counts as at rest,
 * and the dismissal baseline is taken. The panel scrolls *itself* into view on
 * open — measuring from before that settles would charge the app's own smooth
 * scroll to the user and close the panel the instant it opened.
 */
export const SCROLL_REST_MS = 150;

/**
 * Ceiling on waiting for that quiet period. A slow, continuous drag never
 * produces one, and without this the watcher would stay disarmed for as long
 * as the user kept scrolling — which is precisely when it should fire.
 */
export const SCROLL_ARM_TIMEOUT_MS = 1500;

/**
 * A grid or horizontal shelf of posters where clicking a card expands its
 * details in place rather than navigating away.
 *
 * In grid mode the panel is a `col-span-full` grid item rendered after the
 * last card of the clicked card's row, so grid auto-flow drops it onto its own
 * row directly beneath. The column count comes from media queries rather than
 * from reading layout: the counts are hardcoded Tailwind classes, so the
 * breakpoints *are* the source of truth, and it costs no forced reflow.
 */
@Component({
  selector: 'app-movie-collection',
  imports: [NgClass, PosterComponent, MovieDetailPanelComponent],
  templateUrl: './movie-collection.component.html',
  styleUrl: './movie-collection.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MovieCollectionComponent implements OnInit, OnDestroy, ExpandableCollection {
  readonly movies = input.required<IMovie[]>();
  readonly mode = input<'grid' | 'row'>('grid');
  readonly variant = input<CollectionVariant>('browse');
  readonly heading = input<string>('');
  /** Extra classes for the row-mode heading (the per-shelf hover colour). */
  readonly headingClass = input<string>('');
  readonly expandable = input<boolean>(true);
  /** Number of leading posters to mark as high priority for LCP. */
  readonly priorityCount = input<number>(0);

  @ViewChild(MovieDetailPanelComponent) private panel?: MovieDetailPanelComponent;

  readonly selectedIndex = signal<number | null>(null);
  readonly columns = signal(2);

  /**
   * Index of the card the panel is rendered after: the last card in the
   * selected card's row.
   */
  readonly panelAfterIndex = computed(() => {
    const index = this.selectedIndex();
    if (index === null) return -1;
    const columns = this.columns();
    const rowEnd = Math.floor(index / columns) * columns + columns - 1;
    return Math.min(rowEnd, this.movies().length - 1);
  });

  readonly selectedMovie = computed(() => {
    const index = this.selectedIndex();
    return index === null ? null : (this.movies()[index] ?? null);
  });

  private mediaQueries: MediaQueryList[] = [];
  private onBreakpointChange = () => this.recomputeColumns();
  private closeTimer?: ReturnType<typeof setTimeout>;
  private scrollTimer?: ReturnType<typeof setTimeout>;

  /** Scroll-to-dismiss state — see `startScrollWatch()`. */
  private scrollWatching = false;
  private scrollArmed = false;
  private scrollBaseline = 0;
  private lastScrollY = 0;
  /** Panel overhang past each edge of the viewport — see `armScrollWatch()`. */
  private slackDown = 0;
  private slackUp = 0;
  private restTimer?: ReturnType<typeof setTimeout>;
  private armTimer?: ReturnType<typeof setTimeout>;
  private onWindowScroll = () => this.handleScroll(window.scrollY);

  private readonly zone = inject(NgZone);
  private readonly expansion = inject(CardExpansionService);
  /** Cards dim while any collection on the page is expanded, not just this one. */
  readonly anyOpen = this.expansion.anyOpen;
  private readonly hostEl = (inject(ElementRef) as ElementRef<HTMLElement>).nativeElement;

  get gridClasses(): string {
    return GRID_CLASSES[this.variant()];
  }

  ngOnInit() {
    this.columns.set(BASE_COLUMNS[this.variant()]);
    // Outside the zone: breakpoint crossings are rare, and the signal write
    // schedules the render itself.
    this.zone.runOutsideAngular(() => {
      this.mediaQueries = COLUMN_STEPS[this.variant()].map(([query]) => window.matchMedia(query));
      this.mediaQueries.forEach(query => query.addEventListener('change', this.onBreakpointChange));
      this.recomputeColumns();
    });
  }

  ngOnDestroy() {
    this.expansion.deactivate(this);
    this.mediaQueries.forEach(query => query.removeEventListener('change', this.onBreakpointChange));
    this.stopScrollWatch();
    clearTimeout(this.closeTimer);
    clearTimeout(this.scrollTimer);
  }

  private recomputeColumns() {
    const steps = COLUMN_STEPS[this.variant()];
    const matchedIndex = this.mediaQueries.findIndex(query => query.matches);
    const columns = matchedIndex >= 0 ? steps[matchedIndex][1] : BASE_COLUMNS[this.variant()];
    if (columns !== this.columns()) this.zone.run(() => this.columns.set(columns));
  }

  trackKey = (movie: IMovie, index: number): string =>
    String(movie.tmdbId ?? movie.imdbID ?? index);

  isSelected(index: number): boolean {
    return this.selectedIndex() === index;
  }

  toggle(index: number) {
    if (!this.expandable()) return;
    if (this.selectedIndex() === index) {
      this.close();
      return;
    }
    clearTimeout(this.closeTimer);
    // Switching cards reuses the panel, so an already-armed watch would still
    // be measuring from the previous card's baseline while the new one
    // animates in. `scrollPanelIntoView()` re-arms it once that settles.
    this.stopScrollWatch();
    // Closes whatever else was open, on this collection or another.
    this.expansion.activate(this);
    this.selectedIndex.set(index);
    this.scrollPanelIntoView();
  }

  close() {
    if (this.selectedIndex() === null) return;
    this.stopScrollWatch();
    // A close inside the settle window would otherwise leave the pending
    // scroll-into-view to fire at the panel as it collapses — and to start a
    // watch on it that nothing is left to stop.
    clearTimeout(this.scrollTimer);
    // Let the panel play its collapse before Angular removes it from the DOM,
    // otherwise the row just vanishes.
    this.panel?.animateClose();
    this.expansion.deactivate(this);
    clearTimeout(this.closeTimer);
    this.closeTimer = setTimeout(() => this.selectedIndex.set(null), TRANSITION_MS);
  }

  /**
   * Scrolled after the height animation settles — scrolling while the layout
   * is still moving fights the smooth scroll and lands in the wrong place.
   */
  private scrollPanelIntoView() {
    clearTimeout(this.scrollTimer);
    this.scrollTimer = setTimeout(() => {
      const panelEl = this.hostEl.querySelector('app-movie-detail-panel');
      if (panelEl) {
        const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        panelEl.scrollIntoView({
          behavior: reduced ? 'auto' : 'smooth',
          block: 'nearest',
          inline: 'nearest',
        });
      }
      // Started even when the panel element is missing, or the open would have
      // no way of being dismissed by scrolling at all.
      this.startScrollWatch();
    }, PANEL_SETTLE_MS);
  }

  /**
   * Watches for the user scrolling away from an open panel, and closes it once
   * they have travelled `SCROLL_DISMISS_PX` from where the page came to rest.
   *
   * Started after `scrollPanelIntoView()` rather than at open time, and armed
   * only once scrolling stops, because the app moves the page itself here —
   * baselining any earlier would measure our own smooth scroll and dismiss the
   * panel on the frame it appeared.
   */
  private startScrollWatch() {
    this.stopScrollWatch();
    // Outside the zone: this fires on every scroll frame, and this app is
    // zone-based with Default CD — each event would otherwise tick the whole
    // application. Only the close itself needs to be back inside.
    this.zone.runOutsideAngular(() => {
      this.scrollWatching = true;
      this.scrollArmed = false;
      this.lastScrollY = window.scrollY;
      this.scrollBaseline = this.lastScrollY;
      // Passive: the handler never calls preventDefault, and saying so keeps
      // it off the scrolling critical path.
      window.addEventListener('scroll', this.onWindowScroll, { passive: true });
      this.restTimer = setTimeout(this.armScrollWatch, SCROLL_REST_MS);
      this.armTimer = setTimeout(this.armScrollWatch, SCROLL_ARM_TIMEOUT_MS);
    });
  }

  private stopScrollWatch() {
    if (this.scrollWatching) {
      window.removeEventListener('scroll', this.onWindowScroll);
      this.scrollWatching = false;
    }
    this.scrollArmed = false;
    clearTimeout(this.restTimer);
    clearTimeout(this.armTimer);
  }

  /**
   * Takes the baseline, plus how much of the panel is hanging off each edge of
   * the viewport.
   *
   * That overhang is scrolling the user is *forced* to do to see the panel they
   * just opened, so it can't also count as scrolling away from it. It matters:
   * the panel is content-sized, so on a 360x640 Android it stands 1.2x the
   * viewport and reaching its own Play button costs 243px — 17px short of the
   * bare threshold. Without this, overshooting by a thumb-width would collapse
   * the panel the user was reaching into. Where the panel does fit on screen
   * (desktop, larger phones) both values are 0 and the threshold is exactly
   * SCROLL_DISMISS_PX.
   *
   * One layout read, once per open — never per scroll frame.
   */
  private armScrollWatch = () => {
    clearTimeout(this.restTimer);
    // A pinned page reports a shifted layout, so the overhang below would come
    // out wrong. Nothing is moving behind the sheet anyway — wait it out.
    if (isScrollLocked()) {
      this.restTimer = setTimeout(this.armScrollWatch, SCROLL_REST_MS);
      return;
    }
    clearTimeout(this.armTimer);
    this.scrollBaseline = this.lastScrollY;

    const rect = this.hostEl.querySelector('app-movie-detail-panel')?.getBoundingClientRect();
    this.slackDown = rect ? Math.max(0, rect.bottom - window.innerHeight) : 0;
    this.slackUp = rect ? Math.max(0, -rect.top) : 0;

    this.scrollArmed = true;
  };

  /**
   * Split from the listener so the spec can drive scroll positions directly:
   * Karma's page has no scrollable height to produce real ones with.
   */
  private handleScroll(y: number) {
    // A scroll-locked page is pinned with `position: fixed`, which snaps the
    // window to the top and reports the whole offset as one scroll. That is
    // the sheet opening over the panel, not the user leaving it — and the
    // offset is restored on release, so sitting it out loses nothing.
    if (isScrollLocked()) return;

    this.lastScrollY = y;

    if (!this.scrollArmed) {
      // Still settling. Push the baseline out to wherever the page actually
      // comes to rest, rather than measuring from somewhere it was only
      // passing through on the way there.
      clearTimeout(this.restTimer);
      this.restTimer = setTimeout(this.armScrollWatch, SCROLL_REST_MS);
      return;
    }

    // Either direction: scrolling back up past the row dismisses it too. Down
    // reveals what hangs below the fold, up reveals what sits above it, so
    // each direction gets its own slack.
    const delta = y - this.scrollBaseline;
    const budget = SCROLL_DISMISS_PX + (delta >= 0 ? this.slackDown : this.slackUp);
    if (Math.abs(delta) < budget) return;

    this.zone.run(() => this.close());
  }
}
