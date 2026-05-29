import { ComponentFixture, TestBed } from '@angular/core/testing';

import { MoviePlayerComponent } from './movie-player.component';

describe('MoviePlayerComponent', () => {
  let component: MoviePlayerComponent;
  let fixture: ComponentFixture<MoviePlayerComponent>;

  const progressPrefix = 'fiesta:playback-progress:';

  beforeEach(async () => {
    spyOn(window, 'fetch').and.resolveTo({
      ok: true,
      json: async () => ({ master: '/stream.m3u8', tracks: [] }),
    } as Response);

    await TestBed.configureTestingModule({
      imports: [MoviePlayerComponent]
    })
    .compileComponents();
    
    fixture = TestBed.createComponent(MoviePlayerComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  afterEach(() => {
    Object.keys(window.localStorage)
      .filter(key => key.startsWith(progressPrefix))
      .forEach(key => window.localStorage.removeItem(key));
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('saves movie playback progress locally', () => {
    fixture.componentRef.setInput('imdbId', 'tt0133093');
    fixture.componentRef.setInput('type', 'movie');
    fixture.detectChanges();

    component.onTimeUpdate({
      currentTime: 42.8,
      duration: 120,
      ended: false,
    } as HTMLVideoElement);

    const saved = JSON.parse(
      window.localStorage.getItem(`${progressPrefix}tt0133093:movie`) || '{}'
    );
    expect(saved).toEqual(jasmine.objectContaining({
      id: 'tt0133093',
      type: 'movie',
      time: 42,
      duration: 120,
    }));
  });

  it('waits for user confirmation before restoring TV episode progress', () => {
    window.localStorage.setItem(`${progressPrefix}tt0944947:tv:s2:e3`, JSON.stringify({
      time: 615,
      updatedAt: Date.now(),
    }));

    fixture.componentRef.setInput('imdbId', 'tt0944947');
    fixture.componentRef.setInput('type', 'tv');
    fixture.componentRef.setInput('season', 2);
    fixture.componentRef.setInput('episode', 3);
    fixture.detectChanges();

    const video = {
      currentTime: 0,
      duration: 1800,
      readyState: 1,
      ended: false,
    } as HTMLVideoElement;

    component.onMetadataLoaded(video);

    expect(component.resumeTime()).toBe(615);
    expect(video.currentTime).toBe(0);

    component.continueFromSavedProgress();
    component.onMetadataLoaded(video);

    expect(video.currentTime).toBe(615);
  });

  it('marks the player paused only after playback has started', () => {
    const video = {
      currentTime: 20,
      duration: 120,
      ended: false,
    } as HTMLVideoElement;

    component.onPlaybackPaused(video);
    expect(component.paused()).toBeFalse();

    component.onPlaybackStarted();
    component.onPlaybackPaused(video);
    expect(component.paused()).toBeTrue();

    component.onPlaybackStarted();
    expect(component.paused()).toBeFalse();

    component.onPlaybackPaused({ ...video, ended: true } as HTMLVideoElement);
    expect(component.paused()).toBeFalse();
  });
});
