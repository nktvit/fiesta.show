import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { Observable, of, throwError } from 'rxjs';
import { musicStorage } from '../utils/music-storage';
import { MUSIC_AUDIO_FACTORY, MusicPlayerEvents, MusicPlayerService } from './music-player.service';
import { MusicSettingsService } from './music-settings.service';
import { MusicToastService } from './music-toast.service';
import { MusicManifest, MusicService, MusicTrack } from './music.service';

/** Just enough of HTMLAudioElement for the player: properties plus play/pause events. */
class FakeAudio extends EventTarget {
  preload = '';
  paused = true;
  currentTime = 0;
  duration = NaN;
  volume = 1;
  muted = false;
  playbackRate = 1;
  defaultPlaybackRate = 1;
  preservesPitch = true;
  error: MediaError | null = null;
  buffered = { length: 0, start: () => 0, end: () => 0 };
  private _src = '';
  get src(): string { return this._src; }
  set src(v: string) { this._src = v; }
  getAttribute(n: string): string | null { return n === 'src' && this._src ? this._src : null; }
  hasAttribute(n: string): boolean { return n === 'src' && !!this._src; }
  removeAttribute(n: string): void { if (n === 'src') this._src = ''; }
  load(): void { /* nothing */ }
  play(): Promise<void> {
    this.paused = false;
    this.dispatchEvent(new Event('playing'));
    return Promise.resolve();
  }
  pause(): void {
    if (this.paused) return;
    this.paused = true;
    this.dispatchEvent(new Event('pause'));
  }
  /** Test helper: advance the playhead. */
  tickTo(t: number): void {
    this.currentTime = t;
    this.dispatchEvent(new Event('timeupdate'));
  }
  end(): void {
    this.paused = true;
    this.dispatchEvent(new Event('ended'));
  }
}

