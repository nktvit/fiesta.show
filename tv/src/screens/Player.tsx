import React, { useEffect, useRef, useState } from 'react';
import { getStream, getSubtitles, getMovieDetails, resolveImdbId, isImdbId, getTVSeasonEpisodes } from '../api';
import { safePlay } from '../util';
import { KEY } from '../remote';
import { navigate, moviePath } from '../router';
import { requestFullscreen, exitFullscreen, isFullscreen } from '../fullscreen';
import { fetchCues, activeCueText, Cue } from '../subtitles';
import {
  progressKey, readSavedProgress, saveProgress, clearProgress,
  readSubtitlePref, saveSubtitlePref, formatTime,
} from '../progress';
import { MediaType, SubtitleTrack } from '../types';

interface Props {
  type: MediaType;
  id: string;          // IMDb "tt…" or a TMDB numeric id (resolved here)
  season: number | null;
  episode: number | null;
}

type Phase = 'resolving' | 'loading' | 'playing' | 'error';

const SEEK_STEP = 10;
const HIDE_AFTER_MS = 4000;

// Samsung Tizen remote media keys (keyCode). Other TV shells map their
// transport buttons onto the same codes or onto the plain keyboard ones.
const MEDIA_KEY = {
  PLAY: 415,
  PAUSE: 19,
  PLAY_PAUSE: 10252,
  STOP: 413,
  REWIND: 412,
  FAST_FORWARD: 417,
  SPACE: 32,
};

function stripNA(v: any): string {
  return v && v !== 'N/A' ? String(v) : '';
}

