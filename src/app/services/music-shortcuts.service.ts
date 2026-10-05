import { computed, inject, Injectable, signal } from '@angular/core';
import { Router } from '@angular/router';
import { MusicCommandsService, MusicShortcutId } from './music-commands.service';
import { MusicPlayerService } from './music-player.service';
import { MusicSettingsService } from './music-settings.service';
import { MusicUiService } from './music-ui.service';

export type { MusicShortcutId } from './music-commands.service';

/** One key combination. `key` is KeyboardEvent.key lower-cased (' ' for Space). */
export interface MusicKeyBinding {
  key: string;
  shift: boolean;
  ctrl: boolean;
  alt: boolean;
}

export type MusicShortcutGroup = 'Playback' | 'Navigation' | 'View' | 'Visualizer';

export interface MusicShortcutDef {
  id: MusicShortcutId;
  label: string;
  group: MusicShortcutGroup;
  /** Monochrome's default (Ctrl also means Cmd). */
  binding: MusicKeyBinding;
  /** Can't be rebound (Escape is how a rebind is cancelled). */
  fixed?: boolean;
}

const k = (key: string, mods: Partial<Omit<MusicKeyBinding, 'key'>> = {}): MusicKeyBinding => ({
  key, shift: false, ctrl: false, alt: false, ...mods,
});

/** Monochrome's DEFAULT_SHORTCUTS (multi-select entries dropped: those are click modifiers) plus help and palette. */
export const MUSIC_SHORTCUTS: readonly MusicShortcutDef[] = [
  { id: 'playPause', label: 'Play / Pause', group: 'Playback', binding: k(' ') },
  { id: 'seekForward', label: 'Seek forward 10s', group: 'Playback', binding: k('arrowright') },
  { id: 'seekBackward', label: 'Seek backward 10s', group: 'Playback', binding: k('arrowleft') },
  { id: 'nextTrack', label: 'Next track', group: 'Playback', binding: k('arrowright', { shift: true }) },
  { id: 'previousTrack', label: 'Previous track', group: 'Playback', binding: k('arrowleft', { shift: true }) },
  { id: 'volumeUp', label: 'Volume up', group: 'Playback', binding: k('arrowup') },
  { id: 'volumeDown', label: 'Volume down', group: 'Playback', binding: k('arrowdown') },
  { id: 'mute', label: 'Mute / Unmute', group: 'Playback', binding: k('m') },
  { id: 'shuffle', label: 'Toggle shuffle', group: 'Playback', binding: k('s') },
  { id: 'repeat', label: 'Toggle repeat', group: 'Playback', binding: k('r') },
  { id: 'queue', label: 'Open queue', group: 'View', binding: k('q') },
  { id: 'lyrics', label: 'Toggle lyrics', group: 'View', binding: k('l') },
  { id: 'search', label: 'Focus search', group: 'Navigation', binding: k('/') },
  { id: 'palette', label: 'Command palette', group: 'Navigation', binding: k('k', { ctrl: true }) },
  { id: 'help', label: 'Show keyboard shortcuts', group: 'Navigation', binding: k('?') },
  { id: 'escape', label: 'Close dialogs and panels', group: 'Navigation', binding: k('escape'), fixed: true },
  { id: 'visualizerNext', label: 'Next visualizer preset', group: 'Visualizer', binding: k(']') },
  { id: 'visualizerPrev', label: 'Previous visualizer preset', group: 'Visualizer', binding: k('[') },
  { id: 'visualizerCycle', label: 'Toggle visualizer auto-cycle', group: 'Visualizer', binding: k('\\') },
];

export const MUSIC_SHORTCUT_GROUPS: readonly MusicShortcutGroup[] = ['Playback', 'View', 'Navigation', 'Visualizer'];

/** Held-down repeats are fine for these. */
const REPEATABLE: ReadonlySet<MusicShortcutId> = new Set(['seekForward', 'seekBackward', 'volumeUp', 'volumeDown']);

const MODIFIER_KEYS = new Set(['shift', 'control', 'alt', 'meta', 'altgraph', 'capslock', 'os', 'fn', 'dead', 'unidentified']);

/** Single characters other than letters/digits: their Shift state follows the keyboard layout, so it is not part of the binding. */
function isSymbol(key: string): boolean {
  return key.length === 1 && !/[a-z0-9]/i.test(key);
}

type KeyLike = Pick<KeyboardEvent, 'key' | 'shiftKey' | 'ctrlKey' | 'metaKey' | 'altKey'>;

/** The binding a key press stands for, or null for a bare modifier / dead key. */
export function bindingFromEvent(e: KeyLike): MusicKeyBinding | null {
  const key = (e.key ?? '').toLowerCase();
  if (!key || MODIFIER_KEYS.has(key)) return null;
  return { key, shift: isSymbol(key) ? false : e.shiftKey, ctrl: e.ctrlKey || e.metaKey, alt: e.altKey };
}

