import { Component, computed, DestroyRef, effect, inject, input, output, signal } from '@angular/core';
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
import { Router } from '@angular/router';
import { catchError, debounceTime, distinctUntilChanged, map, of, switchMap, tap } from 'rxjs';
import { MusicCatalogService, MusicSuggestions } from '../../services/music-catalog.service';
import { MusicLibraryService } from '../../services/music-library.service';
import { MusicSettingsService } from '../../services/music-settings.service';

export interface MusicSuggestOption {
  id: string;
  kind: 'term' | 'artist' | 'album' | 'track';
  label: string;
  sub: string;
  image: string;
  /** Route for artist/album/track options; terms run a search instead. */
  route: string | null;
}

export const MUSIC_SUGGEST_DEBOUNCE_MS = 250;
export const MUSIC_SUGGEST_MIN_CHARS = 2;

/**
 * Suggestions dropdown for the search box (a listbox, role=listbox). The search
 * page owns the <input>, wires it as a combobox with `listboxId` / `activeId` /
 * `expanded`, and forwards keydown to `handleKey`:
 *   ArrowDown/ArrowUp move, Enter opens the highlighted option, Escape closes.
 * Typing is debounced 250 ms; a newer query cancels the request still in flight.
 */
@Component({
  selector: 'app-music-search-suggest',
  templateUrl: './music-search-suggest.component.html',
  host: { class: 'block' },
})
export class MusicSearchSuggestComponent {
  /** What the user has typed so far. */
  readonly query = input('');
  /** The page sets this false once a search has been submitted/chosen. */
  readonly enabled = input(true);
  /** A plain-text completion was chosen: run this search. */
  readonly searchTerm = output<string>();

  private catalog = inject(MusicCatalogService);
  private library = inject(MusicLibraryService);
  private router = inject(Router);
  protected readonly settings = inject(MusicSettingsService);

  readonly listboxId = 'music-suggest-listbox';
  private readonly data = signal<MusicSuggestions | null>(null);
  private readonly dismissed = signal(false);
  readonly loading = signal(false);
  readonly active = signal(-1);

  readonly options = computed<MusicSuggestOption[]>(() => {
    const d = this.data();
    if (!d) return [];
    const out: MusicSuggestOption[] = [];
    for (const t of d.terms.slice(0, 3)) out.push({ id: `sg-term-${out.length}`, kind: 'term', label: t, sub: '', image: '', route: null });
    for (const a of d.artists.filter((x) => !this.library.isBlocked({ kind: 'artist', data: x })).slice(0, 2)) {
      out.push({ id: `sg-artist-${a.id}`, kind: 'artist', label: a.name, sub: 'Artist', image: a.picture, route: `/music/artist/${a.id}` });
    }
    for (const a of d.albums.filter((x) => !this.library.isBlocked({ kind: 'album', data: x })).slice(0, 2)) {
      out.push({ id: `sg-album-${a.id}`, kind: 'album', label: a.title, sub: `Album · ${a.artist}`, image: a.cover, route: `/music/album/${a.id}` });
    }
    for (const t of d.tracks.filter((x) => !this.library.isBlocked(x)).slice(0, 3)) {
      out.push({ id: `sg-track-${t.id}`, kind: 'track', label: t.title, sub: `Song · ${t.artist}`, image: t.cover, route: `/music/track/${t.id}` });
    }
    return out;
  });

  readonly expanded = computed(
    () => this.enabled() && !this.dismissed() && this.query().trim().length >= MUSIC_SUGGEST_MIN_CHARS && this.options().length > 0,
  );
  readonly activeId = computed(() => (this.expanded() && this.active() >= 0 ? this.options()[this.active()]?.id ?? null : null));

  constructor() {
    toObservable(this.query)
      .pipe(
        map((q) => q.trim()),
        distinctUntilChanged(),
        tap((q) => {
          this.dismissed.set(false);
          this.active.set(-1);
          if (q.length < MUSIC_SUGGEST_MIN_CHARS) {
            this.data.set(null);
            this.loading.set(false);
          }
        }),
        debounceTime(MUSIC_SUGGEST_DEBOUNCE_MS),
        // switchMap unsubscribes the previous HttpClient call, which aborts the request.
        switchMap((q) => {
          if (q.length < MUSIC_SUGGEST_MIN_CHARS || !this.enabled()) return of(null);
          this.loading.set(true);
          return this.catalog.suggest(q).pipe(catchError(() => of(null)));
        }),
        takeUntilDestroyed(inject(DestroyRef)),
      )
      .subscribe((d) => {
        this.loading.set(false);
        if (this.query().trim().length >= MUSIC_SUGGEST_MIN_CHARS) this.data.set(d);
        else this.data.set(null);
      });

    // Choosing / submitting hides the list.
    effect(() => {
      if (!this.enabled()) this.dismissed.set(true);
    });
  }

  /** Forward the input's keydown here. Returns true when the key was consumed. */
  handleKey(e: KeyboardEvent): boolean {
    const n = this.options().length;
    if (e.key === 'Escape') {
      if (!this.expanded()) return false;
      this.dismissed.set(true);
      this.active.set(-1);
      e.preventDefault();
      return true;
    }
    if (!n) return false;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!this.expanded()) {
        this.dismissed.set(false);
        return true;
      }
      this.active.set((this.active() + 1) % n);
      return true;
    }
    if (e.key === 'ArrowUp' && this.expanded()) {
      e.preventDefault();
      this.active.set(this.active() <= 0 ? n - 1 : this.active() - 1);
      return true;
    }
    if (e.key === 'Enter' && this.expanded() && this.active() >= 0) {
      e.preventDefault();
      this.choose(this.options()[this.active()]);
      return true;
    }
    return false;
  }

  /** Hide the list (the input lost focus). Typing or ArrowDown brings it back. */
  dismiss(): void {
    this.dismissed.set(true);
    this.active.set(-1);
  }

  protected choose(o: MusicSuggestOption): void {
    this.dismissed.set(true);
    this.active.set(-1);
    if (o.route) void this.router.navigateByUrl(o.route);
    else this.searchTerm.emit(o.label);
  }

  protected hover(i: number): void {
    this.active.set(i);
  }
}
