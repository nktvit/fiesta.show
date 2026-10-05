import { Component, computed, DestroyRef, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Meta, Title } from '@angular/platform-browser';
import { ActivatedRoute, Router } from '@angular/router';
import { MusicSubnavComponent } from '../../components/music-subnav/music-subnav.component';
import { NavbarComponent } from '../../components/navbar/navbar.component';
import { MusicDownloadService } from '../../services/music-download.service';
import { MUSIC_SETTINGS_REGISTRY, MusicSettingEntry } from '../../services/music-settings-registry';
import { MusicSettingsService, MusicSettingsTab } from '../../services/music-settings.service';
import { IS_PREVIEW_OR_DEV } from '../../utils/deploy-env';
import { searchSettings } from '../../utils/music-settings-search';
import { MusicSettingsAudioComponent } from './sections/music-settings-audio/music-settings-audio.component';
import { MusicSettingsDataComponent } from './sections/music-settings-data/music-settings-data.component';
import { MusicSettingsDownloadsComponent } from './sections/music-settings-downloads/music-settings-downloads.component';
import { MusicSettingsInterfaceComponent } from './sections/music-settings-interface/music-settings-interface.component';
import { MusicSettingsLyricsComponent } from './sections/music-settings-lyrics/music-settings-lyrics.component';
import { MusicSettingsPlaybackComponent } from './sections/music-settings-playback/music-settings-playback.component';
import { MusicSettingsScrobblingComponent } from './sections/music-settings-scrobbling/music-settings-scrobbling.component';
import { MusicSettingsShortcutsComponent } from './sections/music-settings-shortcuts/music-settings-shortcuts.component';
import { MusicSettingsSystemComponent } from './sections/music-settings-system/music-settings-system.component';

const TABS: { id: MusicSettingsTab; label: string }[] = [
  { id: 'playback', label: 'Playback' },
  { id: 'audio', label: 'Audio' },
  { id: 'lyrics', label: 'Lyrics' },
  { id: 'interface', label: 'Interface' },
  { id: 'shortcuts', label: 'Shortcuts' },
  { id: 'downloads', label: 'Downloads' },
  { id: 'scrobbling', label: 'Scrobbling' },
  { id: 'data', label: 'Data' },
  { id: 'system', label: 'System' },
];

/**
 * Route /music/settings (?tab=playback|audio|lyrics|interface|shortcuts|downloads|scrobbling|data|system).
 * Owned by package P11 (F0 stub: tab strip + the nine section components).
 */
@Component({
  selector: 'app-music-settings',
  imports: [
    NavbarComponent, MusicSubnavComponent, MusicSettingsPlaybackComponent, MusicSettingsAudioComponent,
    MusicSettingsLyricsComponent, MusicSettingsInterfaceComponent, MusicSettingsShortcutsComponent,
    MusicSettingsDownloadsComponent, MusicSettingsScrobblingComponent, MusicSettingsDataComponent,
    MusicSettingsSystemComponent,
  ],
  templateUrl: './music-settings.component.html',
})
export class MusicSettingsComponent {
  private settings = inject(MusicSettingsService);
  private router = inject(Router);
  private pendingJump: string | null = null;
  private highlightTimer: ReturnType<typeof setTimeout> | null = null;
  private downloads = inject(MusicDownloadService);
  /** The Downloads tab (and its search entries) is hidden while the downloads switch is off. */
  protected readonly downloadsOn = this.downloads.enabled;
  /** The System tab (storage, cache clearing, API status, version) is for previews and local dev only. */
  protected readonly tabs = computed(() =>
    TABS.filter((t) => (t.id !== 'downloads' || this.downloads.enabled()) && (t.id !== 'system' || IS_PREVIEW_OR_DEV)),
  );
  protected readonly tab = signal<MusicSettingsTab>(this.visible(this.settings.lastSettingsTab()));
  protected readonly query = signal('');
  protected readonly active = signal(0);
  protected readonly results = computed<MusicSettingEntry[]>(() => {
    const registry = MUSIC_SETTINGS_REGISTRY.filter((e) => (e.tab !== 'downloads' || this.downloads.enabled()) && (e.tab !== 'system' || IS_PREVIEW_OR_DEV));
    return searchSettings(registry, this.query(), 8);
  });
  protected readonly tabLabel = (t: MusicSettingsTab) => TABS.find((x) => x.id === t)?.label ?? t;

