import { computed, effect, inject, Injectable, InjectionToken, Signal, signal, untracked } from '@angular/core';
import { CrossfeedStage, createCrossfeedStage, createEqStage, createMonoStage, createWidenerStage, DspStage, EqStage, safeDisconnect, WidenerStage } from '../utils/music-dsp-nodes';
import { DspState, defaultDspState, dspAnyEnabled, sanitizeDspState } from '../utils/music-dsp-math';
import { activeBands, defaultEqState, EqCustomPreset, EqState, needsMidSide, sanitizeCustomPresets, sanitizeEqState } from '../utils/music-eq-core';
import { MusicPlayerService } from './music-player.service';
import { MusicSettingsService } from './music-settings.service';

/** Creates the shared AudioContext (tests provide a fake). Null where Web Audio is unavailable. */
export const MUSIC_AUDIO_CONTEXT_FACTORY = new InjectionToken<() => AudioContext | null>('MUSIC_AUDIO_CONTEXT_FACTORY', {
  providedIn: 'root',
  factory: () => () => {
    if (typeof window === 'undefined') return null;
    const w = window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
    const Ctor = w.AudioContext ?? w.webkitAudioContext;
    if (!Ctor) return null;
    try {
      return new Ctor({ latencyHint: 'playback' });
    } catch {
      try {
        return new Ctor();
      } catch {
        return null;
      }
    }
  },
});

/** What `?musicdebug=1` exposes as `window.__musicGraph` (and `window.__music.audioGraph`). */
export interface MusicGraphDebug {
  graph: MusicAudioGraphService;
  /** Gains (dB) of the live BiquadFilterNodes of the EQ stage (mid chain when mid/side), in band order. */
  filterGains(): number[];
  filterFreqs(): number[];
  sideFilterGains(): number[];
  /** How many MediaElementSources exist (one per deck element). */
  sourceCount(): number;
  /** Names of the stages currently in the chain, in order. */
  chain(): string[];
  contextState(): string;
  contextCreations(): number;
}

type StageName = 'mono' | 'crossfeed' | 'widener' | 'eq';
const STAGE_ORDER: StageName[] = ['mono', 'crossfeed', 'widener', 'eq'];

const GESTURE_EVENTS = ['pointerdown', 'pointerup', 'keydown', 'touchend'] as const;

/**
 * The shared Web Audio graph. Nothing is built until an effect is switched on
 * (or another feature, e.g. the visualizer, calls ensure()):
 *
 *   element sources -> bus -> [mono] -> [crossfeed] -> [widener] -> [EQ] -> analyser -> destination
 *
 * Volume stays on the elements (the player owns it). Stages that are off are
 * not in the chain, so a disabled effect costs no CPU. Each deck element gets
 * exactly one MediaElementSource for the life of the page.
 *
 * Settings: `fiesta:music:eq` (EqState) and `fiesta:music:dsp` (DspState).
 */
@Injectable({ providedIn: 'root' })
export class MusicAudioGraphService {
  private player = inject(MusicPlayerService);
  private settings = inject(MusicSettingsService);
  private makeContext = inject(MUSIC_AUDIO_CONTEXT_FACTORY);

  private readonly eqStored = this.settings.scoped<unknown>('eq', defaultEqState());
  private readonly dspStored = this.settings.scoped<unknown>('dsp', defaultDspState());

  /** Validated EQ settings. */
  readonly eq: Signal<EqState> = computed(() => sanitizeEqState(this.eqStored()));
  /** Validated DSP settings. */
  readonly dsp: Signal<DspState> = computed(() => sanitizeDspState(this.dspStored()));

  private readonly customStored = this.settings.scoped<unknown>('eq-custom-presets', []);
  /** Graphic-EQ presets the user saved. */
  readonly customPresets: Signal<EqCustomPreset[]> = computed(() => sanitizeCustomPresets(this.customStored()));

  private readonly _active = signal(false);
  /** Whether the graph is built and audio is routed through it. */
  readonly active: Signal<boolean> = this._active.asReadonly();
  private readonly _state = signal<string>('none');
  /** AudioContext state ('none' before it exists). */
  readonly contextState: Signal<string> = this._state.asReadonly();

  private ctx: AudioContext | null = null;
  private bus: GainNode | null = null;
  private analyserNode: AnalyserNode | null = null;
  private sources = new WeakMap<HTMLAudioElement, MediaElementAudioSourceNode>();
  private sourceTotal = 0;
  private stages: Partial<Record<StageName, DspStage>> = {};
  private chainNames: StageName[] = [];
  private chainKey = '';
  private creations = 0;
  private started = false;
  private gestureArmed = false;
  private resumeArmed = false;

