import { inject, Injectable } from '@angular/core';
import { Router } from '@angular/router';
import { MUSIC_VIZ_PRESETS, nextPreset, prevPreset, stepPreset, toggleCycle } from '../utils/music-visualizer-presets';
import { MusicDownloadService } from './music-download.service';
import { MusicLibraryService } from './music-library.service';
import { MusicPlayerService } from './music-player.service';
import { MusicSelectionService } from './music-selection.service';
import { MusicSettingsService, MusicSettingsTab } from './music-settings.service';
import { MusicToastService } from './music-toast.service';
import { MusicUiService } from './music-ui.service';
import { IS_PREVIEW_OR_DEV } from '../utils/deploy-env';

/** Ids of the rebindable keyboard actions (see MUSIC_SHORTCUTS in music-shortcuts.service.ts). */
export type MusicShortcutId =
  | 'playPause' | 'seekForward' | 'seekBackward' | 'nextTrack' | 'previousTrack' | 'volumeUp' | 'volumeDown'
  | 'mute' | 'shuffle' | 'repeat' | 'queue' | 'lyrics' | 'search' | 'escape'
  | 'visualizerNext' | 'visualizerPrev' | 'visualizerCycle' | 'help' | 'palette';

export type MusicCommandGroup =
  | 'Navigation' | 'Playback' | 'Queue' | 'Library' | 'Lyrics' | 'View' | 'Sleep timer' | 'Visualizer' | 'Settings';

export interface MusicCommand {
  id: string;
  label: string;
  group: MusicCommandGroup;
  /** Extra words the fuzzy search also matches. */
  keywords: string[];
  run: () => void | Promise<void>;
  /** The keyboard action that triggers the same command. */
  shortcutId?: MusicShortcutId;
  /** Hidden from the palette (and a no-op for shortcuts) when this returns false. */
  available?: () => boolean;
}

const GROUP_ORDER: MusicCommandGroup[] = [
  'Playback', 'Navigation', 'Queue', 'Library', 'Lyrics', 'View', 'Sleep timer', 'Visualizer', 'Settings',
];