export default function Player({ type, id, season, episode }: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const playBtnRef = useRef<HTMLButtonElement | null>(null);
  const menuFirstRef = useRef<HTMLButtonElement | null>(null);
  const hideTimerRef = useRef<any>(null);
  const cuesRef = useRef<Cue[]>([]);
  const cueTokenRef = useRef(0);
  const loadTokenRef = useRef(0);
  const lastSaveRef = useRef(0);
  const lastSecondRef = useRef(-1);
  const imdbRef = useRef('');
  // 0 = let the relay pick whichever front resolves first; 1/2 force one.
  const serverRef = useRef<0 | 1 | 2>(0);
  const menuOpenRef = useRef(false);

  const [phase, setPhase] = useState<Phase>('resolving');
  const [errorMsg, setErrorMsg] = useState('');
  const [title, setTitle] = useState('');
  const [subline, setSubline] = useState('');
  const [backdrop, setBackdrop] = useState('');
  const [tracks, setTracks] = useState<SubtitleTrack[]>([]);
  const [activeTrack, setActiveTrack] = useState(-1);
  const [subsState, setSubsState] = useState<'idle' | 'loading' | 'error'>('idle');
  const [cueText, setCueText] = useState('');
  const [paused, setPaused] = useState(true);
  const [buffering, setBuffering] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);
  const [ended, setEnded] = useState(false);

  menuOpenRef.current = menuOpen;

  // ---- controls visibility -------------------------------------------------

  function scheduleHide() {
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(function () {
      if (menuOpenRef.current) return;
      const video = videoRef.current;
      if (!video || video.paused || video.ended) return;
      // Hand focus back to the stage before the bar disappears so the next
      // key press lands somewhere that reacts.
      const active = document.activeElement as HTMLElement | null;
      if (active && stageRef.current && stageRef.current.contains(active) && active !== stageRef.current) {
        stageRef.current.focus();
      }
      setControlsVisible(false);
    }, HIDE_AFTER_MS);
  }

  function showControls() {
    setControlsVisible(true);
    scheduleHide();
  }

  // ---- subtitles -----------------------------------------------------------

  function selectTrack(index: number, persist: boolean) {
    const token = ++cueTokenRef.current;
    cuesRef.current = [];
    setCueText('');
    setActiveTrack(index);
    if (index < 0 || !tracks[index]) {
      setSubsState('idle');
      if (persist) saveSubtitlePref(null);
      return;
    }
    const t = tracks[index];
    if (persist) saveSubtitlePref({ lang: t.lang, label: t.label });
    setSubsState('loading');
    fetchCues(t.src).then(function (cues) {
      if (token !== cueTokenRef.current) return;
      cuesRef.current = cues;
      setSubsState(cues.length ? 'idle' : 'error');
      const video = videoRef.current;
      if (video) setCueText(activeCueText(cues, video.currentTime));
    }).catch(function () {
      if (token !== cueTokenRef.current) return;
      setSubsState('error');
    });
  }

  function defaultTrackIndex(list: SubtitleTrack[]): number {
    if (!list.length) return -1;
    const pref = readSubtitlePref();
    if (pref) {
      for (let i = 0; i < list.length; i++) {
        if (list[i].lang === pref.lang && list[i].label === pref.label) return i;
      }
      for (let i = 0; i < list.length; i++) {
        if (list[i].lang === pref.lang) return i;
      }
    }
    for (let i = 0; i < list.length; i++) {
      if (list[i].lang === 'en') return i;
    }
    return 0;
  }

  // Runs once the track list for this title is known.
  useEffect(function () {
    selectTrack(defaultTrackIndex(tracks), false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tracks]);

  // ---- stream loading ------------------------------------------------------

  function loadStream(imdbId: string, srv: 0 | 1 | 2, token: number) {
    serverRef.current = srv;
    setPhase('loading');
    setErrorMsg('');
    getStream(type, imdbId, season, episode, srv || undefined).then(function (r) {
      if (token !== loadTokenRef.current) return;
      if (!r || !r.master) throw new Error('no stream returned');
      const video = videoRef.current;
      if (!video) return;
      video.src = r.master;
      video.load();
    }).catch(function (err) {
      if (token !== loadTokenRef.current) return;
      if (srv === 0) {
        loadStream(imdbId, 2, token);
        return;
      }
      setPhase('error');
      setErrorMsg(String((err && err.message) || err || 'stream unavailable'));
    });
  }

  function retry() {
    const token = ++loadTokenRef.current;
    if (!imdbRef.current) return;
    loadStream(imdbRef.current, serverRef.current === 2 ? 1 : 2, token);
  }

  useEffect(function () {
    const token = ++loadTokenRef.current;
    cueTokenRef.current++;
    cuesRef.current = [];
    lastSaveRef.current = 0;
    lastSecondRef.current = -1;
    imdbRef.current = '';
    setPhase('resolving');
    setErrorMsg('');
    setTitle('');
    setSubline('');
    setBackdrop('');
    setTracks([]);
    setActiveTrack(-1);
    setCueText('');
    setCurrentTime(0);
    setDuration(0);
    setEnded(false);
    setMenuOpen(false);
    setControlsVisible(true);

    if (!id) {
      setPhase('error');
      setErrorMsg('Nothing to play.');
      return function () {};
    }

    const idPromise: Promise<string> = isImdbId(id) ? Promise.resolve(id) : resolveImdbId(+id, type);

    idPromise.then(function (imdbId) {
      if (token !== loadTokenRef.current) return;
      if (!imdbId) throw new Error('Title not found.');
      imdbRef.current = imdbId;

      // Title/backdrop for the loading screen and the top bar — cosmetic,
      // so a failure here never blocks playback.
      getMovieDetails(imdbId).then(function (d) {
        if (token !== loadTokenRef.current) return;
        setTitle(stripNA(d.Title));
        const yr = stripNA((d as any).Year);
        setBackdrop(d._backdrop || (stripNA(d.Poster)));
        if (type === 'tv') {
          const base = 'Season ' + (season || 1) + ' · Episode ' + (episode || 1);
          setSubline(base);
          if (d._tmdbId) {
            getTVSeasonEpisodes(d._tmdbId, season || 1).then(function (eps) {
              if (token !== loadTokenRef.current) return;
              for (let i = 0; i < eps.length; i++) {
                if (eps[i].number === (episode || 1) && eps[i].title) {
                  setSubline(base + ' · ' + eps[i].title);
                  break;
                }
              }
            });
          }
        } else {
          setSubline(yr);
        }
      }).catch(function () {});

      getSubtitles(type, imdbId, season, episode).then(function (t) {
        if (token !== loadTokenRef.current) return;
        setTracks(t);
      });

      loadStream(imdbId, 0, token);
    }).catch(function (err) {
      if (token !== loadTokenRef.current) return;
      setPhase('error');
      setErrorMsg(String((err && err.message) || err));
    });

    // Best-effort: the Play button that brought us here already asked for
    // fullscreen inside its click handler; this covers deep links.
    if (!isFullscreen()) requestFullscreen(document.documentElement);

    const t = setTimeout(function () { if (stageRef.current) stageRef.current.focus(); }, 80);

    return function () {
      clearTimeout(t);
      loadTokenRef.current++;
      const video = videoRef.current;
      if (video) {
        try { video.pause(); } catch (e) {}
        video.removeAttribute('src');
        try { video.load(); } catch (e) {}
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type, id, season, episode]);

  // Mouse/pointer users (a TV with an air-mouse, or a laptop): moving the
  // pointer brings the bar back and restarts the hide timer, like keys do.
  const lastMoveRef = useRef(0);
  function onPointerActivity() {
    const now = Date.now();
    if (now - lastMoveRef.current < 250) return;
    lastMoveRef.current = now;
    showControls();
  }

  useEffect(function () {
    scheduleHide();
    return function () {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
      exitFullscreen();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- transport -----------------------------------------------------------

  function togglePlay() {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused || video.ended) {
      if (video.ended) { try { video.currentTime = 0; } catch (e) {} }
      safePlay(video);
      if (!isFullscreen()) requestFullscreen(document.documentElement);
    } else {
      video.pause();
    }
    showControls();
  }

  function seekBy(delta: number) {
    const video = videoRef.current;
    if (!video) return;
    const dur = isFinite(video.duration) ? video.duration : Infinity;
    let t = video.currentTime + delta;
    if (t < 0) t = 0;
    if (t > dur - 1) t = Math.max(0, dur - 1);
    try { video.currentTime = t; } catch (e) {}
    setCurrentTime(t);
    setCueText(activeCueText(cuesRef.current, t));
    showControls();
  }

  function goBack() {
    exitFullscreen();
    window.history.back();
  }

  function nextEpisode() {
    if (type !== 'tv') return;
    navigate(moviePath('tv', id, { play: true, season: season || 1, episode: (episode || 1) + 1 }));
  }

  function openMenu() {
    setMenuOpen(true);
    setControlsVisible(true);
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    setTimeout(function () {
      if (menuFirstRef.current) { menuFirstRef.current.focus(); menuFirstRef.current.scrollIntoView(); }
    }, 30);
  }

  function closeMenu() {
    setMenuOpen(false);
    showControls();
    setTimeout(function () {
      const btn = document.querySelector('[data-subs-btn]') as HTMLElement | null;
      if (btn) btn.focus();
    }, 30);
  }

  function chooseTrack(index: number) {
    selectTrack(index, true);
    closeMenu();
  }

  // ---- keys ----------------------------------------------------------------

  // Capture-phase listener: runs before remote.ts's document handler, so it
  // can claim the media keys and keep Back from leaving the page while the
  // subtitle menu is open.
  useEffect(function () {
    function onKey(e: KeyboardEvent) {
      const code = e.keyCode;
      if (menuOpenRef.current) {
        if (code === KEY.BACKSPACE || code === KEY.ESCAPE || code === KEY.TIZEN_BACK) {
          e.preventDefault();
          e.stopPropagation();
          closeMenu();
          return;
        }
        if (code === KEY.LEFT || code === KEY.RIGHT) {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        return;
      }

      switch (code) {
        case MEDIA_KEY.PLAY_PAUSE:
        case MEDIA_KEY.SPACE:
          if ((document.activeElement && document.activeElement.tagName) === 'BUTTON' && code === MEDIA_KEY.SPACE) return;
          e.preventDefault(); e.stopPropagation(); togglePlay(); return;
        case MEDIA_KEY.PLAY: {
          e.preventDefault(); e.stopPropagation();
          const v = videoRef.current; if (v && v.paused) togglePlay(); else showControls();
          return;
        }
        case MEDIA_KEY.PAUSE: {
          e.preventDefault(); e.stopPropagation();
          const v = videoRef.current; if (v && !v.paused) togglePlay(); else showControls();
          return;
        }
        case MEDIA_KEY.REWIND: e.preventDefault(); e.stopPropagation(); seekBy(-SEEK_STEP); return;
        case MEDIA_KEY.FAST_FORWARD: e.preventDefault(); e.stopPropagation(); seekBy(SEEK_STEP); return;
        case MEDIA_KEY.STOP: e.preventDefault(); e.stopPropagation(); goBack(); return;
        case KEY.BACKSPACE:
        case KEY.ESCAPE:
        case KEY.TIZEN_BACK:
          // Let remote.ts do history.back(), but drop fullscreen first.
          exitFullscreen();
          return;
      }
      showControls();
    }
    document.addEventListener('keydown', onKey, true);
    return function () { document.removeEventListener('keydown', onKey, true); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tracks]);

  // Keys while the stage (the video itself) has focus: Enter toggles,
  // Left/Right seek, Down drops into the control bar.
  function onStageKey(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.target !== stageRef.current) return;
    const code = e.keyCode;
    if (code === KEY.ENTER) { e.preventDefault(); e.stopPropagation(); togglePlay(); return; }
    if (code === KEY.LEFT) { e.preventDefault(); e.stopPropagation(); seekBy(-SEEK_STEP); return; }
    if (code === KEY.RIGHT) { e.preventDefault(); e.stopPropagation(); seekBy(SEEK_STEP); return; }
    if (code === KEY.DOWN || code === KEY.UP) {
      e.preventDefault(); e.stopPropagation();
      showControls();
      setTimeout(function () { if (playBtnRef.current) playBtnRef.current.focus(); }, 0);
    }
  }

  // ---- video events --------------------------------------------------------

  function onLoadedMetadata() {
    const video = videoRef.current;
    if (!video) return;
    if (isFinite(video.duration)) setDuration(video.duration);
    const saved = readSavedProgress(progressKey(imdbRef.current || id, type, season, episode));
    if (saved && saved.time > 5 && (!isFinite(video.duration) || saved.time < video.duration - 10)) {
      try { video.currentTime = saved.time; } catch (e) {}
    }
    safePlay(video);
  }

  function onTimeUpdate() {
    const video = videoRef.current;
    if (!video) return;
    const t = video.currentTime;
    const text = activeCueText(cuesRef.current, t);
    setCueText(function (prev) { return prev === text ? prev : text; });

    const sec = Math.floor(t);
    if (sec !== lastSecondRef.current) {
      lastSecondRef.current = sec;
      setCurrentTime(t);
      if (isFinite(video.duration) && video.duration !== duration) setDuration(video.duration);
    }

    const now = Date.now();
    if (now - lastSaveRef.current < 5000) return;
    lastSaveRef.current = now;
    saveProgress(progressKey(imdbRef.current || id, type, season, episode), video, {
      id: imdbRef.current || id, type: type, season: season, episode: episode,
    });
  }

  function onVideoError() {
    if (phase === 'error') return;
    if (serverRef.current === 0 && imdbRef.current) {
      loadStream(imdbRef.current, 2, loadTokenRef.current);
      return;
    }
    setPhase('error');
    setErrorMsg('This stream can’t be played on this TV.');
  }

  function onEnded() {
    setEnded(true);
    setPaused(true);
    setControlsVisible(true);
    clearProgress(progressKey(imdbRef.current || id, type, season, episode));
    setTimeout(function () {
      const next = document.querySelector('[data-next-btn]') as HTMLElement | null;
      if (next) next.focus(); else if (playBtnRef.current) playBtnRef.current.focus();
    }, 30);
  }

  // ---- render --------------------------------------------------------------

  const activeLabel = activeTrack >= 0 && tracks[activeTrack] ? tracks[activeTrack].label : 'Off';
  const progressPct = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;
  const showOverlay = phase === 'resolving' || phase === 'loading';
  const cueLines = cueText ? cueText.split('\n') : [];

  return (
    <div
      ref={stageRef}
      className={'tv-player' + (controlsVisible || showOverlay || phase === 'error' ? '' : ' is-idle')}
      tabIndex={0}
      data-focusable="true"
      onKeyDown={onStageKey}
      onMouseMove={onPointerActivity}
    >
      <video
        ref={videoRef}
        className="tv-player-video"
        autoPlay
        playsInline
        onClick={togglePlay}
        onLoadedMetadata={onLoadedMetadata}
        onTimeUpdate={onTimeUpdate}
        onPlay={function () { setPaused(false); setEnded(false); }}
        onPause={function () { setPaused(true); setControlsVisible(true); }}
        onPlaying={function () { setBuffering(false); setPhase('playing'); scheduleHide(); }}
        onCanPlay={function () { setPhase(function (p) { return p === 'loading' ? 'playing' : p; }); }}
        onWaiting={function () { setBuffering(true); }}
        onEnded={onEnded}
        onError={onVideoError}
      />

      {cueLines.length ? (
        <div className={'tv-subs' + (controlsVisible ? ' is-raised' : '')}>
          <span className="tv-subs-text">
            {cueLines.map(function (line, i) {
              return <span key={i}>{i > 0 ? <br /> : null}{line}</span>;
            })}
          </span>
        </div>
      ) : null}

      {buffering && phase === 'playing' ? <div className="tv-spinner tv-spinner-center" /> : null}

      {showOverlay ? (
        <div className="tv-player-overlay" style={backdrop ? { backgroundImage: 'url(' + backdrop + ')' } : undefined}>
          <div className="tv-player-overlay-shade" />
          <div className="tv-player-overlay-body">
            <div className="tv-spinner" />
            <div className="tv-player-overlay-title">{title || 'Loading'}</div>
            {subline ? <div className="tv-player-overlay-sub">{subline}</div> : null}
            <div className="tv-player-overlay-hint">
              {phase === 'resolving' ? 'Finding a stream…' : (serverRef.current === 2 ? 'Trying another server…' : 'Starting playback…')}
            </div>
          </div>
        </div>
      ) : null}

      {phase === 'error' ? (
        <div className="tv-player-overlay" style={backdrop ? { backgroundImage: 'url(' + backdrop + ')' } : undefined}>
          <div className="tv-player-overlay-shade" />
          <div className="tv-player-overlay-body">
            <div className="tv-player-overlay-title">{title || 'Playback failed'}</div>
            <div className="tv-player-overlay-sub">{errorMsg || 'This title isn’t available to stream right now.'}</div>
            <div className="tv-player-overlay-actions">
              <button type="button" className="tv-btn" data-focusable="true" onClick={retry}>Try again</button>
              <button type="button" className="tv-btn tv-btn-secondary" data-focusable="true" onClick={goBack}>Back</button>
            </div>
          </div>
        </div>
      ) : null}

      <div className={'tv-player-ui' + (controlsVisible && !showOverlay && phase !== 'error' ? '' : ' is-hidden')}>
        <div className="tv-player-top">
          <button type="button" className="tv-icon-btn" data-focusable="true" onClick={goBack} aria-label="Back">
            <span className="tv-icon">&#8592;</span>
          </button>
          <div className="tv-player-heading">
            <div className="tv-player-title">{title}</div>
            {subline ? <div className="tv-player-subline">{subline}</div> : null}
          </div>
        </div>

        <div className="tv-player-bottom">
          <div className="tv-progress">
            <div className="tv-progress-fill" style={{ width: progressPct + '%' }} />
          </div>
          <div className="tv-player-row">
            <div className="tv-player-time">
              {formatTime(currentTime)}<span className="tv-player-time-sep"> / </span>{formatTime(duration)}
            </div>
            <div className="tv-player-controls">
              <button type="button" className="tv-ctl" data-focusable="true" onClick={function () { seekBy(-SEEK_STEP); }}>
                <span className="tv-ctl-icon">&#8634;</span><span className="tv-ctl-label">10s</span>
              </button>
              <button type="button" className="tv-ctl tv-ctl-primary" data-focusable="true" ref={playBtnRef} onClick={togglePlay}>
                <span className="tv-ctl-icon">{ended ? '↻' : (paused ? '▶' : '❙❙')}</span>
                <span className="tv-ctl-label">{ended ? 'Replay' : (paused ? 'Play' : 'Pause')}</span>
              </button>
              <button type="button" className="tv-ctl" data-focusable="true" onClick={function () { seekBy(SEEK_STEP); }}>
                <span className="tv-ctl-icon">&#8635;</span><span className="tv-ctl-label">10s</span>
              </button>
              {type === 'tv' ? (
                <button type="button" className="tv-ctl" data-focusable="true" data-next-btn="true" onClick={nextEpisode}>
                  <span className="tv-ctl-icon">&#9197;</span><span className="tv-ctl-label">Next episode</span>
                </button>
              ) : null}
            </div>
            <button
              type="button"
              className={'tv-ctl tv-ctl-subs' + (activeTrack >= 0 ? ' is-on' : '')}
              data-focusable="true"
              data-subs-btn="true"
              onClick={openMenu}
              disabled={!tracks.length}
            >
              <span className="tv-ctl-icon tv-ctl-cc">CC</span>
              <span className="tv-ctl-label">
                {!tracks.length ? 'No subtitles' : (subsState === 'loading' ? 'Loading…' : (subsState === 'error' ? 'Unavailable' : activeLabel))}
              </span>
            </button>
          </div>
        </div>
      </div>

      {menuOpen ? (
        <div className="tv-menu">
          <div className="tv-menu-panel">
            <div className="tv-menu-title">Subtitles</div>
            <div className="tv-menu-list">
              <button
                type="button"
                ref={activeTrack < 0 ? menuFirstRef : undefined}
                className={'tv-menu-item' + (activeTrack < 0 ? ' is-active' : '')}
                data-focusable="true"
                onClick={function () { chooseTrack(-1); }}
              >
                Off
              </button>
              {tracks.map(function (t, i) {
                return (
                  <button
                    key={t.lang + ':' + t.label + ':' + i}
                    type="button"
                    ref={i === activeTrack ? menuFirstRef : undefined}
                    className={'tv-menu-item' + (i === activeTrack ? ' is-active' : '')}
                    data-focusable="true"
                    onClick={function () { chooseTrack(i); }}
                  >
                    {t.label}
                  </button>
                );
              })}
            </div>
            <div className="tv-menu-hint">Press Back to close</div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
