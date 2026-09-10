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
    // Closes whatever else was open, on this collection or another.
    this.expansion.activate(this);
    this.selectedIndex.set(index);
    this.scrollPanelIntoView();
  }

  close() {
    if (this.selectedIndex() === null) return;
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
      if (!panelEl) return;
      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      panelEl.scrollIntoView({
        behavior: reduced ? 'auto' : 'smooth',
        block: 'nearest',
        inline: 'nearest',
      });
    }, TRANSITION_MS + 60);
  }
}
