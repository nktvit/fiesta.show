import { Component, computed, DestroyRef, effect, ElementRef, inject, signal, untracked, viewChild } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router } from '@angular/router';
import { catchError, debounceTime, map, of, Subject, switchMap } from 'rxjs';
import { MusicCommand, MusicCommandsService } from '../../services/music-commands.service';
import { MusicLibraryService } from '../../services/music-library.service';
import { MusicPlayerService } from '../../services/music-player.service';
import { formatBinding, isMacPlatform, MusicShortcutsService } from '../../services/music-shortcuts.service';
import { MUSIC_SETTINGS_REGISTRY, MusicSettingEntry } from '../../services/music-settings-registry';
import { MusicUiService } from '../../services/music-ui.service';
import { MusicAlbum, MusicArtist, MusicService, MusicTrack } from '../../services/music.service';
import { fuzzyRank } from '../../utils/music-fuzzy';
import { MusicDialogComponent } from '../music-dialog/music-dialog.component';

const SETTINGS_TAB_LABEL: Record<string, string> = {
  playback: 'Playback', audio: 'Audio', lyrics: 'Lyrics', interface: 'Interface', shortcuts: 'Shortcuts',
  downloads: 'Downloads', scrobbling: 'Scrobbling', data: 'Data', system: 'System',
};

const MAX_COMMANDS_WHEN_SEARCHING = 8;
const MAX_SETTINGS = 50;

export type PaletteRow =
  | { kind: 'command'; cmd: MusicCommand; hint: string }
  | { kind: 'setting'; entry: MusicSettingEntry }
  | { kind: 'track'; track: MusicTrack }
  | { kind: 'album'; album: MusicAlbum }
  | { kind: 'artist'; artist: MusicArtist };

export type PaletteOption = PaletteRow & { index: number };

interface PaletteSection {
  title: string;
  options: PaletteOption[];
}

interface SearchResults {
  q: string;
  tracks: MusicTrack[];
  albums: MusicAlbum[];
  artists: MusicArtist[];
}

/**
 * Command palette (Ctrl/Cmd+K). A combobox dialog: fuzzy-filters the command
 * registry, shows live music search results for what is typed, and with a
 * leading ">" searches the settings registry instead.
 */
@Component({
  selector: 'app-music-command-palette',
  imports: [MusicDialogComponent],
  templateUrl: './music-command-palette.component.html',
})
export class MusicCommandPaletteComponent {
  protected readonly ui = inject(MusicUiService);
  private commands = inject(MusicCommandsService);
  private shortcuts = inject(MusicShortcutsService);
  private player = inject(MusicPlayerService);
  private library = inject(MusicLibraryService);
  private music = inject(MusicService);
  private router = inject(Router);
  private readonly mac = isMacPlatform();

  private readonly input = viewChild<ElementRef<HTMLInputElement>>('input');

  protected readonly query = signal('');
  protected readonly active = signal(0);
  protected readonly results = signal<SearchResults | null>(null);
  protected readonly searching = signal(false);
  private readonly search$ = new Subject<string>();

  protected readonly settingsMode = computed(() => this.query().startsWith('>'));
  /** The trimmed text that is actually searched for. */
  private readonly term = computed(() => (this.settingsMode() ? this.query().slice(1) : this.query()).trim());

  protected readonly sections = computed<PaletteSection[]>(() => {
    const term = this.term();
    const rows: { title: string; rows: PaletteRow[] }[] = [];

    if (this.settingsMode()) {
      const ranked = fuzzyRank(MUSIC_SETTINGS_REGISTRY, term, (e) => [e.label, e.keywords.join(' '), e.description ?? '']);
      rows.push({ title: 'Settings', rows: ranked.slice(0, MAX_SETTINGS).map((r) => ({ kind: 'setting', entry: r.item })) });
    } else {
      const avail = this.commands.available();
      const ranked = fuzzyRank(avail, term, (c) => [c.label, c.keywords.join(' '), c.group]);
      const cmds = term ? ranked.slice(0, MAX_COMMANDS_WHEN_SEARCHING).map((r) => r.item) : ranked.map((r) => r.item);
      if (term) {
        rows.push({ title: 'Commands', rows: cmds.map((cmd) => this.commandRow(cmd)) });
      } else {
        // Empty query: every command, under its group heading.
        for (const cmd of cmds) {
          let s = rows.find((x) => x.title === cmd.group);
          if (!s) rows.push((s = { title: cmd.group, rows: [] }));
          s.rows.push(this.commandRow(cmd));
        }
      }
      const res = this.results();
      if (term && res && res.q === term) {
        const ok = <T>(items: T[], item: (x: T) => Parameters<typeof this.library.isBlocked>[0]) => items.filter((x) => !this.library.isBlocked(item(x)));
        rows.push({ title: 'Tracks', rows: ok(res.tracks, (t) => t).slice(0, 5).map((track) => ({ kind: 'track', track })) });
        rows.push({ title: 'Albums', rows: ok(res.albums, (a) => ({ kind: 'album' as const, data: a })).slice(0, 4).map((album) => ({ kind: 'album', album })) });
        rows.push({ title: 'Artists', rows: ok(res.artists, (a) => ({ kind: 'artist' as const, data: a })).slice(0, 4).map((artist) => ({ kind: 'artist', artist })) });
      }
    }

    let i = 0;
    return rows.filter((s) => s.rows.length).map((s) => ({ title: s.title, options: s.rows.map((r) => ({ ...r, index: i++ }) as PaletteOption) }));
  });

  protected readonly options = computed(() => this.sections().flatMap((s) => s.options));

