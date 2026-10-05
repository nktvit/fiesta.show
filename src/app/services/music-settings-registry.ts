import { MusicSettingsTab } from './music-settings.service';

/** One searchable setting (palette ">" mode and the in-page settings search). */
export interface MusicSettingEntry {
  id: string;
  label: string;
  tab: MusicSettingsTab;
  keywords: string[];
  description?: string;
}

const e = (id: string, tab: MusicSettingsTab, label: string, keywords: string[], description?: string): MusicSettingEntry =>
  description ? { id, label, tab, keywords, description } : { id, label, tab, keywords };

/**
 * Static list of every music setting. An entry's `id` is the typed setting key
 * (or `home-<section>` for home sections); rows in P11's sections carry
 * `id="setting-<id>"`, so search can scroll to them. Entries for sections owned
 * by other packages open that tab. Owned by package P11.
 */
export const MUSIC_SETTINGS_REGISTRY: MusicSettingEntry[] = [
  // Playback
  e('quality', 'playback', 'Streaming quality', ['quality', 'auto', 'low', 'high', 'lossless', 'hi-res', 'bitrate', 'data'], 'Auto, Low, High, Lossless or Hi-Res'),
  e('gapless', 'playback', 'Gapless playback', ['gapless', 'preload', 'pause', 'between tracks']),
  e('crossfadeSeconds', 'playback', 'Crossfade', ['crossfade', 'fade', 'blend', 'transition', 'seconds']),
  e('autoplay', 'playback', 'Autoplay similar music', ['autoplay', 'radio', 'similar', 'endless', 'queue end']),
  e('skipUnavailable', 'playback', 'Skip unavailable tracks', ['skip', 'unavailable', 'error', 'blocked']),
  e('replayGainMode', 'playback', 'ReplayGain', ['replaygain', 'loudness', 'normalize', 'volume leveling', 'track', 'album']),
  e('replayGainPreamp', 'playback', 'ReplayGain pre-amp', ['preamp', 'pre-amp', 'gain', 'db', 'loudness']),
  e('exponentialVolume', 'playback', 'Exponential volume', ['exponential', 'volume curve', 'logarithmic', 'quiet']),
  e('playbackRate', 'playback', 'Default speed', ['speed', 'tempo', 'rate', 'playback rate']),
  e('preservesPitch', 'playback', 'Keep pitch', ['pitch', 'preserve', 'speed', 'chipmunk']),
  e('sleepFadeOut', 'playback', 'Fade out with sleep timer', ['sleep', 'timer', 'fade out', 'bedtime']),
  e('removeSilence', 'playback', 'Remove silence', ['silence', 'skip silence', 'trim', 'gaps']),
  e('volume', 'playback', 'Volume', ['volume', 'loudness', 'level']),
  e('muted', 'playback', 'Muted', ['mute', 'silent', 'sound off']),
  e('shuffle', 'playback', 'Shuffle', ['shuffle', 'random', 'order']),
  e('repeat', 'playback', 'Repeat', ['repeat', 'loop', 'one', 'all']),

  // Audio (P4)
  e('eq', 'audio', 'Equalizer', ['equalizer', 'eq', 'bands', 'bass', 'treble', 'graphic', 'parametric', 'preset']),
  e('autoeq', 'audio', 'AutoEQ headphone correction', ['autoeq', 'headphones', 'correction', 'profile', 'oratory']),
  e('dsp', 'audio', 'Stereo and headphones', ['mono', 'stereo', 'crossfeed', 'balance', 'dsp', 'width']),
  e('visualizerEnabled', 'audio', 'Visualizer', ['visualizer', 'milkdrop', 'butterchurn', 'spectrum', 'animation']),
  e('visualizerPreset', 'audio', 'Visualizer preset', ['visualizer', 'preset', 'particles', 'style']),

  // Lyrics (P3)
  e('lyrics', 'lyrics', 'Lyrics sources and display', ['lyrics', 'provider', 'source', 'karaoke', 'blur', 'translate', 'romanize', 'language']),

  // Interface
  e('coverClickAction', 'interface', 'Cover click action', ['cover', 'click', 'player bar', 'now playing', 'album']),
  e('closeOverlaysOnNavigate', 'interface', 'Close overlays on navigation', ['overlay', 'close', 'navigate', 'panel']),
  e('backClosesOverlays', 'interface', 'Back closes overlays', ['back', 'button', 'overlay', 'history']),
  e('reduceBlur', 'interface', 'Reduce blur', ['blur', 'glass', 'performance', 'transparency', 'frosted']),
  e('dynamicColor', 'interface', 'Dynamic colour', ['dynamic', 'color', 'colour', 'accent', 'cover', 'theme']),
  e('albumBackground', 'interface', 'Album background', ['background', 'album', 'cover', 'now playing']),
  e('compactGrids', 'interface', 'Compact grids', ['compact', 'grid', 'dense', 'layout', 'cards']),
  e('haptics', 'interface', 'Haptics', ['haptics', 'vibration', 'vibrate', 'touch', 'phone']),
  e('coverTilt', 'interface', 'Cover tilt', ['tilt', 'cover', '3d', 'pointer', 'parallax']),
  e('coverRound', 'interface', 'Rounded cover', ['round', 'rounded', 'cover', 'corners']),
  e('nowPlayingLyrics', 'interface', 'Show lyrics in Now Playing', ['lyrics', 'now playing', 'default']),
  e('waveformSeekbar', 'interface', 'Waveform seek bar', ['waveform', 'seek', 'seekbar', 'peaks', 'progress']),
  e('panelWidth', 'interface', 'Side panel width', ['panel', 'width', 'queue', 'resize']),
  e('home-jumpBackIn', 'interface', 'Home: Jump back in', ['home', 'jump back in', 'section', 'resume']),
  e('home-recent', 'interface', 'Home: Recently played', ['home', 'recent', 'history', 'section']),
  e('home-mixes', 'interface', 'Home: Your mixes', ['home', 'mixes', 'section']),
  e('home-forYou', 'interface', 'Home: Made for you', ['home', 'for you', 'recommendations', 'section']),
  e('home-playlists', 'interface', 'Home: Playlists', ['home', 'playlists', 'section']),
  e('home-picks', 'interface', 'Home: Editor picks', ['home', 'picks', 'editor', 'section']),

  // Shortcuts (P10)
  e('shortcuts', 'shortcuts', 'Keyboard shortcuts', ['keyboard', 'shortcuts', 'keys', 'hotkeys', 'bindings', 'rebind']),

  // Downloads (P12)
  e('downloads', 'downloads', 'Downloads', ['download', 'save', 'zip', 'filename', 'template', 'offline', 'sidecar']),

  // Scrobbling (P13)
  e('scrobbling', 'scrobbling', 'Scrobbling', ['scrobble', 'last.fm', 'lastfm', 'listenbrainz', 'history', 'connect']),
  e('scrobblePercent', 'scrobbling', 'Scrobble threshold', ['scrobble', 'percent', 'threshold', 'when']),

  // Data (P7)
  e('data', 'data', 'Backup, restore and import', ['backup', 'restore', 'import', 'export', 'playlists', 'library', 'reset', 'blocked']),

  // System
  e('storage', 'system', 'Storage used', ['storage', 'space', 'usage', 'bytes', 'indexeddb', 'localstorage']),
  e('clearCaches', 'system', 'Clear caches', ['cache', 'clear', 'free space', 'lyrics cache', 'waveform', 'autoeq']),
  e('apiStatus', 'system', 'API status', ['api', 'status', 'ping', 'latency', 'server', 'online']),
  e('version', 'system', 'App version', ['version', 'about', 'build']),
];