  constructor() {
    effect(() => {
      const eq = this.eq();
      const dsp = this.dsp();
      untracked(() => this.reconcile(eq, dsp));
    });
  }

  /** Restores settings; builds nothing until needed. Called once by MusicStartupService. */
  start(): void {
    if (this.started || typeof window === 'undefined') return;
    this.started = true;
    if (this.wantsGraph()) this.armGesture();
    if (/[?&]musicdebug=1\b/.test(window.location.search)) this.exposeDebug();
  }

  /** Builds the graph for every element in player.elements(). Call from a user gesture. */
  ensure(): AudioContext | null {
    if (typeof window === 'undefined') return null;
    if (!this.ctx) {
      let ctx: AudioContext | null = null;
      try {
        ctx = this.makeContext();
      } catch {
        ctx = null;
      }
      if (!ctx) return null;
      this.ctx = ctx;
      this.creations++;
      this.bus = ctx.createGain();
      this.analyserNode = ctx.createAnalyser();
      this.analyserNode.fftSize = 1024;
      this.analyserNode.smoothingTimeConstant = 0.7;
      this.analyserNode.connect(ctx.destination);
      ctx.addEventListener('statechange', this.onStateChange);
      document.addEventListener('visibilitychange', this.onVisibility);
      this._state.set(ctx.state);
    }
    this.attachElements();
    this.reconcile(this.eq(), this.dsp(), true);
    this.resume();
    this._active.set(true);
    return this.ctx;
  }

  analyser(): AnalyserNode | null {
    return this.analyserNode;
  }

  context(): AudioContext | null {
    return this.ctx;
  }

  /** Resumes a suspended/interrupted context (needs a user gesture on most browsers). */
  resume(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    this.updateState();
    if (ctx.state !== 'running') {
      try {
        void ctx.resume().then(() => this.updateState(), () => this.armResume());
      } catch {
        // falls through to the gesture retry
      }
      this.armResume();
    }
  }

  /** Changes the EQ settings (call from the click that enables it: that is what unlocks audio). */
  setEq(change: Partial<EqState> | ((s: EqState) => EqState)): void {
    const cur = this.eq();
    const next = sanitizeEqState(typeof change === 'function' ? change(cur) : { ...cur, ...change });
    this.eqStored.set(next);
    this.afterChange();
  }

  /** Changes the DSP settings (mono, crossfeed, widener). */
  setDsp(change: (s: DspState) => DspState): void {
    this.dspStored.set(sanitizeDspState(change(this.dsp())));
    this.afterChange();
  }

