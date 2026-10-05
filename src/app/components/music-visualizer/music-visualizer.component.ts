import {
  Component, DestroyRef, ElementRef, computed, effect, inject, input, untracked, viewChild,
} from '@angular/core';
import { signal } from '@angular/core';
import { MusicAudioGraphService } from '../../services/music-audio-graph.service';
import { MusicSettingsService } from '../../services/music-settings.service';
import { createVizStats, updateVizStats } from '../../utils/music-visualizer-analysis';
import { createVizPreset } from '../../utils/music-visualizer-factory';
import {
  MUSIC_VIZ_DEFAULT_PRESET, MUSIC_VIZ_PRESETS, MUSIC_VIZ_SCOPED_DEFAULTS, MusicVizScoped, bindVizControl, isVizPreset,
} from '../../utils/music-visualizer-presets';
import { VizPreset } from '../../utils/music-visualizer-types';

/** Accent for the drawing (indigo-400). */
const ACCENT = '#818cf8';
/** Device-pixel cap: the visualizers are soft, 1.5x is plenty and keeps WebGL cheap. */
const MAX_DPR = 1.5;

/**
 * Audio visualizer layer; fills its parent (absolute inset-0). Owned by package P5.
 *
 * Draws on a canvas that is recreated on every preset switch. The frame loop
 * runs only while `active()` is true, the document is visible and (unless
 * "Animate anyway" is on) the user does not prefer reduced motion.
 */
