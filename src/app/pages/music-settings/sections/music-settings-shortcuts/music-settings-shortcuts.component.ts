import { Component, computed, DestroyRef, inject, signal } from '@angular/core';
import {
  bindingFromEvent, formatBindingParts, isMacPlatform, MUSIC_SHORTCUT_GROUPS, MusicShortcutDef, MusicShortcutId,
  MusicShortcutsService,
} from '../../../../services/music-shortcuts.service';

/**
 * Music settings: Shortcuts section. Lists every action with its key; "Change"
 * captures the next key press, clashes are refused with a message, reset
 * restores Monochrome's defaults. Persisted by MusicShortcutsService
 * (settings.scoped('shortcuts')).
 */
@Component({
  selector: 'app-music-settings-shortcuts',
  templateUrl: './music-settings-shortcuts.component.html',
  host: { class: 'block' },
})
export class MusicSettingsShortcutsComponent {
  protected readonly shortcuts = inject(MusicShortcutsService);
  private readonly mac = isMacPlatform();

  /** The action waiting for a key press. */
  protected readonly listening = signal<MusicShortcutId | null>(null);
  protected readonly message = signal<{ text: string; warn: boolean } | null>(null);

  protected readonly groups = computed(() =>
    MUSIC_SHORTCUT_GROUPS.map((name) => ({
      name,
      rows: this.shortcuts.defs.filter((d) => d.group === name).map((def) => ({
        def,
        keys: formatBindingParts(this.shortcuts.binding(def.id), this.mac),
        custom: this.shortcuts.isCustom(def.id),
      })),
    })).filter((g) => g.rows.length),
  );

  private onKey = (e: KeyboardEvent): void => this.capture(e);

  constructor() {
    inject(DestroyRef).onDestroy(() => this.stop());
  }

  protected change(def: MusicShortcutDef): void {
    if (def.fixed) return;
    this.stop();
    this.message.set({ text: `Press the new key for "${def.label}", or Esc to cancel.`, warn: false });
    this.listening.set(def.id);
    this.shortcuts.suspended.set(true);
    document.addEventListener('keydown', this.onKey, true);
  }

  protected cancel(): void {
    this.stop();
    this.message.set(null);
  }

  protected reset(def: MusicShortcutDef): void {
    this.shortcuts.resetBinding(def.id);
    this.message.set({ text: `"${def.label}" is back to ${this.keyText(def.id)}.`, warn: false });
  }

  protected resetAll(): void {
    this.stop();
    this.shortcuts.resetAll();
    this.message.set({ text: 'All shortcuts are back to their defaults.', warn: false });
  }

  protected labelOf(id: MusicShortcutId): string {
    return this.shortcuts.defs.find((d) => d.id === id)?.label ?? id;
  }

  protected anyCustom(): boolean {
    return this.shortcuts.defs.some((d) => this.shortcuts.isCustom(d.id));
  }

  private keyText(id: MusicShortcutId): string {
    return formatBindingParts(this.shortcuts.binding(id), this.mac).join(this.mac ? '' : '+');
  }

  private capture(e: KeyboardEvent): void {
    const id = this.listening();
    if (!id || e.isComposing) return;
    if (e.key === 'Tab') {
      // Let focus move on; that abandons the capture.
      this.cancel();
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    if (e.repeat) return;
    if (e.key === 'Escape') {
      this.cancel();
      return;
    }
    const b = bindingFromEvent(e);
    if (!b) return; // a bare modifier: wait for the real key
    const res = this.shortcuts.setBinding(id, b);
    if (res.ok) {
      this.message.set({ text: `"${this.labelOf(id)}" is now ${this.keyText(id)}.`, warn: false });
      this.stop();
    } else {
      const other = this.labelOf(res.conflict);
      this.message.set({ text: `${formatBindingParts(b, this.mac).join(this.mac ? '' : '+')} is already used by "${other}". Press another key, or Esc to cancel.`, warn: true });
    }
  }

  private stop(): void {
    if (typeof document !== 'undefined') document.removeEventListener('keydown', this.onKey, true);
    this.listening.set(null);
    this.shortcuts.suspended.set(false);
  }
}