const SETTINGS_TABS: { id: MusicSettingsTab; label: string }[] = [
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
 * The registry of everything the user can do by name or by key. The command
 * palette lists and runs these; MusicShortcutsService runs the ones that carry
 * a `shortcutId` when their key is pressed.
 */
@Injectable({ providedIn: 'root' })
export class MusicCommandsService {
  private router = inject(Router);
  private player = inject(MusicPlayerService);
  private library = inject(MusicLibraryService);
  private settings = inject(MusicSettingsService);
  private ui = inject(MusicUiService);
  private toast = inject(MusicToastService);
  private selection = inject(MusicSelectionService);
  private downloads = inject(MusicDownloadService);

  private readonly list: MusicCommand[] = this.build();

  /** Every command, grouped in display order. */
  all(): MusicCommand[] {
    return this.list;
  }

  /** The commands that apply right now (e.g. "Like current track" needs a track). */
  available(): MusicCommand[] {
    return this.list.filter((c) => !c.available || c.available());
  }

  get(id: string): MusicCommand | undefined {
    return this.list.find((c) => c.id === id);
  }

  byShortcut(id: MusicShortcutId): MusicCommand | undefined {
    return this.list.find((c) => c.shortcutId === id);
  }

  /** Runs a command by id; false when unknown or not available. */
  async run(id: string): Promise<boolean> {
    const c = this.get(id);
    if (!c || (c.available && !c.available())) return false;
    try {
      await c.run();
    } catch (e) {
      console.error('music command failed', id, e);
      this.toast.show({ message: `${c.label} didn't work`, tone: 'warn' });
    }
    return true;
  }

  // ── The registry ─────────────────────────────────────────────────────────

  private build(): MusicCommand[] {
    const p = this.player;
    const hasTrack = () => p.track() !== null;
    const go = (path: string) => () => void this.router.navigateByUrl(path);
    const goSettings = (tab: MusicSettingsTab) => () => void this.router.navigate(['/music/settings'], { queryParams: { tab } });
    const cmds: MusicCommand[] = [];
    const add = (c: MusicCommand) => cmds.push(c);

    // Playback
    add({ id: 'play-pause', label: 'Play / Pause', group: 'Playback', keywords: ['toggle', 'resume', 'stop'], shortcutId: 'playPause', available: hasTrack, run: () => p.toggle() });
    add({ id: 'play-next', label: 'Next track', group: 'Playback', keywords: ['skip', 'forward'], shortcutId: 'nextTrack', available: hasTrack, run: () => p.next() });
    add({ id: 'play-prev', label: 'Previous track', group: 'Playback', keywords: ['back', 'restart'], shortcutId: 'previousTrack', available: hasTrack, run: () => p.prev() });
    add({ id: 'seek-forward', label: 'Seek forward 10 seconds', group: 'Playback', keywords: ['skip ahead', 'fast forward'], shortcutId: 'seekForward', available: hasTrack, run: () => p.seekBy(10) });
    add({ id: 'seek-backward', label: 'Seek backward 10 seconds', group: 'Playback', keywords: ['rewind', 'skip back'], shortcutId: 'seekBackward', available: hasTrack, run: () => p.seekBy(-10) });
    add({ id: 'vol-up', label: 'Volume up', group: 'Playback', keywords: ['louder', 'increase'], shortcutId: 'volumeUp', run: () => p.setVolume(Math.round((p.volume() + 0.05) * 100) / 100) });
    add({ id: 'vol-down', label: 'Volume down', group: 'Playback', keywords: ['quieter', 'decrease'], shortcutId: 'volumeDown', run: () => p.setVolume(Math.round((p.volume() - 0.05) * 100) / 100) });
    add({ id: 'play-mute', label: 'Mute / Unmute', group: 'Playback', keywords: ['silence', 'sound'], shortcutId: 'mute', run: () => p.toggleMute() });
    add({ id: 'play-shuffle', label: 'Toggle shuffle', group: 'Playback', keywords: ['random', 'mix up'], shortcutId: 'shuffle', run: () => p.toggleShuffle() });
    add({ id: 'play-repeat', label: 'Cycle repeat mode', group: 'Playback', keywords: ['loop', 'repeat one', 'repeat all'], shortcutId: 'repeat', run: () => p.cycleRepeat() });
    add({
      id: 'like-current', label: 'Like current track', group: 'Playback', keywords: ['love', 'favorite', 'heart'], available: hasTrack,
      run: () => {
        const t = p.track();
        if (!t) return;
        const liked = this.library.toggleFavorite({ kind: 'track', data: t });
        this.toast.show({ message: liked ? 'Added to Liked' : 'Removed from Liked' });
      },
    });
    add({
      id: 'start-radio', label: 'Start radio from current track', group: 'Playback', keywords: ['station', 'similar', 'autoplay'], available: hasTrack,
      run: () => {
        const t = p.track();
        return t ? p.startRadio({ kind: 'track', id: t.id, label: t.title }) : undefined;
      },
    });
    add({ id: 'now-playing', label: 'Open Now Playing', group: 'Playback', keywords: ['fullscreen', 'cover', 'player'], available: hasTrack, run: () => this.ui.openNowPlaying() });

    // Navigation
    add({ id: 'nav-home', label: 'Go to Music home', group: 'Navigation', keywords: ['search', 'discover'], run: go('/music') });
    add({ id: 'nav-explore', label: 'Go to Explore', group: 'Navigation', keywords: ['browse', 'genres', 'moods'], run: go('/music/explore') });
    add({ id: 'nav-library', label: 'Go to Library', group: 'Navigation', keywords: ['liked', 'playlists', 'favorites', 'saved'], run: go('/music/library') });
    add({ id: 'nav-recent', label: 'Go to Recently played', group: 'Navigation', keywords: ['history'], run: go('/music/recent') });
    add({ id: 'nav-settings', label: 'Go to Settings', group: 'Navigation', keywords: ['preferences', 'options'], run: go('/music/settings') });
    add({
      id: 'nav-artist', label: 'Go to current artist', group: 'Navigation', keywords: ['artist page'],
      available: () => !!p.track()?.artistId,
      run: () => void this.router.navigate(['/music/artist', p.track()?.artistId]),
    });
    add({
      id: 'nav-album', label: 'Go to current album', group: 'Navigation', keywords: ['album page'],
      available: () => !!p.track()?.albumId,
      run: () => void this.router.navigate(['/music/album', p.track()?.albumId]),
    });
    add({
      id: 'focus-search', label: 'Focus search', group: 'Navigation', keywords: ['find', 'query'], shortcutId: 'search',
      run: () => this.focusSearch(),
    });

    // Queue
    add({ id: 'queue-open', label: 'Toggle queue', group: 'Queue', keywords: ['up next', 'open queue'], shortcutId: 'queue', run: () => this.ui.togglePanel('queue') });
    add({ id: 'queue-clear', label: 'Clear upcoming queue', group: 'Queue', keywords: ['wipe', 'empty'], available: hasTrack, run: () => p.clearUpcoming() });
    add({
      id: 'queue-like-all', label: 'Like all tracks in queue', group: 'Queue', keywords: ['love', 'save queue'], available: () => p.queue().length > 0,
      run: () => {
        const n = this.library.addFavorites(p.queue().map((data) => ({ kind: 'track' as const, data })));
        this.toast.show({ message: n ? `Liked ${n} ${n === 1 ? 'track' : 'tracks'}` : 'Everything in the queue is already liked' });
      },
    });
    add({
      id: 'queue-download', label: 'Download queue', group: 'Queue', keywords: ['zip', 'save offline'],
      available: () => this.downloads.enabled() && p.queue().length > 0,
      run: () => this.downloads.downloadTracks(p.queue(), { name: 'Queue', kind: 'queue' }),
    });

    // Library
    add({ id: 'lib-import', label: 'Import playlist…', group: 'Library', keywords: ['spotify', 'csv', 'm3u', 'upload'], run: () => this.ui.openImport() });
    add({
      id: 'select-clear', label: 'Clear selection', group: 'Library', keywords: ['deselect'],
      available: () => this.selection.count() > 0, run: () => this.selection.clear(),
    });

    // Lyrics
    add({ id: 'lyrics-toggle', label: 'Toggle lyrics', group: 'Lyrics', keywords: ['words', 'karaoke'], shortcutId: 'lyrics', run: () => this.ui.togglePanel('lyrics') });
    add({ id: 'lyrics-open', label: 'Open lyrics…', group: 'Lyrics', keywords: ['words', 'karaoke', 'show lyrics'], run: () => this.ui.openPanel('lyrics') });

    // View
    add({ id: 'help-shortcuts', label: 'Keyboard shortcuts', group: 'View', keywords: ['hotkeys', 'keys', 'help', 'cheat sheet'], shortcutId: 'help', run: () => this.ui.openShortcutsHelp() });
    add({ id: 'view-reduce-blur', label: 'Toggle reduced blur', group: 'View', keywords: ['performance', 'transparency', 'glass'], run: () => this.toggleSetting('reduceBlur', 'Reduced blur') });
    add({ id: 'view-compact', label: 'Toggle compact grids', group: 'View', keywords: ['dense', 'smaller covers'], run: () => this.toggleSetting('compactGrids', 'Compact grids') });
    add({ id: 'view-dynamic-color', label: 'Toggle dynamic color', group: 'View', keywords: ['accent', 'cover colors', 'theme'], run: () => this.toggleSetting('dynamicColor', 'Dynamic color') });
    add({ id: 'close-overlays', label: 'Close dialogs and panels', group: 'View', keywords: ['escape', 'dismiss'], shortcutId: 'escape', run: () => this.closeOverlays() });

    // Sleep timer
    add({ id: 'sleep-open', label: 'Sleep timer…', group: 'Sleep timer', keywords: ['bedtime', 'timer', 'stop later'], run: () => this.ui.openSleepTimer() });
    for (const min of [15, 30, 60, 120]) {
      const label = min >= 60 ? `${min / 60} hour${min > 60 ? 's' : ''}` : `${min} min`;
      add({
        id: `sleep-${min}`, label: `Sleep timer ${label}`, group: 'Sleep timer', keywords: ['bedtime', 'timer', 'stop after', String(min)],
        run: () => { p.setSleepTimer(min); this.toast.show({ message: `Sleep timer set for ${label}` }); },
      });
    }
    add({ id: 'sleep-end', label: 'Sleep timer end of track', group: 'Sleep timer', keywords: ['bedtime', 'timer', 'after this song'], run: () => { p.setSleepTimer('end-of-track'); this.toast.show({ message: 'Pausing after this track' }); } });
    add({
      id: 'sleep-cancel', label: 'Cancel sleep timer', group: 'Sleep timer', keywords: ['timer off', 'stop timer'],
      available: () => p.sleep().endsAt !== null || p.sleep().endOfTrack,
      run: () => { p.setSleepTimer(null); this.toast.show({ message: 'Sleep timer cancelled' }); },
    });

    // Visualizer
    add({
      id: 'vis-toggle', label: 'Toggle visualizer', group: 'Visualizer', keywords: ['butterchurn', 'animation', 'effects'],
      run: () => this.toggleSetting('visualizerEnabled', 'Visualizer'),
    });
    add({ id: 'vis-next', label: 'Next visualizer preset', group: 'Visualizer', keywords: ['change'], shortcutId: 'visualizerNext', run: () => this.stepVisualizer(1) });
    add({ id: 'vis-prev', label: 'Previous visualizer preset', group: 'Visualizer', keywords: ['change'], shortcutId: 'visualizerPrev', run: () => this.stepVisualizer(-1) });
    add({
      id: 'vis-cycle', label: 'Toggle visualizer auto-cycle', group: 'Visualizer', keywords: ['rotate', 'auto change'], shortcutId: 'visualizerCycle',
      run: () => {
        const on = toggleCycle();
        if (on !== null) this.toast.show({ message: on ? 'Visualizer auto-cycle on' : 'Visualizer auto-cycle off' });
      },
    });
    for (const preset of MUSIC_VIZ_PRESETS) {
      add({
        id: `vis-${preset.id}`, label: `Visualizer: ${preset.label}`, group: 'Visualizer', keywords: ['preset'],
        run: () => { this.settings.visualizerPreset.set(preset.id); this.settings.visualizerEnabled.set(true); },
      });
    }

    // Settings
    add({ id: 'settings-search', label: 'Search settings…', group: 'Settings', keywords: ['find setting', 'option', '>'], run: go('/music/settings') });
    for (const tab of SETTINGS_TABS.filter((t) => (t.id !== 'system' || IS_PREVIEW_OR_DEV) && t.id !== 'data')) {
      if (tab.id === 'downloads' && !this.downloads.enabled()) continue;
      add({ id: `settings-${tab.id}`, label: `Settings: ${tab.label}`, group: 'Settings', keywords: ['preferences', tab.id], run: goSettings(tab.id) });
    }

    // Global keys that are not "commands" in the palette sense still need an entry so rebinding can reach them.
    add({ id: 'palette-toggle', label: 'Command palette', group: 'View', keywords: ['commands', 'quick actions'], shortcutId: 'palette', run: () => this.ui.togglePalette() });

    return cmds.sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group));
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private toggleSetting(key: 'reduceBlur' | 'compactGrids' | 'dynamicColor' | 'visualizerEnabled', label: string): void {
    const s = this.settings[key];
    s.set(!s());
    this.toast.show({ message: `${label} ${s() ? 'on' : 'off'}` });
  }

  private stepVisualizer(dir: 1 | -1): void {
    const id = dir === 1 ? nextPreset() : prevPreset();
    // No visualizer mounted yet: just move the saved preset so the next one that opens uses it.
    if (id === null) this.settings.visualizerPreset.set(stepPreset(this.settings.visualizerPreset(), dir));
  }

  private closeOverlays(): void {
    if (this.ui.anyOpen()) this.ui.closeAll();
    else if (this.selection.count() > 0) this.selection.clear();
  }

  private focusSearch(): void {
    const find = () => document.querySelector<HTMLInputElement>('input[name=q], input[type=search]');
    const el = find();
    if (el) {
      el.focus();
      el.select();
      return;
    }
    void this.router.navigateByUrl('/music').then(() => setTimeout(() => find()?.focus(), 150));
  }
}