  constructor() {
    inject(Title).setTitle('Music settings | Stream Fiesta');
    inject(Meta).updateTag({ name: 'description', content: 'Playback, audio, lyrics and library settings for music.' });
    inject(ActivatedRoute).queryParamMap.pipe(takeUntilDestroyed(inject(DestroyRef))).subscribe((p) => {
      const t = p.get('tab');
      const found = this.tabs().find((x) => x.id === t);
      if (found) {
        this.tab.set(found.id);
        this.settings.lastSettingsTab.set(found.id);
      }
      this.flushJump();
    });
    inject(DestroyRef).onDestroy(() => {
      if (this.highlightTimer) clearTimeout(this.highlightTimer);
    });
  }

  private visible(t: MusicSettingsTab): MusicSettingsTab {
    return (t === 'downloads' && !this.downloads.enabled()) || (t === 'system' && !IS_PREVIEW_OR_DEV) ? 'playback' : t;
  }

  protected select(t: MusicSettingsTab): void {
    void this.router.navigate([], { queryParams: { tab: t }, replaceUrl: true });
  }

  /** Roving focus for the tablist: arrows, Home and End move and activate. */
  protected onTabKey(e: KeyboardEvent, index: number): void {
    const tabs = this.tabs();
    const last = tabs.length - 1;
    let next = -1;
    if (e.key === 'ArrowRight') next = index === last ? 0 : index + 1;
    else if (e.key === 'ArrowLeft') next = index === 0 ? last : index - 1;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = last;
    if (next < 0) return;
    e.preventDefault();
    this.select(tabs[next].id);
    queueMicrotask(() => document.getElementById('music-settings-tab-' + tabs[next].id)?.focus());
  }

  protected onQuery(e: Event): void {
    this.query.set((e.target as HTMLInputElement).value);
    this.active.set(0);
  }

  protected onSearchKey(e: KeyboardEvent): void {
    const n = this.results().length;
    if (e.key === 'ArrowDown' && n) { e.preventDefault(); this.active.set((this.active() + 1) % n); }
    else if (e.key === 'ArrowUp' && n) { e.preventDefault(); this.active.set((this.active() + n - 1) % n); }
    else if (e.key === 'Enter' && n) { e.preventDefault(); this.jump(this.results()[this.active()]); }
    else if (e.key === 'Escape') { this.query.set(''); }
  }

  /** Opens the entry's tab, then scrolls to and highlights its row (when the row exists). */
  protected jump(entry: MusicSettingEntry): void {
    this.query.set('');
    this.pendingJump = 'setting-' + entry.id;
    if (this.tab() === entry.tab) {
      setTimeout(() => this.flushJump());
      return;
    }
    this.select(entry.tab);
  }

  private flushJump(): void {
    const id = this.pendingJump;
    if (!id || typeof document === 'undefined') return;
    // The section renders on the next change-detection pass after the tab changes.
    let tries = 0;
    const find = () => {
      // Entries without a row of their own (player-bar state, the visualizer) land on the section.
      const el = document.getElementById(id) ?? (tries >= 5 ? document.querySelector<HTMLElement>('#music-settings-panel section') : null);
      if (el) {
        this.pendingJump = null;
        const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
        el.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
        el.classList.add('ring-2', 'ring-indigo-400', 'bg-white/5');
        if (this.highlightTimer) clearTimeout(this.highlightTimer);
        this.highlightTimer = setTimeout(() => el.classList.remove('ring-2', 'ring-indigo-400', 'bg-white/5'), 2500);
      } else if (++tries < 10) {
        setTimeout(find, 50);
      } else {
        this.pendingJump = null;
      }
    };
    setTimeout(find, 0);
  }
}
