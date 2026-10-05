import { TestBed } from '@angular/core/testing';
import { musicStorage } from '../utils/music-storage';
import { MUSIC_AUDIO_CONTEXT_FACTORY, MusicAudioGraphService, MusicGraphDebug } from './music-audio-graph.service';
import { MusicPlayerService } from './music-player.service';

class FakeParam {
  value = 0;
  setTargetAtTime(v: number): void { this.value = v; }
}

class FakeNode {
  connections: FakeNode[] = [];
  gain = new FakeParam();
  frequency = new FakeParam();
  Q = new FakeParam();
  delayTime = new FakeParam();
  type = 'peaking';
  channelCount = 2;
  channelCountMode = 'max';
  channelInterpretation = 'speakers';
  fftSize = 0;
  smoothingTimeConstant = 0;
  connect(n: FakeNode): FakeNode { this.connections.push(n); return n; }
  disconnect(): void { this.connections = []; }
}

const tapped = new WeakSet<object>();

class FakeContext extends EventTarget {
  state = 'running';
  currentTime = 0;
  sampleRate = 48000;
  destination = new FakeNode();
  resumeCalls = 0;
  createGain(): FakeNode { return new FakeNode(); }
  createBiquadFilter(): FakeNode { return new FakeNode(); }
  createChannelSplitter(): FakeNode { return new FakeNode(); }
  createChannelMerger(): FakeNode { return new FakeNode(); }
  createDelay(): FakeNode { return new FakeNode(); }
  createAnalyser(): FakeNode { return new FakeNode(); }
  createMediaElementSource(el: object): FakeNode {
    if (tapped.has(el)) throw new DOMException('already connected', 'InvalidStateError');
    tapped.add(el);
    return new FakeNode();
  }
  resume(): Promise<void> {
    this.resumeCalls++;
    this.state = 'running';
    this.dispatchEvent(new Event('statechange'));
    return Promise.resolve();
  }
}

describe('MusicAudioGraphService', () => {
  let created: FakeContext[];
  let els: HTMLAudioElement[];

  const setup = (): MusicAudioGraphService => {
    created = [];
    els = [{} as HTMLAudioElement, {} as HTMLAudioElement];
    TestBed.configureTestingModule({
      providers: [
        { provide: MusicPlayerService, useValue: { elements: () => els, on: () => () => undefined } },
        { provide: MUSIC_AUDIO_CONTEXT_FACTORY, useValue: () => { const c = new FakeContext(); created.push(c); return c as unknown as AudioContext; } },
      ],
    });
    return TestBed.inject(MusicAudioGraphService);
  };

  beforeEach(() => {
    musicStorage.remove('eq');
    musicStorage.remove('dsp');
  });

  it('builds nothing at start and no AudioContext until an effect is enabled', () => {
    const g = setup();
    g.start();
    expect(created.length).toBe(0);
    expect(g.active()).toBeFalse();
    expect(g.analyser()).toBeNull();
    expect(g.context()).toBeNull();
    g.setEq({ mode: 'parametric' });
    expect(created.length).toBe(0);
  });

  it('enabling the EQ creates one context, taps each deck element once and goes active', () => {
    const g = setup();
    g.start();
    g.setEq({ enabled: true });
    expect(created.length).toBe(1);
    expect(g.active()).toBeTrue();
    expect(g.analyser()).not.toBeNull();
    expect(tapped.has(els[0]) && tapped.has(els[1])).toBeTrue();
  });

  it('toggling the EQ and the DSP stages repeatedly never throws InvalidStateError or makes a second context', () => {
    const g = setup();
    g.start();
    expect(() => {
      for (let i = 0; i < 20; i++) {
        g.setEq({ enabled: i % 2 === 0 });
        g.setDsp((s) => ({ ...s, mono: i % 3 === 0 }));
        g.ensure();
      }
    }).not.toThrow();
    expect(created.length).toBe(1);
  });

  it('ensure() alone (P5) builds a context with an empty chain', () => {
    const g = setup();
    g.start();
    expect(g.ensure()).not.toBeNull();
    expect(created.length).toBe(1);
    expect(g.active()).toBeTrue();
  });

  it('exposes the live filters, chain order and source count through the debug hook', () => {
    const g = setup();
    window.history.replaceState({}, '', window.location.pathname + '?musicdebug=1');
    try {
      g.start();
      const dbg = (window as unknown as { __musicGraph?: MusicGraphDebug }).__musicGraph!;
      expect(dbg).toBeDefined();
      g.setEq({ enabled: true, preamp: -3 });
      g.setDsp((s) => ({ ...s, mono: true, crossfeed: { ...s.crossfeed, enabled: true }, widener: { ...s.widener, enabled: true } }));
      expect(dbg.chain()).toEqual(['mono', 'crossfeed', 'widener', 'eq']);
      expect(dbg.filterGains().length).toBe(10);
      expect(dbg.sourceCount()).toBe(2);
      const gains = [...g.eq().graphicGains];
      gains[2] = 5;
      g.setEq({ graphicGains: gains });
      expect(dbg.filterGains()[2]).toBe(5);
      g.setDsp((s) => ({ ...s, mono: false }));
      expect(dbg.chain()).toEqual(['crossfeed', 'widener', 'eq']);
      // Mid/side: two parallel chains.
      g.setEq((s) => ({ ...s, mode: 'parametric', bands: s.bands.map((b, i) => (i === 0 ? { ...b, gain: 4, channel: 'side' as const } : b)) }));
      expect(dbg.sideFilterGains().length).toBe(10);
      expect(dbg.filterGains()[0]).toBe(0);
      expect(dbg.sideFilterGains()[0]).toBe(4);
    } finally {
      window.history.replaceState({}, '', window.location.pathname);
      delete (window as unknown as { __musicGraph?: unknown }).__musicGraph;
    }
  });

  it('resumes after a statechange to interrupted/suspended and after visibilitychange', () => {
    const g = setup();
    g.start();
    g.setEq({ enabled: true });
    const ctx = created[0];
    const before = ctx.resumeCalls;
    ctx.state = 'interrupted';
    ctx.dispatchEvent(new Event('statechange'));
    expect(ctx.resumeCalls).toBeGreaterThan(before);
    expect(ctx.state).toBe('running');

    const mid = ctx.resumeCalls;
    ctx.state = 'suspended';
    spyOnProperty(document, 'visibilityState', 'get').and.returnValue('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(ctx.resumeCalls).toBeGreaterThan(mid);
    expect(g.contextState()).toBe('running');
  });

  it('re-applies stored settings after the first user gesture on a fresh load', () => {
    musicStorage.write('eq', { v: 1, enabled: true, mode: 'graphic' });
    const g = setup();
    g.start();
    expect(created.length).toBe(0);
    document.dispatchEvent(new Event('pointerdown'));
    expect(created.length).toBe(1);
    expect(g.active()).toBeTrue();
    expect(g.eq().enabled).toBeTrue();
  });
});