  /** Saves the current graphic gains as a named preset and marks it as the active one. */
  saveCustomPreset(name: string): EqCustomPreset {
    const eq = this.eq();
    const preset: EqCustomPreset = {
      id: `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
      name: name.trim().slice(0, 60) || 'My preset',
      count: eq.graphicCount,
      gains: [...eq.graphicGains],
    };
    this.customStored.set([...this.customPresets(), preset].slice(0, 50));
    this.setEq({ graphicPreset: `custom:${preset.id}` });
    return preset;
  }

  deleteCustomPreset(id: string): void {
    this.customStored.set(this.customPresets().filter((p) => p.id !== id));
    if (this.eq().graphicPreset === `custom:${id}`) this.setEq({ graphicPreset: '' });
  }

  // ── internals ────────────────────────────────────────────────────────────

  private wantsGraph(): boolean {
    return this.eq().enabled || dspAnyEnabled(this.dsp());
  }

  private afterChange(): void {
    if (this.wantsGraph() && !this.ctx) this.ensure();
    else this.reconcile(this.eq(), this.dsp());
  }

  /** Effects were on at load: wait for the first gesture to build the graph (a context made without one stays silent). */
  private armGesture(): void {
    if (this.gestureArmed || this.ctx) return;
    this.gestureArmed = true;
    const handler = () => {
      for (const e of GESTURE_EVENTS) document.removeEventListener(e, handler, true);
      this.gestureArmed = false;
      if (this.wantsGraph()) this.ensure();
    };
    for (const e of GESTURE_EVENTS) document.addEventListener(e, handler, { capture: true, passive: true });
  }

  /** Context is not running: the next gesture resumes it. */
  private armResume(): void {
    if (this.resumeArmed || !this.ctx) return;
    this.resumeArmed = true;
    const handler = () => {
      const ctx = this.ctx;
      if (!ctx || ctx.state === 'running') {
        for (const e of GESTURE_EVENTS) document.removeEventListener(e, handler, true);
        this.resumeArmed = false;
        return;
      }
      this.updateState();
      try {
        void ctx.resume().then(() => this.updateState(), () => undefined);
      } catch {
        // retry on the next gesture
      }
    };
    for (const e of GESTURE_EVENTS) document.addEventListener(e, handler, { capture: true, passive: true });
  }

  private updateState(): void {
    if (this.ctx) this._state.set(this.ctx.state);
  }

  private onStateChange = (): void => {
    this.updateState();
    const s = this.ctx?.state as string | undefined;
    if (s === 'suspended' || s === 'interrupted') this.resume();
  };

  private onVisibility = (): void => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    this.resume();
  };

  /** One MediaElementSource per element, ever (a second createMediaElementSource throws InvalidStateError). */
  private attachElements(): void {
    const ctx = this.ctx;
    const bus = this.bus;
    if (!ctx || !bus) return;
    for (const el of this.player.elements()) {
      if (this.sources.has(el)) continue;
      try {
        const src = ctx.createMediaElementSource(el);
        src.connect(bus);
        this.sources.set(el, src);
        this.sourceTotal++;
      } catch (e) {
        console.warn('music: could not tap a deck element', e);
      }
    }
  }

  /** Brings the node graph in line with the settings: rewires only on structural change, else just moves params. */
  private reconcile(eq: EqState, dsp: DspState, force = false): void {
    const ctx = this.ctx;
    const bus = this.bus;
    const analyser = this.analyserNode;
    if (!ctx || !bus || !analyser) return;

    const bands = eq.enabled ? activeBands(eq) : [];
    const ms = eq.enabled && needsMidSide(bands);
    const eqCount = Math.max(1, bands.length);
    const want: StageName[] = [];
    if (dsp.mono) want.push('mono');
    if (dsp.crossfeed.enabled) want.push('crossfeed');
    if (dsp.widener.enabled) want.push('widener');
    if (eq.enabled) want.push('eq');

    let rebuild = force;
    for (const name of STAGE_ORDER) {
      const has = this.stages[name];
      const needed = want.includes(name);
      if (needed && !has) {
        this.stages[name] = this.createStage(name, ctx, dsp, eqCount, ms);
        rebuild = true;
      } else if (!needed && has) {
        has.dispose();
        delete this.stages[name];
        rebuild = true;
      } else if (name === 'eq' && needed && has) {
        const e = has as EqStage;
        if (e.bandCount !== eqCount || e.midSide !== ms) {
          e.dispose();
          this.stages.eq = createEqStage(ctx, eqCount, ms);
          rebuild = true;
        }
      }
    }

    const key = want.join('>');
    if (rebuild || key !== this.chainKey) {
      this.wire(want, bus, analyser);
      this.chainKey = key;
      this.chainNames = want;
    }

    (this.stages.crossfeed as CrossfeedStage | undefined)?.update(dsp.crossfeed.level, dsp.crossfeed.cutoff);
    (this.stages.widener as WidenerStage | undefined)?.update(dsp.widener.width);
    (this.stages.eq as EqStage | undefined)?.update(bands, eq.preamp);
  }

  private createStage(name: StageName, ctx: AudioContext, dsp: DspState, eqCount: number, ms: boolean): DspStage {
    switch (name) {
      case 'mono':
        return createMonoStage(ctx);
      case 'crossfeed':
        return createCrossfeedStage(ctx, dsp.crossfeed.level, dsp.crossfeed.cutoff);
      case 'widener':
        return createWidenerStage(ctx, dsp.widener.width);
      case 'eq':
        return createEqStage(ctx, eqCount, ms);
    }
  }

  private wire(names: StageName[], bus: GainNode, analyser: AnalyserNode): void {
    safeDisconnect(bus);
    for (const n of STAGE_ORDER) safeDisconnect(this.stages[n]?.output);
    let prev: AudioNode = bus;
    for (const n of names) {
      const stage = this.stages[n];
      if (!stage) continue;
      prev.connect(stage.input);
      prev = stage.output;
    }
    prev.connect(analyser);
  }

  private exposeDebug(): void {
    const w = window as unknown as { __musicGraph?: MusicGraphDebug; __music?: Record<string, unknown> };
    const eqStage = () => this.stages.eq as EqStage | undefined;
    const debug: MusicGraphDebug = {
      graph: this,
      filterGains: () => (eqStage()?.filters ?? []).map((f) => f.gain.value),
      filterFreqs: () => (eqStage()?.filters ?? []).map((f) => f.frequency.value),
      sideFilterGains: () => (eqStage()?.sideFilters ?? []).map((f) => f.gain.value),
      sourceCount: () => this.sourceTotal,
      chain: () => [...this.chainNames],
      contextState: () => this.ctx?.state ?? 'none',
      contextCreations: () => this.creations,
    };
    w.__musicGraph = debug;
    // MusicStartupService builds window.__music right after this start() returns.
    setTimeout(() => {
      if (w.__music) w.__music['audioGraph'] = debug;
    }, 0);
  }
}
