import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MusicAudioGraphService } from '../../services/music-audio-graph.service';
import { MusicVisualizerComponent } from './music-visualizer.component';

let current: ComponentFixture<MusicVisualizerComponent> | null = null;
const until = async (fn: () => boolean, ms = 4000) => {
  const t0 = Date.now();
  current?.detectChanges();
  while (!fn() && Date.now() - t0 < ms) {
    await new Promise((r) => setTimeout(r, 25));
    current?.detectChanges();
  }
  return fn();
};

describe('MusicVisualizerComponent', () => {
  let ctx: AudioContext | null = null;
  let analyser: AnalyserNode | null = null;
  let fixture: ComponentFixture<MusicVisualizerComponent>;
  const host = () => fixture.nativeElement as HTMLElement;

  const make = (withAnalyser: boolean) => {
    // Some machines run the browser with prefers-reduced-motion; the loop test wants the opt-in on.
    window.localStorage.setItem('fiesta:music:visualizer', JSON.stringify({ cycle: false, cycleSeconds: 30, sensitivity: 1, animateAnyway: true }));
    ctx = new AudioContext();
    const osc = ctx.createOscillator();
    analyser = withAnalyser ? ctx.createAnalyser() : null;
    if (analyser) {
      analyser.fftSize = 1024;
      osc.connect(analyser);
      osc.start();
    }
    TestBed.configureTestingModule({
      providers: [{
        provide: MusicAudioGraphService,
        useValue: { active: signal(true), ensure: () => ctx, context: () => ctx, analyser: () => analyser },
      }],
    });
    fixture = TestBed.createComponent(MusicVisualizerComponent);
    current = fixture;
    fixture.componentRef.setInput('active', true);
    fixture.detectChanges();
  };

  afterEach(() => {
    fixture?.destroy();
    void ctx?.close();
    window.localStorage.removeItem('fiesta:music:visualizer');
  });

  it('draws on a canvas while active, and its loop stops (and the canvas goes) when active becomes false', async () => {
    make(true);
    expect(await until(() => host().dataset['vizStatus'] === 'ready')).toBe(true);
    expect(host().querySelector('canvas')).not.toBeNull();
    expect(await until(() => host().dataset['vizRunning'] === 'true')).toBe(true);
    const f1 = Number(host().dataset['frames'] ?? 0);
    expect(await until(() => Number(host().dataset['frames'] ?? 0) > f1 + 2)).toBe(true);

    fixture.componentRef.setInput('active', false);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(host().dataset['vizRunning']).toBe('false');
    expect(host().querySelector('canvas')).toBeNull();
    const f2 = Number(host().dataset['frames'] ?? 0);
    await new Promise((r) => setTimeout(r, 200));
    expect(Number(host().dataset['frames'] ?? 0)).toBe(f2);
  });

  it('says so when the audio graph has no analyser', async () => {
    make(false);
    expect(await until(() => host().dataset['vizStatus'] === 'unavailable')).toBe(true);
    expect(host().textContent).toContain('Visualizer unavailable in this browser');
    expect(host().querySelector('canvas')).toBeNull();
  });

  it('lists the five presets in the picker', async () => {
    make(true);
    await until(() => host().dataset['vizStatus'] === 'ready');
    fixture.detectChanges();
    const labels = Array.from(host().querySelectorAll('select[aria-label="Visualizer preset"] option')).map((o) => o.textContent?.trim());
    expect(labels).toEqual(['Particles', 'LCD', 'Unknown Pleasures', 'Butterchurn', 'Kawarp']);
  });
});