const track = (id: number): MusicTrack => ({
  id, title: 'T' + id, artist: 'A', artistId: 1, album: 'Al', albumId: 2, cover: '', duration: 200,
  explicit: false, trackNumber: id, quality: 'LOSSLESS',
});
const tracks = (n: number) => Array.from({ length: n }, (_, i) => track(i + 1));
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('MusicPlayerService', () => {
  let audios: FakeAudio[];
  let failing: Set<number>;
  let player: MusicPlayerService;
  let settings: MusicSettingsService;

  const clean = () => musicStorage.keys().forEach((k) => musicStorage.remove(k));
  const el = () => player.activeElement() as unknown as FakeAudio;
  const ids = () => player.queue().map((t) => t.id);

  function setup(): void {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: MUSIC_AUDIO_FACTORY, useValue: () => { const a = new FakeAudio(); audios.push(a); return a as unknown as HTMLAudioElement; } },
        {
          provide: MusicService,
          useValue: {
            manifest: (id: number): Observable<MusicManifest> =>
              failing.has(+id)
                ? throwError(() => new HttpErrorResponse({ status: 404 }))
                : of({ presentation: 'FULL', quality: 'LOSSLESS', signedIn: true, kind: 'file', codec: 'flac', url: '/a/' + id } as MusicManifest),
          },
        },
      ],
    });
    player = TestBed.inject(MusicPlayerService);
    settings = TestBed.inject(MusicSettingsService);
  }

  beforeEach(() => {
    clean();
    audios = [];
    failing = new Set();
    setup();
  });
  afterEach(() => {
    player.setSleepTimer(null);
    clean();
  });

  it('plays a track from a list', async () => {
    const list = tracks(3);
    await player.play(list[1], list);
    expect(player.index()).toBe(1);
    expect(player.track()!.id).toBe(2);
    expect(player.playing()).toBeTrue();
    expect(el().src).toBe('/a/2');
    expect(player.canNext()).toBeTrue();
  });

  it('shuffle puts the current track first; toggling again restores the order', async () => {
    const list = tracks(8);
    await player.play(list[3], list);
    player.toggleShuffle();
    expect(player.shuffle()).toBeTrue();
    expect(player.index()).toBe(0);
    expect(player.track()!.id).toBe(4);
    expect([...ids()].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    player.toggleShuffle();
    expect(ids()).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(player.track()!.id).toBe(4);
    expect(settings.shuffle()).toBeFalse();
  });

  it('cycleRepeat goes off -> all -> one -> off', () => {
    expect(player.repeat()).toBe('off');
    player.cycleRepeat();
    expect(player.repeat()).toBe('all');
    player.cycleRepeat();
    expect(player.repeat()).toBe('one');
    player.cycleRepeat();
    expect(player.repeat()).toBe('off');
  });

  it('repeat one replays the same track on ended; repeat all wraps to the first', async () => {
    const list = tracks(3);
    await player.play(list[2], list);
    player.setRepeat('one');
    el().tickTo(150);
    el().end();
    await flush();
    expect(player.track()!.id).toBe(3);
    expect(el().currentTime).toBe(0);
    expect(player.playing()).toBeTrue();

    player.setRepeat('all');
    el().end();
    await flush();
    await flush();
    expect(player.index()).toBe(0);
    expect(player.track()!.id).toBe(1);
  });

  it('stops at the end of the queue with repeat off', async () => {
    const list = tracks(2);
    await player.play(list[1], list);
    el().end();
    await flush();
    expect(player.index()).toBe(1);
    expect(player.playing()).toBeFalse();
  });

  it('volume: linear, exponential, mute - all persisted in settings', async () => {
    await player.play(track(1));
    player.setVolume(0.3);
    expect(el().volume).toBeCloseTo(0.3, 5);
    settings.exponentialVolume.set(true);
    player.setVolume(0.3);
    expect(el().volume).toBeCloseTo(0.027, 5);
    player.toggleMute();
    expect(el().muted).toBeTrue();
    expect(el().volume).toBe(0);
    expect(settings.volume()).toBe(0.3);
    expect(settings.muted()).toBeTrue();
    settings.flush();
    expect(musicStorage.read<Record<string, unknown>>('settings', {})['volume']).toBe(0.3);
  });

  it('playback rate and preservesPitch apply to the element and persist', async () => {
    await player.play(track(1));
    player.setPlaybackRate(1.5);
    expect(el().playbackRate).toBe(1.5);
    expect(settings.playbackRate()).toBe(1.5);
    player.setPreservesPitch(false);
    expect(el().preservesPitch).toBeFalse();
    player.setPlaybackRate(9);
    expect(player.playbackRate()).toBe(4);
  });

  it('queue editing keeps queue() and index() right', async () => {
    const list = tracks(4);
    await player.play(list[1], list); // playing 2
    player.addToQueue([track(10)]);
    expect(ids()).toEqual([1, 2, 3, 4, 10]);
    player.playNext([track(11)]);
    expect(ids()).toEqual([1, 2, 11, 3, 4, 10]);
    player.removeAt(0);
    expect(player.index()).toBe(0);
    expect(player.track()!.id).toBe(2);
    player.move(4, 0); // 10 to the front
    expect(ids()).toEqual([10, 2, 11, 3, 4]);
    expect(player.track()!.id).toBe(2);
    expect(player.index()).toBe(1);
    player.clearUpcoming();
    expect(ids()).toEqual([10, 2]);
    expect(player.upNext().length).toBe(0);
  });

  it('removing the current track moves on to the next', async () => {
    const list = tracks(3);
    await player.play(list[0], list);
    player.removeAt(0);
    await flush();
    expect(player.track()!.id).toBe(2);
    expect(ids()).toEqual([2, 3]);
  });

  it('emits trackstart, skip and trackend', async () => {
    const seen: string[] = [];
    let end: MusicPlayerEvents['trackend'] | null = null;
    player.on('trackstart', (e) => seen.push('start:' + e.track.id));
    player.on('skip', (e) => seen.push('skip:' + e.track.id));
    player.on('trackend', (e) => { seen.push('end:' + e.track.id); end = e; });
    const list = tracks(2);
    await player.play(list[0], list);
    el().tickTo(1);
    el().tickTo(2);
    player.next();
    await flush();
    expect(seen).toEqual(['start:1', 'skip:1', 'end:1', 'start:2']);
    expect(end!.completed).toBeFalse();
    expect(end!.playedSeconds).toBe(2);
  });

  it('adds to history after 10 s of play', async () => {
    await player.play(track(7));
    for (let t = 1; t <= 11; t++) el().tickTo(t);
    const history = musicStorage.read<{ track: MusicTrack }[]>('history', []);
    expect(history[0]?.track.id).toBe(7);
  });

  it("sleep 'end-of-track' pauses on ended instead of advancing", async () => {
    const list = tracks(2);
    await player.play(list[0], list);
    player.setSleepTimer('end-of-track');
    expect(player.sleep().endOfTrack).toBeTrue();
    el().end();
    await flush();
    expect(player.track()!.id).toBe(1);
    expect(player.playing()).toBeFalse();
    expect(player.sleep().endOfTrack).toBeFalse();
  });

  it('sleep timer pauses after the time is up', async () => {
    jasmine.clock().install();
    try {
      jasmine.clock().mockDate(new Date(2026, 0, 1));
      await player.play(track(1));
      player.setSleepTimer(0.05); // 3 s
      expect(player.sleepRemaining()).toBe(3);
      jasmine.clock().tick(3100);
      expect(player.playing()).toBeFalse();
      expect(player.sleep().endsAt).toBeNull();
    } finally {
      jasmine.clock().uninstall();
    }
  });

  it('skips an unavailable track with a toast, and stops after one failing pass', async () => {
    const toast = TestBed.inject(MusicToastService);
    failing.add(2);
    const list = tracks(3);
    await player.play(list[1], list);
    await flush();
    expect(player.track()!.id).toBe(3);
    expect(toast.toasts().some((t) => t.tone === 'warn' && t.message.includes('T2'))).toBeTrue();

    failing = new Set([1, 2, 3]);
    await player.play(list[0], list);
    for (let k = 0; k < 6; k++) await flush();
    expect(player.error()).toBe('unavailable');
    expect(player.playing()).toBeFalse();
  });

  it('restores the queue paused after a reload', async () => {
    const list = tracks(3);
    await player.play(list[1], list);
    el().tickTo(42);
    el().pause();
    // A fresh app (same storage).
    audios = [];
    setup();
    expect(player.track()!.id).toBe(2);
    expect(player.queue().length).toBe(3);
    expect(player.position()).toBe(42);
    expect(player.playing()).toBeFalse();
    expect(player.debugState().needsLoad).toBeTrue();
    player.toggle();
    await flush();
    await flush();
    expect(player.playing()).toBeTrue();
    expect(el().src).toBe('/a/2');
  });

  it('seek clamps to [0, duration - 0.25] and emits seek', async () => {
    const seeks: number[] = [];
    player.on('seek', (e) => seeks.push(e.to));
    await player.play(track(1));
    player.seek(999);
    expect(player.position()).toBe(199.75);
    player.seekBy(-1000);
    expect(player.position()).toBe(0);
    expect(seeks).toEqual([199.75, 0]);
  });
});
