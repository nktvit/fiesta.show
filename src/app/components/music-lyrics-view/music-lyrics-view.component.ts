// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
// Derived from @uimaxbai/am-lyrics src/AmLyrics.ts - adapted for Fiesta.
import { Component, DestroyRef, ElementRef, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { MusicLyricsI18nService } from '../../services/music-lyrics-i18n.service';
import { MusicLyricsLookup, MusicLyricsService, sanitizeLyricsPrefs } from '../../services/music-lyrics.service';
import { MusicPlayerService } from '../../services/music-player.service';
import { MusicSettingsService } from '../../services/music-settings.service';
import { MusicToastService } from '../../services/music-toast.service';
import { MUSIC_LYRICS_LANGUAGES } from '../../utils/music-lyrics-languages';
import { isSynced } from '../../utils/music-lyrics-lrc';
import {
  MusicClockAnchor,
  MusicLyricGap,
  activeGap,
  activeLineIndex,
  findInstrumentalGaps,
  interpolatePosition,
  isLineSounding,
  mainLineIndices,
  syllableProgress,
} from '../../utils/music-lyrics-sync';
import type { MusicLyricLine, MusicLyricSyllable, MusicLyrics } from '../../utils/music-lyrics-types';

type ViewState = 'idle' | 'loading' | 'ready' | 'none' | 'error';
type DownloadFormat = 'auto' | 'lrc' | 'ttml' | 'plain';

interface Row {
  i: number;
  line: MusicLyricLine;
  translation?: string;
  romanized?: string;
  gapBefore: MusicLyricGap | null;
}

interface Extra {
  for: MusicLyrics;
  lang?: string;
  items: string[];
}

/** After the user scrolls by hand, auto-scroll waits this long. */
const USER_SCROLL_PAUSE_MS = 4000;
const OFFSET_STEP = 0.5;
const OFFSET_MAX = 30;
const OFFSET_KEEP = 400;
const GAP_DOTS = [0, 1, 2];

/**
 * Lyrics for player.track(), synced to playback. Used by the lyrics panel and
 * inside Now Playing: provider cascade, line and word (karaoke) highlighting,
 * click to seek, per-track timing offset, romanize/translate, source switching
 * and download. Owned by package P3.
 */
@Component({
  selector: 'app-music-lyrics-view',
  templateUrl: './music-lyrics-view.component.html',
  host: {
    class: 'relative block',
    '[class.h-full]': "mode() === 'fullscreen'",
    '[class.overflow-y-auto]': "mode() === 'fullscreen'",
    '(document:click)': 'onDocumentClick($event)',
  },
})
export class MusicLyricsViewComponent {
  readonly mode = input<'panel' | 'fullscreen'>('panel');
  /** CSS colour from Now Playing's dynamic accent; null = indigo. */
  readonly accent = input<string | null>(null);

  protected readonly player = inject(MusicPlayerService);
  protected readonly settings = inject(MusicSettingsService);
  private readonly service = inject(MusicLyricsService);
  private readonly i18n = inject(MusicLyricsI18nService);
  private readonly toast = inject(MusicToastService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly languages = MUSIC_LYRICS_LANGUAGES;
  protected readonly gapDots = GAP_DOTS;
  protected readonly step = OFFSET_STEP;
  protected readonly formats: { id: DownloadFormat; label: string }[] = [
    { id: 'auto', label: 'Auto' },
    { id: 'lrc', label: 'LRC' },
    { id: 'ttml', label: 'TTML' },
    { id: 'plain', label: 'Plain text' },
  ];

  // ── data ────────────────────────────────────────────────────────────────
  protected readonly state = signal<ViewState>('idle');
  private readonly lookup = signal<MusicLyricsLookup | null>(null);
  protected readonly lyrics = computed(() => this.lookup()?.lyrics ?? null);
  protected readonly tried = computed(() => this.lookup()?.tried ?? []);
  protected readonly switching = signal(false);
  protected readonly prefs = computed(() => sanitizeLyricsPrefs(this.service.prefs()));

  protected readonly romanizeOn = signal(this.service.currentPrefs().romanize);
  protected readonly translateOn = signal(this.service.currentPrefs().translate);
  protected readonly targetLang = signal(this.service.currentPrefs().targetLang);
  protected readonly romanizing = signal(false);
  protected readonly translating = signal(false);
  private readonly romans = signal<Extra | null>(null);
  private readonly translations = signal<Extra | null>(null);

  private readonly trackId = computed(() => this.player.track()?.id ?? null);
  private loadController: AbortController | null = null;
  private extraController: AbortController | null = null;

  // ── timing ──────────────────────────────────────────────────────────────
  private readonly offsets = this.settings.scoped<Record<string, number>>('lyrics-offsets', {});
  protected readonly offset = computed(() => {
    const id = this.trackId();
    const v = id === null ? 0 : this.offsets()[String(id)];
    return typeof v === 'number' && Number.isFinite(v) ? v : 0;
  });
  protected readonly offsetLabel = computed(() => {
    const o = this.offset();
    return `${o > 0 ? '+' : ''}${o.toFixed(1)}s`;
  });
  /** Interpolated player position in seconds (before the offset). */
  private readonly clock = signal(0);
  /** Position in lyric time: a positive offset shows lyrics later. */
  private readonly t = computed(() => this.clock() - this.offset());

  protected readonly lines = computed(() => this.lyrics()?.lines ?? []);
  private readonly mainIdx = computed(() => mainLineIndices(this.lines()));
  protected readonly synced = computed(() => (this.lyrics() ? isSynced(this.lyrics()!.lines) : false));
  protected readonly gaps = computed(() => (this.synced() ? findInstrumentalGaps(this.lines()) : []));
  protected readonly activeIdx = computed(() => (this.synced() ? activeLineIndex(this.lines(), this.t(), this.mainIdx()) : -1));
  protected readonly gapActive = computed(() => (this.synced() ? activeGap(this.gaps(), this.t()) : null));
  /** The line blur is measured from: the active line, or the next one inside a gap. */
  private readonly focusIdx = computed(() => {
    const a = this.activeIdx();
    if (a >= 0) return a;
    const lines = this.lines();
    const t = this.t();
    const next = this.mainIdx().find((i) => lines[i].start > t);
    return next ?? Math.max(0, lines.length - 1);
  });
  private readonly fineClock = computed(() => this.state() === 'ready' && this.synced() && this.prefs().karaoke && !!this.lyrics()?.wordSynced);

  protected readonly rows = computed<Row[]>(() => {
    const lyrics = this.lyrics();
    if (!lyrics) return [];
    const gapAt = new Map(this.gaps().map((g) => [g.beforeIndex, g]));
    const translateOn = this.translateOn();
    const romanizeOn = this.romanizeOn();
    const tr = translateOn ? this.translations() : null;
    const rom = romanizeOn ? this.romans() : null;
    const trItems = tr && tr.for === lyrics && tr.lang === this.targetLang() ? tr.items : null;
    const romItems = rom && rom.for === lyrics ? rom.items : null;
    return lyrics.lines.map((line, i) => ({
      i,
      line,
      translation: translateOn ? ((trItems?.[i] && trItems[i] !== line.text ? trItems[i] : undefined) ?? line.translation) : undefined,
      romanized: romanizeOn ? ((romItems?.[i] && romItems[i] !== line.text ? romItems[i] : undefined) ?? line.romanized) : undefined,
      gapBefore: gapAt.get(i) ?? null,
    }));
  });

  // ── scrolling ───────────────────────────────────────────────────────────
  protected readonly userScrolling = signal(false);
  protected readonly menuOpen = signal(false);
  private userScrollTimer: ReturnType<typeof setTimeout> | null = null;
  private scrollTimer: ReturnType<typeof setTimeout> | null = null;
  private watched: HTMLElement | null = null;
  private readonly onUserScroll = () => this.markUserScroll();
  private readonly onScrollKey = (e: Event) => {
    const k = (e as KeyboardEvent).key;
    if (['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown', ' '].includes(k)) this.markUserScroll();
  };
  private readonly onScrollerPointer = (e: Event) => {
    // A press on the scroller itself (not on a child) is the scrollbar.
    if (e.target === this.watched) this.markUserScroll();
  };

  // ── clock ───────────────────────────────────────────────────────────────
  private raf = 0;
  private anchor: MusicClockAnchor = { position: 0, at: 0 };
  private lastPos = -1;
  private lastTick = 0;
  private destroyed = false;
  private readonly onVisibility = () => {
    if (typeof document !== 'undefined' && !document.hidden) this.startClock();
  };

  constructor() {
    // New track: refetch (and drop whatever was in flight).
    effect(() => {
      const id = this.trackId();
      untracked(() => this.load(id));
    });

    // Romanize / translate when asked, for the lyrics on screen.
    effect(() => {
      const l = this.lyrics();
      const on = this.romanizeOn();
      untracked(() => void this.ensureRomanized(l, on));
    });
    effect(() => {
      const l = this.lyrics();
      const on = this.translateOn();
      const lang = this.targetLang();
      untracked(() => void this.ensureTranslated(l, on, lang));
    });

    // Run the 60 fps clock only while synced lyrics are on screen.
    effect(() => {
      const run = this.state() === 'ready' && this.synced();
      untracked(() => (run ? this.startClock() : this.stopClock()));
    });

    // Keep the current line in view.
    effect(() => {
      this.activeIdx();
      this.gapActive();
      const ready = this.state() === 'ready';
      untracked(() => {
        if (ready) this.queueScroll(false);
      });
    });

    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this.onVisibility);
    this.destroyRef.onDestroy(() => {
      this.destroyed = true;
      this.stopClock();
      this.loadController?.abort();
      this.extraController?.abort();
      if (this.userScrollTimer) clearTimeout(this.userScrollTimer);
      if (this.scrollTimer) clearTimeout(this.scrollTimer);
      this.unwatchScroller();
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.onVisibility);
    });
  }

  // ── loading ─────────────────────────────────────────────────────────────
  protected retry(): void {
    this.load(this.trackId());
  }

  private load(id: number | null): void {
    this.loadController?.abort();
    this.extraController?.abort();
    this.lookup.set(null);
    this.romans.set(null);
    this.translations.set(null);
    this.switching.set(false);
    this.menuOpen.set(false);
    this.userScrolling.set(false);
    const track = this.player.track();
    if (id === null || !track) {
      this.state.set('idle');
      return;
    }
    this.clock.set(this.player.position());
    this.state.set('loading');
    const controller = new AbortController();
    this.loadController = controller;
    this.service
      .lookup(track, { signal: controller.signal })
      .then((res) => {
        if (controller.signal.aborted) return;
        this.lookup.set(res);
        this.state.set(res.lyrics ? 'ready' : res.failed ? 'error' : 'none');
        this.queueScroll(true);
      })
      .catch(() => {
        if (!controller.signal.aborted) this.state.set('error');
      });
  }

  protected async switchSource(): Promise<void> {
    const cur = this.lookup();
    const track = this.player.track();
    if (!cur?.lyrics || !track || this.switching()) return;
    this.switching.set(true);
    const controller = this.loadController ?? new AbortController();
    try {
      const next = await this.service.lookup(track, { signal: controller.signal, sourceIndex: cur.sourceIndex + 1 });
      if (controller.signal.aborted || this.trackId() !== track.id) return;
      if (next.lyrics && next.sources.length > 1) {
        this.lookup.set(next);
        this.userScrolling.set(false);
        this.queueScroll(true);
      } else {
        this.lookup.set({ ...cur, complete: true });
        this.toast.show({ message: 'No other lyric sources found for this song' });
      }
    } catch {
      if (!controller.signal.aborted) this.toast.show({ message: 'Could not load another lyric source', tone: 'warn' });
    } finally {
      this.switching.set(false);
    }
  }

  protected canSwitch(): boolean {
    const l = this.lookup();
    return !!l?.lyrics && (l.sources.length > 1 || !l.complete);
  }

  // ── romanize / translate ────────────────────────────────────────────────
  protected toggleRomanize(): void {
    this.romanizeOn.update((v) => !v);
  }

  protected toggleTranslate(): void {
    this.translateOn.update((v) => !v);
  }

  protected setLanguage(code: string): void {
    this.targetLang.set(code);
    this.service.setPrefs({ targetLang: code });
  }

  private async ensureRomanized(l: MusicLyrics | null, on: boolean): Promise<void> {
    if (!l || !on) return;
    if (this.romans()?.for === l) return;
    const controller = new AbortController();
    this.extraController?.abort();
    this.extraController = controller;
    this.romanizing.set(true);
    try {
      const items = await this.i18n.romanize(l.lines.map((x) => x.text), controller.signal);
      if (!controller.signal.aborted) this.romans.set({ for: l, items });
    } catch {
      if (controller.signal.aborted) return;
      this.toast.show({ message: "Couldn't romanize the lyrics right now", tone: 'warn' });
      this.romanizeOn.set(false);
    } finally {
      if (this.extraController === controller) this.romanizing.set(false);
    }
  }

  private async ensureTranslated(l: MusicLyrics | null, on: boolean, lang: string): Promise<void> {
    if (!l || !on) return;
    const have = this.translations();
    if (have?.for === l && have.lang === lang) return;
    this.translating.set(true);
    try {
      const items = await this.i18n.translate(l.lines.map((x) => x.text), lang);
      if (this.lyrics() === l && this.targetLang() === lang) this.translations.set({ for: l, lang, items });
    } catch {
      if (this.lyrics() !== l) return;
      this.toast.show({ message: "Couldn't translate the lyrics right now", tone: 'warn' });
      this.translateOn.set(false);
    } finally {
      this.translating.set(false);
    }
  }

  // ── timing offset ───────────────────────────────────────────────────────
  protected nudge(delta: number): void {
    const id = this.trackId();
    if (id === null) return;
    const next = Math.round(Math.max(-OFFSET_MAX, Math.min(OFFSET_MAX, this.offset() + delta)) * 10) / 10;
    this.offsets.update((all) => {
      const copy = { ...all };
      delete copy[String(id)]; // re-insert last so the oldest entries drop first
      if (next !== 0) copy[String(id)] = next;
      const keys = Object.keys(copy);
      for (const k of keys.slice(0, Math.max(0, keys.length - OFFSET_KEEP))) delete copy[k];
      return copy;
    });
  }

  protected resetOffset(): void {
    this.nudge(-this.offset());
  }

  // ── template helpers ────────────────────────────────────────────────────
  protected isActive(row: Row): boolean {
    if (!this.synced()) return false;
    if (row.line.background) return isLineSounding(row.line, this.t());
    return row.i === this.activeIdx();
  }

  protected isPlayed(row: Row): boolean {
    return this.synced() && !this.isActive(row) && this.t() >= row.line.end;
  }

  protected hidden(row: Row): boolean {
    return this.prefs().hidePlayed && this.isPlayed(row);
  }

  protected useKaraoke(row: Row): boolean {
    return this.prefs().karaoke && (row.line.syllables?.length ?? 0) > 0 && this.isActive(row);
  }

  protected pct(s: MusicLyricSyllable): number {
    return Math.round(syllableProgress(s, this.t()) * 1000) / 10;
  }

  protected karaokeBackground(): string {
    const on = this.accent() ?? '#ffffff';
    return `linear-gradient(90deg, ${on} calc(var(--p) * 1.12% - 12%), rgba(255,255,255,0.4) calc(var(--p) * 1.12%))`;
  }

  protected blur(row: Row): string | null {
    if (!this.synced() || !this.prefs().blur || this.settings.reduceBlur() || this.userScrolling()) return null;
    if (this.isActive(row)) return null;
    const dist = Math.min(4, Math.abs(row.i - this.focusIdx()));
    return dist === 0 ? null : `blur(${(dist * 0.6).toFixed(1)}px)`;
  }

  protected lineClass(row: Row): string {
    const big = this.mode() === 'fullscreen';
    const bg = !!row.line.background;
    const size = bg
      ? big ? 'text-xl font-medium' : 'text-base font-medium'
      : big ? 'text-3xl font-bold md:text-4xl' : 'text-xl font-semibold';
    const active = this.isActive(row);
    const color = active
      ? bg ? 'text-white/80' : 'text-white'
      : this.synced()
        ? bg ? 'text-white/25 hover:text-white/50' : 'text-white/40 hover:text-white/70'
        : 'text-white/90';
    const align = row.line.align === 'end' ? 'text-end' : 'text-start';
    const hide = this.hidden(row) ? 'opacity-0 pointer-events-none' : '';
    return `block w-full max-w-[92%] rounded-lg px-3 py-2 leading-snug transition-[color,filter,opacity] duration-300 motion-reduce:transition-none focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 ${size} ${color} ${align} ${hide}`;
  }

  protected dotClass(active: boolean): string {
    return `h-2.5 w-2.5 rounded-full ${active ? 'bg-white animate-pulse motion-reduce:animate-none' : 'bg-white/30'}`;
  }

  // ── actions ─────────────────────────────────────────────────────────────
  protected seekTo(row: Row): void {
    if (!this.synced()) return;
    // Displayed time = position - offset, so aim at start + offset.
    const to = Math.max(0, row.line.start + this.offset());
    this.player.seek(to);
    this.clock.set(to);
    this.anchor = { position: to, at: typeof performance === 'undefined' ? 0 : performance.now() };
    this.lastPos = to;
    if (!this.player.playing()) this.player.resume();
    this.resumeAutoScroll();
  }

  protected toggleMenu(): void {
    this.menuOpen.update((v) => !v);
  }

  /** Escape closes the menu (and only the menu), then focus goes back to its button. */
  protected onMenuEscape(e: Event): void {
    if (!this.menuOpen()) return;
    e.stopPropagation();
    this.menuOpen.set(false);
    this.host.nativeElement.querySelector<HTMLElement>('[data-download-button]')?.focus();
  }

  protected onDocumentClick(e: Event): void {
    if (!this.menuOpen()) return;
    const el = this.host.nativeElement.querySelector('[data-download]');
    if (el && !el.contains(e.target as Node)) this.menuOpen.set(false);
  }

  protected download(format: DownloadFormat): void {
    this.menuOpen.set(false);
    const l = this.lyrics();
    const track = this.player.track();
    if (!l || !track || typeof document === 'undefined') return;
    const kind: Exclude<DownloadFormat, 'auto'> = format === 'auto' ? (l.wordSynced ? 'ttml' : l.synced ? 'lrc' : 'plain') : format;
    const text =
      kind === 'ttml'
        ? this.service.toTTML(l)
        : kind === 'lrc'
          ? this.service.toLRC(l, { ti: track.title, ar: track.artist, al: track.album })
          : this.service.toPlain(l);
    const ext = kind === 'plain' ? 'txt' : kind;
    const type = kind === 'ttml' ? 'application/ttml+xml' : 'text/plain';
    const name = `${track.artist} - ${track.title}`.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
    const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${name || 'lyrics'}.${ext}`;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  protected resumeAutoScroll(): void {
    if (this.userScrollTimer) clearTimeout(this.userScrollTimer);
    this.userScrollTimer = null;
    this.userScrolling.set(false);
    this.queueScroll(true);
  }

  // ── auto-scroll ─────────────────────────────────────────────────────────
  private reduced(): boolean {
    return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  }

  private markUserScroll(): void {
    if (this.state() !== 'ready' || !this.synced()) return;
    this.userScrolling.set(true);
    if (this.userScrollTimer) clearTimeout(this.userScrollTimer);
    this.userScrollTimer = setTimeout(() => {
      this.userScrollTimer = null;
      this.userScrolling.set(false);
      this.queueScroll(false);
    }, USER_SCROLL_PAUSE_MS);
  }

  private queueScroll(instant: boolean): void {
    if (typeof window === 'undefined') return;
    if (this.scrollTimer) clearTimeout(this.scrollTimer);
    this.scrollTimer = setTimeout(() => {
      this.scrollTimer = null;
      this.scrollToCurrent(instant);
    }, 0);
  }

  /** The element that actually scrolls: the host (fullscreen) or the panel's content area. */
  private scroller(): HTMLElement | null {
    if (typeof document === 'undefined') return null;
    for (let el: HTMLElement | null = this.host.nativeElement; el && el !== document.body; el = el.parentElement) {
      const oy = getComputedStyle(el).overflowY;
      if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight + 1) return el;
    }
    return null;
  }

  private scrollToCurrent(instant: boolean): void {
    if (this.destroyed || this.state() !== 'ready') return;
    const scroller = this.scroller();
    if (!scroller) return;
    this.watchScroller(scroller);
    if (this.userScrolling()) return;
    const behavior: ScrollBehavior = instant || this.reduced() ? 'auto' : 'smooth';
    if (!this.synced()) {
      if (instant) scroller.scrollTop = 0;
      return;
    }
    const gap = this.gapActive();
    const idx = this.activeIdx();
    const selector = idx >= 0 ? `[data-row="${idx}"]` : gap ? `[data-gap="${gap.beforeIndex}"]` : null;
    const target = selector ? this.host.nativeElement.querySelector<HTMLElement>(selector) : null;
    if (!target) {
      if (instant || idx < 0) scroller.scrollTo({ top: 0, behavior });
      return;
    }
    const box = scroller.getBoundingClientRect();
    const top = target.getBoundingClientRect().top - box.top + scroller.scrollTop;
    scroller.scrollTo({ top: Math.max(0, top - scroller.clientHeight / 3), behavior });
  }

  private watchScroller(el: HTMLElement): void {
    if (this.watched === el) return;
    this.unwatchScroller();
    this.watched = el;
    el.addEventListener('wheel', this.onUserScroll, { passive: true });
    el.addEventListener('touchmove', this.onUserScroll, { passive: true });
    el.addEventListener('keydown', this.onScrollKey);
    el.addEventListener('pointerdown', this.onScrollerPointer);
  }

  private unwatchScroller(): void {
    const el = this.watched;
    if (!el) return;
    el.removeEventListener('wheel', this.onUserScroll);
    el.removeEventListener('touchmove', this.onUserScroll);
    el.removeEventListener('keydown', this.onScrollKey);
    el.removeEventListener('pointerdown', this.onScrollerPointer);
    this.watched = null;
  }

  // ── 60 fps clock ────────────────────────────────────────────────────────
  private startClock(): void {
    if (this.raf || this.destroyed || typeof window === 'undefined' || (typeof document !== 'undefined' && document.hidden)) return;
    if (this.state() !== 'ready' || !this.synced()) return;
    this.lastPos = -1; // re-anchor on the first frame
    this.raf = requestAnimationFrame(this.tick);
  }

  private stopClock(): void {
    if (this.raf && typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private readonly tick = (now: number): void => {
    this.raf = 0;
    if (this.destroyed || (typeof document !== 'undefined' && document.hidden)) return;
    const pos = this.player.position();
    const jumped = pos !== this.lastPos;
    if (jumped) {
      this.lastPos = pos;
      this.anchor = { position: pos, at: now };
    }
    // Karaoke needs every frame; plain line sync is fine at ~10 Hz.
    if (jumped || this.fineClock() || now - this.lastTick >= 100) {
      const next = interpolatePosition(this.anchor, now, this.player.playing(), this.player.playbackRate(), this.player.duration());
      if (next !== this.clock()) this.clock.set(next);
      this.lastTick = now;
    }
    this.raf = requestAnimationFrame(this.tick);
  };
}
