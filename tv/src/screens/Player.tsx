import React, { useEffect, useRef, useState } from 'react';
import { getStream, getSubtitles } from '../api';
import { safePlay } from '../util';
import { MediaType, SubtitleTrack } from '../types';

interface Props {
  type: MediaType;
  imdbId: string;
  season: number | null;
  episode: number | null;
}

// Same key format src/app/components/movie-player/movie-player.component.ts
// uses — resume position is shared between the main site and this client.
const PROGRESS_PREFIX = 'fiesta:playback-progress:';

function progressKey(imdbId: string, type: MediaType, season: number | null, episode: number | null): string {
  if (type === 'tv') return PROGRESS_PREFIX + imdbId + ':tv:s' + (season || 1) + ':e' + (episode || 1);
  return PROGRESS_PREFIX + imdbId + ':movie';
}

function readSavedProgress(key: string): number | null {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const data = JSON.parse(raw);
    return typeof data.time === 'number' && isFinite(data.time) ? data.time : null;
  } catch (e) {
    return null;
  }
}

function saveProgress(key: string, video: HTMLVideoElement, extra: any) {
  if (video.ended || !isFinite(video.currentTime) || video.currentTime < 5) return;
  const duration = isFinite(video.duration) ? video.duration : null;
  if (duration && video.currentTime >= duration - 10) {
    try { window.localStorage.removeItem(key); } catch (e) {}
    return;
  }
  try {
    const data = {
      id: extra.id,
      type: extra.type,
      season: extra.season,
      episode: extra.episode,
      time: Math.floor(video.currentTime),
      duration: duration ? Math.floor(duration) : null,
      updatedAt: Date.now(),
    };
    window.localStorage.setItem(key, JSON.stringify(data));
  } catch (e) {}
}

export default function Player({ type, imdbId, season, episode }: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [errorMsg, setErrorMsg] = useState('');
  const [tracks, setTracks] = useState<SubtitleTrack[]>([]);
  const lastSaveRef = useRef(0);

  useEffect(function () {
    let cancelled = false;
    setStatus('loading');
    setErrorMsg('');
    setTracks([]);
    lastSaveRef.current = 0;

    if (!imdbId) {
      setStatus('error');
      setErrorMsg('Nothing to play.');
      return function () {};
    }

    getSubtitles(type, imdbId, season, episode).then(function (t) {
      if (!cancelled) setTracks(t);
    });

    getStream(type, imdbId, season, episode).then(function (r) {
      if (cancelled) return;
      if (!r || !r.master) throw new Error('no stream returned');
      const video = videoRef.current;
      if (!video) return;
      video.src = r.master;
      setStatus('ready');
    }).catch(function (err) {
      if (cancelled) return;
      setStatus('error');
      setErrorMsg(String((err && err.message) || err));
    });

    return function () { cancelled = true; };
  }, [type, imdbId, season, episode]);

  function onLoadedMetadata() {
    const video = videoRef.current;
    if (!video) return;
    const key = progressKey(imdbId, type, season, episode);
    const saved = readSavedProgress(key);
    if (saved && saved > 5 && (!isFinite(video.duration) || saved < video.duration - 10)) {
      try { video.currentTime = saved; } catch (e) {}
    }
    safePlay(video);
  }

  function onTimeUpdate() {
    const video = videoRef.current;
    if (!video) return;
    const now = Date.now();
    if (now - lastSaveRef.current < 5000) return;
    lastSaveRef.current = now;
    saveProgress(progressKey(imdbId, type, season, episode), video, {
      id: imdbId, type: type, season: season, episode: episode,
    });
  }

  function onVideoError() {
    setStatus('error');
    setErrorMsg('Playback isn’t supported on this TV’s browser.');
  }

  function goBack() {
    window.history.back();
  }

  return (
    <div className="tv-player">
      <video
        ref={videoRef}
        controls
        autoPlay
        data-focusable="true"
        onLoadedMetadata={onLoadedMetadata}
        onTimeUpdate={onTimeUpdate}
        onError={onVideoError}
      >
        {tracks.map(function (t, i) {
          return (
            <track
              key={t.lang + ':' + t.label + ':' + i}
              kind="subtitles"
              srcLang={t.lang}
              label={t.label}
              src={t.src}
              default={i === 0}
            />
          );
        })}
      </video>
      {status === 'loading' ? (
        <div className="tv-player-center">
          <div className="tv-player-title">Loading…</div>
        </div>
      ) : null}
      {status === 'error' ? (
        <div className="tv-player-center">
          <div className="tv-player-title">{errorMsg || 'This title isn’t available to stream right now'}</div>
          <button type="button" className="tv-btn" data-focusable="true" onClick={goBack}>Back</button>
        </div>
      ) : null}
    </div>
  );
}
