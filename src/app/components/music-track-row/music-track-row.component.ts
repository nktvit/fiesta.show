import { Component, computed, DestroyRef, ElementRef, inject, input, OnInit } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MusicPlayerService, MusicQueueContext } from '../../services/music-player.service';
import { MusicSelectionService } from '../../services/music-selection.service';
import { MusicUiService } from '../../services/music-ui.service';
import { MusicLibraryItem, MusicTrack } from '../../services/music.service';
import { MusicLikeButtonComponent } from '../music-like-button/music-like-button.component';

/** Press-and-hold time that opens the menu (or enters select mode from the cover). */
const LONG_PRESS_MS = 500;
/** Finger travel that cancels a long press (it was a scroll). */
const LONG_PRESS_SLOP = 10;

/**
 * One song in a list. The cover/number cell is the play button; the artist and album are links.
 * Also: playing indicator, like heart, kebab + right-click/long-press menu, multi-select
 * (hover checkbox, Ctrl/Cmd-click toggle, Shift-click range, long-press the cover on touch).
 */
@Component({
  selector: 'app-music-track-row',
  imports: [RouterLink, MusicLikeButtonComponent],
  templateUrl: './music-track-row.component.html',
  host: { class: 'block' },
})
export class MusicTrackRowComponent implements OnInit {
  readonly track = input.required<MusicTrack>();
  /** The list this row belongs to - what next/previous walk through. */
  readonly queue = input.required<MusicTrack[]>();
  /** Show the cover art; albums show the track number instead. */
  readonly showCover = input(true);
  readonly showAlbum = input(true);
  readonly number = input<number | null>(null);
  /** Where the list came from ("Playing from ..."); optional. */
  readonly context = input<MusicQueueContext | null>(null);
  /** Whether the row takes part in multi-select (checkbox, Ctrl/Shift-click, long-press). */
  readonly selectable = input(true);

  protected readonly player = inject(MusicPlayerService);
  protected readonly ui = inject(MusicUiService);
  protected readonly selection = inject(MusicSelectionService);
  private el = inject<ElementRef<HTMLElement>>(ElementRef);
  private destroyRef = inject(DestroyRef);

  protected readonly current = computed(() => this.player.track()?.id === this.track().id);
  protected readonly active = computed(() => this.current() && this.player.playing());
  protected readonly item = computed<MusicLibraryItem>(() => ({ kind: 'track', data: this.track() }));
  protected readonly selected = computed(() => this.selectable() && this.selection.isSelected(this.track()));
  /** Checkboxes stay visible on every row once something is selected. */
  protected readonly selectMode = computed(() => this.selectable() && this.selection.active());
  protected readonly menuOpen = computed(() => {
    const m = this.ui.contextMenu();
    return !!m && m.source === 'row-kebab' && m.item.kind === 'track' && m.item.data.id === this.track().id;
  });

  private pressTimer: ReturnType<typeof setTimeout> | null = null;
  private pressStart = { x: 0, y: 0 };
  /** A long press just fired: swallow the click that follows the finger lifting. */
  private swallowClick = false;

  ngOnInit(): void {
    const host = this.el.nativeElement;
    // Capture phase, so a modifier-click selects instead of playing or following a link.
    const onClick = (e: MouseEvent) => this.onClickCapture(e);
    host.addEventListener('click', onClick, true);
    this.destroyRef.onDestroy(() => {
      host.removeEventListener('click', onClick, true);
      this.cancelPress();
    });
  }

  protected play(): void {
    if (this.current()) this.player.toggle();
    else void this.player.play(this.track(), this.queue(), this.context() ? { context: this.context() } : {});
  }

  protected time(s: number): string {
    return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  }

  // ── Menu ─────────────────────────────────────────────────────────────────

  protected openMenu(e: MouseEvent | KeyboardEvent | { x: number; y: number }, source = 'row'): void {
    // Acting on a selected row acts on the whole selection.
    const many = this.selected() && this.selection.count() > 1;
    this.ui.openContextMenu(this.item(), e, many ? this.selection.tracks() : undefined, many ? 'selection' : source);
  }

  protected onContextMenu(e: MouseEvent): void {
    e.preventDefault();
    this.cancelPress();
    this.openMenu(e);
  }

  protected onKebab(e: MouseEvent): void {
    e.stopPropagation();
    this.openMenu(e, 'row-kebab');
  }

  // ── Selection ────────────────────────────────────────────────────────────

  protected onCheckbox(e: Event): void {
    e.stopPropagation();
    if ((e as MouseEvent).shiftKey) this.selection.selectRange(this.track(), this.queue());
    else this.selection.toggle(this.track());
    // Keep the native state in step with the model (a range click may not flip this row).
    (e.target as HTMLInputElement).checked = this.selected();
  }

  private onClickCapture(e: MouseEvent): void {
    if (this.swallowClick) {
      this.swallowClick = false;
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (!this.selectable()) return;
    const target = e.target instanceof Element ? e.target : null;
    if (target?.closest('input[type=checkbox]')) return;
    if (e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      this.selection.selectRange(this.track(), this.queue());
    } else if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      e.stopPropagation();
      this.selection.toggle(this.track());
    } else if (this.selection.active() && !target?.closest('a,button,input')) {
      // In select mode a tap on the row's empty part toggles it.
      this.selection.toggle(this.track());
    }
  }

  // ── Long press (touch / pen) ─────────────────────────────────────────────

  protected onPointerDown(e: PointerEvent): void {
    // A fresh press means the click after the previous long press is already over.
    this.swallowClick = false;
    if (e.pointerType === 'mouse' || (e.button !== undefined && e.button > 0)) return;
    const target = e.target instanceof Element ? e.target : null;
    if (target?.closest('input,[data-no-press]')) return;
    const onCover = !!target?.closest('[data-cover]');
    this.cancelPress();
    this.pressStart = { x: e.clientX, y: e.clientY };
    this.pressTimer = setTimeout(() => {
      this.pressTimer = null;
      this.swallowClick = true;
      // Released without a click (finger slid away)? Don't leave the flag armed.
      setTimeout(() => (this.swallowClick = false), 800);
      if (onCover && this.selectable()) this.selection.select(this.track());
      else this.openMenu({ x: this.pressStart.x, y: this.pressStart.y }, 'row-press');
    }, LONG_PRESS_MS);
  }

  protected onPointerMove(e: PointerEvent): void {
    if (!this.pressTimer) return;
    if (Math.hypot(e.clientX - this.pressStart.x, e.clientY - this.pressStart.y) > LONG_PRESS_SLOP) this.cancelPress();
  }

  protected cancelPress(): void {
    if (this.pressTimer) clearTimeout(this.pressTimer);
    this.pressTimer = null;
  }
}
