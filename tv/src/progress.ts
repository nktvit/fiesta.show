// Resume-position storage. Same key format as the main site's
// movie-player.component.ts, so a title half-watched on a phone resumes at
// the same spot on the TV and vice versa.

import { MediaType } from './types';

const PROGRESS_PREFIX = 'fiesta:playback-progress:';
export const SUBTITLE_PREF_KEY = 'fiesta:subtitle-pref';

export function progressKey(imdbId: string, type: MediaType, season: number | null, episode: number | null): string {
  if (type === 'tv') return PROGRESS_PREFIX + imdbId + ':tv:s' + (season || 1) + ':e' + (episode || 1);
  return PROGRESS_PREFIX + imdbId + ':movie';
}

export function readSavedProgress(key: string): { time: number; duration: number | null } | null {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (typeof data.time !== 'number' || !isFinite(data.time)) return null;
    return { time: data.time, duration: typeof data.duration === 'number' ? data.duration : null };
  } catch (e) {
    return null;
  }
}

export function saveProgress(key: string, video: HTMLVideoElement, extra: { id: string; type: MediaType; season: number | null; episode: number | null }) {
  if (video.ended || !isFinite(video.currentTime) || video.currentTime < 5) return;
  const duration = isFinite(video.duration) ? video.duration : null;
  if (duration && video.currentTime >= duration - 10) {
    try { window.localStorage.removeItem(key); } catch (e) {}
    return;
  }
  try {
    window.localStorage.setItem(key, JSON.stringify({
      id: extra.id,
      type: extra.type,
      season: extra.season,
      episode: extra.episode,
      time: Math.floor(video.currentTime),
      duration: duration ? Math.floor(duration) : null,
      updatedAt: Date.now(),
    }));
  } catch (e) {}
}

export function clearProgress(key: string) {
  try { window.localStorage.removeItem(key); } catch (e) {}
}

export function readSubtitlePref(): { lang: string; label: string } | null {
  try {
    const raw = window.localStorage.getItem(SUBTITLE_PREF_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (typeof data.lang !== 'string' || typeof data.label !== 'string') return null;
    return { lang: data.lang, label: data.label };
  } catch (e) {
    return null;
  }
}

export function saveSubtitlePref(pref: { lang: string; label: string } | null) {
  try {
    if (!pref) window.localStorage.removeItem(SUBTITLE_PREF_KEY);
    else window.localStorage.setItem(SUBTITLE_PREF_KEY, JSON.stringify(pref));
  } catch (e) {}
}

export function formatTime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) seconds = 0;
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = (h > 0 && m < 10 ? '0' : '') + m;
  const ss = (sec < 10 ? '0' : '') + sec;
  return (h > 0 ? h + ':' : '') + mm + ':' + ss;
}