export function bindingsEqual(a: MusicKeyBinding, b: MusicKeyBinding): boolean {
  return a.key === b.key && a.shift === b.shift && a.ctrl === b.ctrl && a.alt === b.alt;
}

export function bindingMatches(b: MusicKeyBinding, e: KeyLike): boolean {
  const p = bindingFromEvent(e);
  return p !== null && bindingsEqual(b, p);
}

const KEY_NAMES: Record<string, string> = {
  ' ': 'Space', arrowright: '→', arrowleft: '←', arrowup: '↑', arrowdown: '↓', escape: 'Esc', enter: 'Enter',
  tab: 'Tab', backspace: 'Backspace', delete: 'Del', pageup: 'PgUp', pagedown: 'PgDn', home: 'Home', end: 'End',
};

/** Parts to draw as separate keycaps: ['Ctrl', 'K'], ['Shift', '→']. */
export function formatBindingParts(b: MusicKeyBinding, mac = false): string[] {
  const parts: string[] = [];
  if (b.ctrl) parts.push(mac ? '⌘' : 'Ctrl');
  if (b.alt) parts.push(mac ? '⌥' : 'Alt');
  if (b.shift) parts.push(mac ? '⇧' : 'Shift');
  parts.push(KEY_NAMES[b.key] ?? (b.key.length === 1 ? b.key.toUpperCase() : b.key[0].toUpperCase() + b.key.slice(1)));
  return parts;
}

export function formatBinding(b: MusicKeyBinding, mac = false): string {
  return formatBindingParts(b, mac).join(mac ? '' : '+');
}

export function isMacPlatform(): boolean {
  return typeof navigator !== 'undefined' && /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent || '');
}

/** Another action that already uses `b`, if any. */
export function findConflict(
  resolved: Readonly<Record<MusicShortcutId, MusicKeyBinding>>,
  id: MusicShortcutId,
  b: MusicKeyBinding,
): MusicShortcutId | null {
  for (const def of MUSIC_SHORTCUTS) {
    if (def.id !== id && bindingsEqual(resolved[def.id], b)) return def.id;
  }
  return null;
}

/** Keeps only well-formed overrides for known, rebindable actions. */
export function sanitizeOverrides(raw: unknown): Partial<Record<MusicShortcutId, MusicKeyBinding>> {
  const out: Partial<Record<MusicShortcutId, MusicKeyBinding>> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const def of MUSIC_SHORTCUTS) {
    if (def.fixed) continue;
    const v = (raw as Record<string, unknown>)[def.id] as Partial<MusicKeyBinding> | undefined;
    if (!v || typeof v.key !== 'string' || !v.key || v.key.length > 24 || MODIFIER_KEYS.has(v.key.toLowerCase())) continue;
    out[def.id] = {
      key: v.key.toLowerCase(),
      shift: isSymbol(v.key) ? false : v.shift === true,
      ctrl: v.ctrl === true,
      alt: v.alt === true,
    };
  }
  return out;
}

const NON_TEXT_INPUTS = new Set(['checkbox', 'radio', 'range', 'button', 'submit', 'reset', 'image', 'file', 'color']);

/** Whether the key press would be typing into something. */
function isTextTarget(el: Element | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true;
  if (el instanceof HTMLInputElement) return !NON_TEXT_INPUTS.has(el.type);
  return el.isContentEditable;
}

const OWN_KEY_WIDGETS =
  '[role=slider],[role=menu],[role=listbox],[role=tablist],[role=radiogroup],[role=combobox],[role=spinbutton],[role=grid],[role=tree],input[type=range],audio,video';
const ACTIVATES_ON_SPACE =
  'button,a[href],summary,[role=button],[role=menuitem],[role=tab],[role=checkbox],[role=switch],[role=option],input[type=checkbox],input[type=radio]';

/** A modal that is not one of ours (the movie/TV pages' own dialogs). */
function foreignDialogOpen(): boolean {
  if (typeof document === 'undefined') return false;
  for (const d of Array.from(document.querySelectorAll('[role="dialog"][aria-modal="true"]'))) {
    let el: Element | null = d;
    let ours = false;
    while (el) {
      if (el.tagName.startsWith('APP-MUSIC-')) { ours = true; break; }
      el = el.parentElement;
    }
    if (!ours) return true;
  }
  return false;
}