  protected readonly status = computed(() => {
    const n = this.options().length;
    if (this.settingsMode() && !MUSIC_SETTINGS_REGISTRY.length) return 'No settings to search yet';
    if (!n) return this.searching() ? 'Searching…' : 'No matches';
    return `${n} ${n === 1 ? 'result' : 'results'}${this.searching() ? ', searching music…' : ''}`;
  });

  constructor() {
    // A fresh palette each time it opens (the @defer host keeps the component alive).
    effect(() => {
      if (!this.ui.paletteOpen()) return;
      untracked(() => {
        this.query.set('');
        this.active.set(0);
        this.results.set(null);
        this.searching.set(false);
        this.focusInput(30);
      });
    });

    // Typing drives the live search (debounced; older requests are dropped).
    effect(() => {
      const t = this.settingsMode() ? '' : this.term();
      untracked(() => {
        if (t.length < 2) {
          this.searching.set(false);
          this.results.set(null);
        } else if (this.results()?.q !== t) {
          this.searching.set(true);
        }
        this.search$.next(t);
      });
    });
    this.search$
      .pipe(
        debounceTime(250),
        switchMap((q) =>
          q.length < 2
            ? of(null)
            : this.music.search(q).pipe(
                map((r): SearchResults => ({ q, tracks: r.tracks ?? [], albums: r.albums ?? [], artists: r.artists ?? [] })),
                catchError(() => of(null)),
              ),
        ),
        takeUntilDestroyed(inject(DestroyRef)),
      )
      .subscribe((r) => {
        this.results.set(r);
        this.searching.set(false);
      });

    // Keep the highlighted row inside the list and the highlight inside the options.
    effect(() => {
      const n = this.options().length;
      untracked(() => {
        if (this.active() >= n) this.active.set(Math.max(0, n - 1));
      });
    });
    effect(() => {
      const i = this.active();
      this.options();
      untracked(() => queueMicrotask(() => document.getElementById(this.optionId(i))?.scrollIntoView({ block: 'nearest' })));
    });
  }

  protected optionId(i: number): string {
    return `music-palette-option-${i}`;
  }

  protected onInput(e: Event): void {
    this.query.set((e.target as HTMLInputElement).value);
    this.active.set(0);
  }

  protected onKeydown(e: KeyboardEvent): void {
    const n = this.options().length;
    switch (e.key) {
      case 'ArrowDown':
        if (n) this.active.set((this.active() + 1) % n);
        break;
      case 'ArrowUp':
        if (n) this.active.set((this.active() - 1 + n) % n);
        break;
      case 'Home':
        if (!this.query()) { this.active.set(0); break; }
        return;
      case 'End':
        if (!this.query()) { this.active.set(Math.max(0, n - 1)); break; }
        return;
      case 'Enter': {
        const o = this.options()[this.active()];
        if (o) this.choose(o);
        break;
      }
      default:
        return;
    }
    e.preventDefault();
  }

  protected choose(o: PaletteOption): void {
    switch (o.kind) {
      case 'command':
        if (o.cmd.id === 'settings-search') {
          // Stay open and switch to settings mode.
          this.query.set('>');
          this.active.set(0);
          this.focusInput(0);
          return;
        }
        this.closeThen(() => void this.commands.run(o.cmd.id));
        return;
      case 'setting':
        this.closeThen(() => void this.router.navigate(['/music/settings'], { queryParams: { tab: o.entry.tab } }));
        return;
      case 'track': {
        const list = this.results()?.tracks.filter((t) => !this.library.isBlocked(t)) ?? [o.track];
        const label = this.results()?.q ?? o.track.title;
        this.closeThen(() => void this.player.play(o.track, list, { context: { type: 'search', label } }));
        return;
      }
      case 'album':
        this.closeThen(() => void this.router.navigate(['/music/album', o.album.id]));
        return;
      case 'artist':
        this.closeThen(() => void this.router.navigate(['/music/artist', o.artist.id]));
        return;
    }
  }

  protected title(o: PaletteOption): string {
    switch (o.kind) {
      case 'command': return o.cmd.label;
      case 'setting': return o.entry.label;
      case 'track': return o.track.title;
      case 'album': return o.album.title;
      case 'artist': return o.artist.name;
    }
  }

  protected subtitle(o: PaletteOption): string {
    switch (o.kind) {
      case 'command': return '';
      case 'setting': return SETTINGS_TAB_LABEL[o.entry.tab] ?? o.entry.tab;
      case 'track': return `${o.track.artist} · ${o.track.album}`;
      case 'album': return `${o.album.artist}${o.album.year ? ' · ' + o.album.year : ''}`;
      case 'artist': return 'Artist';
    }
  }

  protected cover(o: PaletteOption): string {
    return o.kind === 'track' ? o.track.cover : o.kind === 'album' ? o.album.cover : o.kind === 'artist' ? o.artist.picture : '';
  }

  private commandRow(cmd: MusicCommand): PaletteRow {
    const hint = cmd.shortcutId ? formatBinding(this.shortcuts.binding(cmd.shortcutId), this.mac) : '';
    return { kind: 'command', cmd, hint };
  }

  /**
   * Closes the palette, then runs the action. The close pops the dialog's history
   * entry asynchronously; an overlay opened in the same tick would lose its own entry.
   */
  private closeThen(fn: () => void): void {
    this.ui.closePalette();
    setTimeout(fn, 100);
  }

  private focusInput(delay: number): void {
    setTimeout(() => this.input()?.nativeElement.focus(), delay);
  }
}