@Component({
  selector: 'app-music-visualizer',
  templateUrl: './music-visualizer.component.html',
  host: {
    class: 'pointer-events-none absolute inset-0 block',
    '[attr.data-viz-status]': 'status()',
    '[attr.data-viz-preset]': 'preset()',
    '[attr.data-viz-running]': 'running()',
  },
})
export class MusicVisualizerComponent {
  private readonly settings = inject(MusicSettingsService);
  private readonly graph = inject(MusicAudioGraphService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly destroyRef = inject(DestroyRef);

  /** Draw (and run the loop) only while true. */
  readonly active = input.required<boolean>();
  /** Cover for presets that use it (Kawarp). */
  readonly coverUrl = input('');
  /** Over the cover: no opaque background, canvas blended with `screen` at 0.85. */
  readonly blended = input(false);
  /** The preset picker / cycle / sensitivity cluster in the bottom-left corner. */
  readonly showControls = input(true);

  private readonly stage = viewChild<ElementRef<HTMLDivElement>>('stage');

  protected readonly presets = MUSIC_VIZ_PRESETS;
  protected readonly cfg = this.settings.scoped<MusicVizScoped>('visualizer', { ...MUSIC_VIZ_SCOPED_DEFAULTS });
  protected readonly preset = computed(() => {
    const id = this.settings.visualizerPreset();
    return isVizPreset(id) ? id : MUSIC_VIZ_DEFAULT_PRESET;
  });

  protected readonly status = signal<'idle' | 'starting' | 'ready' | 'unavailable' | 'error'>('idle');
  protected readonly reducedMotion = signal(false);
  private readonly docVisible = signal(true);
  /** True while the rAF loop is scheduled. */
  protected readonly running = signal(false);

  protected readonly paused = computed(() => this.reducedMotion() && !this.cfg().animateAnyway);
  private readonly shouldRun = computed(
    () => this.active() && this.docVisible() && !this.paused() && this.status() === 'ready',
  );

  private current: VizPreset | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private generation = 0;
  private raf: number | null = null;
  private frames = 0;
  private analyser: AnalyserNode | null = null;
  private data: Uint8Array<ArrayBuffer> = new Uint8Array(0);
  private readonly stats = createVizStats();
  private resizeObserver: ResizeObserver | null = null;

  constructor() {
    const unbind = bindVizControl({
      getPreset: () => this.preset(),
      setPreset: (id) => {
        if (isVizPreset(id)) this.settings.visualizerPreset.set(id);
      },
      getCycle: () => this.cfg().cycle,
      setCycle: (on) => this.cfg.update((c) => ({ ...c, cycle: on })),
    });
    this.destroyRef.onDestroy(() => {
      unbind();
      this.teardown();
      this.resizeObserver?.disconnect();
    });

    if (typeof window !== 'undefined') {
      const mq = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
      if (mq) {
        this.reducedMotion.set(mq.matches);
        const onMq = (e: MediaQueryListEvent) => this.reducedMotion.set(e.matches);
        mq.addEventListener?.('change', onMq);
        this.destroyRef.onDestroy(() => mq.removeEventListener?.('change', onMq));
      }
      this.docVisible.set(!document.hidden);
      const onVis = () => this.docVisible.set(!document.hidden);
      document.addEventListener('visibilitychange', onVis);
      this.destroyRef.onDestroy(() => document.removeEventListener('visibilitychange', onVis));
    }

    // (Re)build the pipeline when activated, when the preset changes, or when the audio graph appears.
    effect(() => {
      const on = this.active();
      const id = this.preset();
      this.graph.active();
      this.stage();
      untracked(() => {
        if (on) void this.setup(id);
        else this.teardown();
      });
    });

    // Follow the cover for presets that use it.
    effect(() => {
      const url = this.coverUrl();
      untracked(() => this.current?.setCover?.(url));
    });

    // The frame loop.
    effect(() => {
      const run = this.shouldRun();
      untracked(() => (run ? this.startLoop() : this.stopLoop()));
    });

    // Auto-cycle through the presets.
    effect((onCleanup) => {
      const c = this.cfg();
      if (!this.active() || !c.cycle || typeof window === 'undefined') return;
      const ms = Math.max(5, Math.min(300, c.cycleSeconds)) * 1000;
      const t = setInterval(() => {
        const i = MUSIC_VIZ_PRESETS.findIndex((p) => p.id === this.preset());
        this.settings.visualizerPreset.set(MUSIC_VIZ_PRESETS[(i + 1) % MUSIC_VIZ_PRESETS.length].id);
      }, ms);
      onCleanup(() => clearInterval(t));
    });
  }

  protected pick(id: string): void {
    if (isVizPreset(id)) this.settings.visualizerPreset.set(id);
  }

  protected toggleCycle(): void {
    this.cfg.update((c) => ({ ...c, cycle: !c.cycle }));
  }

  protected toggleAnimateAnyway(): void {
    this.cfg.update((c) => ({ ...c, animateAnyway: !c.animateAnyway }));
  }

  protected setSensitivity(v: string): void {
    const n = Math.min(2, Math.max(0.25, Number(v) || 1));
    this.cfg.update((c) => ({ ...c, sensitivity: n }));
  }

  // ── pipeline ─────────────────────────────────────────────────────────────

  private async setup(id: string): Promise<void> {
    this.teardown(false); // bumps the generation: any older setup still awaiting a preset bows out
    const gen = this.generation;
    const stage = this.stage()?.nativeElement;
    if (!stage) return;
    this.status.set('starting');

    // Inside the Visualizer button click (or just after): build the graph, then read its analyser.
    let ctx: AudioContext | null = null;
    try {
      ctx = this.graph.ensure() ?? this.graph.context();
    } catch {
      ctx = null;
    }
    const analyser = this.graph.analyser();
    if (!analyser) {
      this.status.set('unavailable');
      return;
    }

    const canvas = document.createElement('canvas');
    canvas.className = 'absolute inset-0 h-full w-full';
    canvas.setAttribute('aria-hidden', 'true');
    canvas.dataset['preset'] = id;
    this.applyBlend(canvas);
    stage.replaceChildren(canvas);
    this.sizeCanvas(canvas, stage);

    const preset = createVizPreset(id);
    let ok = false;
    try {
      ok = await preset.attach(canvas, { analyser, audioContext: ctx, coverUrl: this.coverUrl() });
    } catch {
      ok = false;
    }
    if (gen !== this.generation) {
      preset.destroy();
      return;
    }
    if (!ok) {
      preset.destroy();
      canvas.remove();
      this.status.set('error');
      return;
    }
    this.current = preset;
    this.canvas = canvas;
    this.analyser = analyser;
    this.data = new Uint8Array(analyser.frequencyBinCount);
    preset.resize(canvas.width, canvas.height);

    this.resizeObserver?.disconnect();
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => {
        if (this.canvas && this.current) {
          this.sizeCanvas(this.canvas, stage);
          this.current.resize(this.canvas.width, this.canvas.height);
        }
      });
      this.resizeObserver.observe(stage);
    }
    this.status.set('ready');
  }

  private teardown(resetStatus = true): void {
    this.generation++;
    this.stopLoop();
    this.resizeObserver?.disconnect();
    this.current?.destroy();
    this.current = null;
    this.canvas?.remove();
    this.canvas = null;
    this.analyser = null;
    if (resetStatus) this.status.set('idle');
  }

  private applyBlend(canvas: HTMLCanvasElement): void {
    if (this.blended()) {
      canvas.style.mixBlendMode = 'screen';
      canvas.style.opacity = '0.85';
    }
  }

  private sizeCanvas(canvas: HTMLCanvasElement, stage: HTMLElement): void {
    const dpr = Math.min(MAX_DPR, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(stage.clientWidth * dpr));
    const h = Math.max(1, Math.round(stage.clientHeight * dpr));
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
  }

  // ── frame loop ───────────────────────────────────────────────────────────

  private startLoop(): void {
    if (this.raf !== null || !this.current) return;
    this.current.resume?.();
    this.running.set(true);
    const visualizerTick = () => {
      this.raf = null;
      if (!this.shouldRun() || !this.current || !this.canvas) {
        this.running.set(false);
        return;
      }
      this.frame();
      this.raf = requestAnimationFrame(visualizerTick);
    };
    this.raf = requestAnimationFrame(visualizerTick);
  }

  private stopLoop(): void {
    if (this.raf !== null) {
      cancelAnimationFrame(this.raf);
      this.raf = null;
    }
    this.current?.pause?.();
    if (this.running()) this.running.set(false);
  }

  private frame(): void {
    const p = this.current;
    const canvas = this.canvas;
    const an = this.analyser;
    if (!p || !canvas || !an) return;
    try {
      if (this.data.length !== an.frequencyBinCount) this.data = new Uint8Array(an.frequencyBinCount);
      an.getByteFrequencyData(this.data);
      updateVizStats(this.stats, {
        data: this.data,
        sampleRate: an.context.sampleRate,
        fftSize: an.fftSize,
        volume: this.settings.muted() ? 0 : this.settings.volume(),
        sensitivity: this.cfg().sensitivity,
        now: performance.now(),
      });
      p.draw({
        canvas, analyser: an, data: this.data, stats: this.stats, blended: this.blended(), color: ACCENT,
      });
      this.frames++;
      this.host.nativeElement.dataset['frames'] = String(this.frames);
    } catch {
      // A bad frame (lost context, closed audio context) must not kill the loop.
    }
  }
}