const MUSIC_URL = /^\/music(?:[/?#]|$)/;
const VIDEO_URL = /^\/(?:movie|tv)(?:[/?#]|$)/;

/**
 * Global music keyboard shortcuts: one keydown listener on `document`, bindings
 * from Monochrome's defaults plus the visitor's overrides
 * (settings.scoped('shortcuts'), i.e. `fiesta:music:shortcuts`).
 */
@Injectable({ providedIn: 'root' })
export class MusicShortcutsService {
  private router = inject(Router);
  private player = inject(MusicPlayerService);
  private ui = inject(MusicUiService);
  private commands = inject(MusicCommandsService);
  private overrides = inject(MusicSettingsService).scoped<Partial<Record<MusicShortcutId, MusicKeyBinding>>>('shortcuts', {});
  private started = false;

  readonly defs = MUSIC_SHORTCUTS;

  /** While true no shortcut fires (the Settings "Change" key capture is listening). */
  readonly suspended = signal(false);

  /** Every action's current binding (default or override). */
  readonly bindings = computed(() => {
    const over = sanitizeOverrides(this.overrides());
    const out = {} as Record<MusicShortcutId, MusicKeyBinding>;
    for (const d of MUSIC_SHORTCUTS) out[d.id] = over[d.id] ?? d.binding;
    return out;
  });

  /** Attaches the global keydown listener. Called once by MusicStartupService. */
  start(): void {
    if (this.started || typeof document === 'undefined') return;
    this.started = true;
    document.addEventListener('keydown', (e) => this.onKeydown(e));
  }

  binding(id: MusicShortcutId): MusicKeyBinding {
    return this.bindings()[id];
  }

  isCustom(id: MusicShortcutId): boolean {
    const def = MUSIC_SHORTCUTS.find((d) => d.id === id);
    return !!def && !bindingsEqual(this.binding(id), def.binding);
  }

  /** The action that already has `b`, or null. */
  conflictFor(id: MusicShortcutId, b: MusicKeyBinding): MusicShortcutId | null {
    return findConflict(this.bindings(), id, b);
  }

  /** Rebinds an action. Refuses (and returns the clashing action) when another action has that key. */
  setBinding(id: MusicShortcutId, b: MusicKeyBinding): { ok: true } | { ok: false; conflict: MusicShortcutId } {
    const def = MUSIC_SHORTCUTS.find((d) => d.id === id);
    if (!def || def.fixed) return { ok: false, conflict: id };
    const conflict = this.conflictFor(id, b);
    if (conflict) return { ok: false, conflict };
    const next = { ...sanitizeOverrides(this.overrides()) };
    if (bindingsEqual(b, def.binding)) delete next[id];
    else next[id] = { ...b };
    this.overrides.set(next);
    return { ok: true };
  }

  resetBinding(id: MusicShortcutId): void {
    const next = { ...sanitizeOverrides(this.overrides()) };
    delete next[id];
    this.overrides.set(next);
  }

  resetAll(): void {
    this.overrides.set({});
  }

  /** Runs an action as if its key had been pressed. */
  runAction(id: MusicShortcutId): void {
    const cmd = this.commands.byShortcut(id);
    if (cmd) void this.commands.run(cmd.id);
  }

  /** Shortcuts apply on /music*, or anywhere with a track loaded except the movie and TV pages. */
  isActiveHere(): boolean {
    const url = this.router.url;
    if (MUSIC_URL.test(url)) return true;
    if (VIDEO_URL.test(url)) return false;
    return this.player.track() !== null;
  }

  // ── Key handling ─────────────────────────────────────────────────────────

  private onKeydown(e: KeyboardEvent): void {
    if (e.defaultPrevented || e.isComposing || this.suspended()) return;
    if (!this.isActiveHere() || foreignDialogOpen()) return;

    const pressed = bindingFromEvent(e);
    if (!pressed) return;
    const id = MUSIC_SHORTCUTS.find((d) => bindingsEqual(this.binding(d.id), pressed))?.id;
    if (!id) return;

    const target = e.target instanceof Element ? e.target : null;
    const typing = isTextTarget(target);

    // Escape in a page text field just leaves the field (Monochrome blurs the search box).
    if (id === 'escape' && typing) {
      if (!target?.closest('[role=dialog]') && target instanceof HTMLElement) target.blur();
      return;
    }
    // The palette key works from inside a text field (it needs a modifier); everything else stays out of the way.
    if (typing && id !== 'palette') return;
    if (e.repeat && !REPEATABLE.has(id)) return;

    if (target) {
      if (pressed.key === ' ' && target.closest(ACTIVATES_ON_SPACE)) return;
      if (/^arrow/.test(pressed.key) && target.closest(OWN_KEY_WIDGETS)) return;
    }

    // While one of our dialogs or menus is open only Escape and the palette key apply.
    if (this.modalOpen() && id !== 'escape' && id !== 'palette') return;

    const cmd = this.commands.byShortcut(id);
    if (!cmd) return;
    if (cmd.available && !cmd.available()) return;
    e.preventDefault();
    void this.commands.run(cmd.id);
  }

  private modalOpen(): boolean {
    const ui = this.ui;
    return ui.paletteOpen() || ui.shortcutsHelpOpen() || ui.trackInfo() !== null || ui.addToPlaylist() !== null
      || ui.importOpen() || ui.sleepTimerOpen() || ui.contextMenu() !== null;
  }
}
