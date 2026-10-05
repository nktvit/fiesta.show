// Ported from Monochrome (Apache-2.0), js/settings.js L2085-3254 (parametric canvas graph) - adapted for Fiesta.
import { Component, DestroyRef, ElementRef, afterNextRender, computed, effect, inject, input, model, output, signal, untracked, viewChild } from '@angular/core';
import { FrPoint } from '../../utils/music-autoeq-engine';
import { biquadResponseDb, logSpace } from '../../utils/music-dsp-biquad';
import { clampFreq, clampGain, clampQ, EQ_GAIN_LIMIT, EqBand, EqChannel, EqFilterType } from '../../utils/music-eq-core';

/** An extra curve (dB relative to 0) drawn behind the EQ curve, e.g. the AutoEQ error before/after. */
export interface EqGraphOverlay {
  label: string;
  points: readonly FrPoint[];
  color: string;
  dashed?: boolean;
}

export interface EqBandChange {
  index: number;
  band: EqBand;
}

interface MenuState {
  index: number;
  x: number;
  y: number;
}

const F_MIN = 20;
const F_MAX = 20000;
const PAD = { l: 36, r: 12, t: 12, b: 22 };
const LONG_PRESS_MS = 550;
const MOVE_SLOP = 8;
const FREQ_GRID = [50, 100, 200, 500, 1000, 2000, 5000, 10000];

const xOfFreq = (f: number, w: number) => PAD.l + ((Math.log(f / F_MIN) / Math.log(F_MAX / F_MIN)) * (w - PAD.l - PAD.r));
const freqOfX = (x: number, w: number) => F_MIN * Math.pow(F_MAX / F_MIN, (x - PAD.l) / (w - PAD.l - PAD.r));

/**
 * Interactive parametric EQ graph (canvas, devicePixelRatio aware, pointer events):
 * drag a node for frequency and gain, wheel for Q, long-press (touch) or right-click for
 * the band menu. Keyboard: focus the graph, [ and ] pick a band, arrows move it, Page Up/Down
 * change Q, Enter opens the menu, Delete removes. Everything is also on the numeric band controls.
 */
@Component({
  selector: 'app-music-eq-parametric-graph',
  templateUrl: './music-eq-parametric-graph.component.html',
  host: { class: 'block', '(document:pointerdown)': 'onDocPointer($event)' },
})
export class MusicEqParametricGraphComponent {
  readonly bands = input.required<readonly EqBand[]>();
  readonly selected = model(-1);
  readonly editable = input(true);
  readonly allowRemove = input(true);
  readonly overlays = input<readonly EqGraphOverlay[]>([]);
  readonly bandChange = output<EqBandChange>();
  readonly bandRemove = output<number>();

  private canvas = viewChild<ElementRef<HTMLCanvasElement>>('cv');
  private menuEl = viewChild<ElementRef<HTMLElement>>('menuEl');
  private width = signal(600);
  private height = signal(256);
  protected readonly menu = signal<MenuState | null>(null);
  protected readonly types: { id: EqFilterType; label: string }[] = [
    { id: 'peaking', label: 'Peaking' },
    { id: 'lowshelf', label: 'Low shelf' },
    { id: 'highshelf', label: 'High shelf' },
  ];
  protected readonly channels: { id: EqChannel; label: string }[] = [
    { id: 'stereo', label: 'Stereo (L+R)' },
    { id: 'mid', label: 'Mid only' },
    { id: 'side', label: 'Side only' },
  ];

  protected readonly summary = computed(() => {
    const n = this.bands().length;
    const s = this.selected();
    const b = this.bands()[s];
    return b
      ? `Band ${s + 1} of ${n}: ${Math.round(b.freq)} Hz, ${b.gain.toFixed(1)} dB, Q ${b.q.toFixed(2)}`
      : `${n} bands. Press [ or ] to select one.`;
  });

  private dragging: { index: number; pointerId: number; startX: number; startY: number } | null = null;
  private pressTimer: ReturnType<typeof setTimeout> | null = null;
  private range = 15;
  private observer: ResizeObserver | null = null;

  constructor() {
    effect(() => {
      this.bands();
      this.overlays();
      this.selected();
      this.width();
      this.height();
      const cv = this.canvas();
      if (cv) untracked(() => this.draw(cv.nativeElement));
    });
    afterNextRender(() => {
      const el = this.canvas()?.nativeElement;
      if (!el) return;
      const measure = () => {
        const r = el.getBoundingClientRect();
        if (r.width > 0) this.width.set(Math.round(r.width));
        if (r.height > 0) this.height.set(Math.round(r.height));
      };
      measure();
      if (typeof ResizeObserver !== 'undefined') {
        this.observer = new ResizeObserver(measure);
        this.observer.observe(el);
      }
      // Wheel must be non-passive so the page does not scroll while changing Q.
      el.addEventListener('wheel', this.onWheel, { passive: false });
    });
    inject(DestroyRef).onDestroy(() => {
      this.observer?.disconnect();
      this.canvas()?.nativeElement.removeEventListener('wheel', this.onWheel);
      this.clearPress();
    });
  }

  // ── drawing ──────────────────────────────────────────────────────────────

  private yRange(curve: readonly number[]): number {
    let max = 0;
    for (const v of curve) max = Math.max(max, Math.abs(v));
    for (const b of this.bands()) max = Math.max(max, Math.abs(b.gain));
    for (const o of this.overlays()) for (const p of o.points) max = Math.max(max, Math.abs(p.gain));
    return Math.min(EQ_GAIN_LIMIT, Math.max(15, Math.ceil(max / 5) * 5));
  }

  private draw(el: HTMLCanvasElement): void {
    const w = this.width();
    const h = this.height();
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    if (el.width !== Math.round(w * dpr) || el.height !== Math.round(h * dpr)) {
      el.width = Math.round(w * dpr);
      el.height = Math.round(h * dpr);
    }
    const ctx = el.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const bands = this.bands();
    const freqs = logSpace(F_MIN, F_MAX, 240);
    const curve = freqs.map((f) => bands.reduce((s, b) => s + biquadResponseDb(f, b), 0));
    const R = (this.range = this.yRange(curve));
    const plotH = h - PAD.t - PAD.b;
    const yOf = (db: number) => PAD.t + plotH * (1 - (db + R) / (2 * R));

    // Grid.
    ctx.lineWidth = 1;
    ctx.font = '10px system-ui, sans-serif';
    ctx.fillStyle = '#9ca3af';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'right';
    for (let db = -R; db <= R; db += R / 3) {
      const y = Math.round(yOf(db)) + 0.5;
      ctx.strokeStyle = Math.abs(db) < 0.01 ? 'rgba(255,255,255,0.25)' : 'rgba(255,255,255,0.1)';
      ctx.beginPath();
      ctx.moveTo(PAD.l, y);
      ctx.lineTo(w - PAD.r, y);
      ctx.stroke();
      ctx.fillText(`${db > 0 ? '+' : ''}${Math.round(db)}`, PAD.l - 6, y);
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    for (const f of FREQ_GRID) {
      const x = Math.round(xOfFreq(f, w)) + 0.5;
      ctx.strokeStyle = 'rgba(255,255,255,0.1)';
      ctx.beginPath();
      ctx.moveTo(x, PAD.t);
      ctx.lineTo(x, h - PAD.b);
      ctx.stroke();
      ctx.fillText(f >= 1000 ? `${f / 1000}k` : String(f), x, h - 6);
    }

    // Overlays.
    for (const o of this.overlays()) {
      if (o.points.length < 2) continue;
      ctx.strokeStyle = o.color;
      ctx.lineWidth = 1.5;
      ctx.setLineDash(o.dashed ? [5, 4] : []);
      ctx.beginPath();
      let started = false;
      for (const p of o.points) {
        if (p.freq < F_MIN || p.freq > F_MAX) continue;
        const x = xOfFreq(p.freq, w);
        const y = Math.max(PAD.t, Math.min(h - PAD.b, yOf(p.gain)));
        if (started) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
        started = true;
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Summed response: indigo-400 with a faint fill to the 0 dB line.
    const zero = yOf(0);
    ctx.beginPath();
    freqs.forEach((f, i) => {
      const x = xOfFreq(f, w);
      const y = Math.max(PAD.t, Math.min(h - PAD.b, yOf(curve[i])));
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = '#818cf8';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.lineTo(xOfFreq(F_MAX, w), zero);
    ctx.lineTo(xOfFreq(F_MIN, w), zero);
    ctx.closePath();
    ctx.fillStyle = 'rgba(129,140,248,0.12)';
    ctx.fill();

    // Nodes.
    const sel = this.selected();
    bands.forEach((b, i) => {
      const x = xOfFreq(Math.min(F_MAX, Math.max(F_MIN, b.freq)), w);
      const y = Math.max(PAD.t, Math.min(h - PAD.b, yOf(b.gain)));
      ctx.globalAlpha = b.enabled ? 1 : 0.35;
      if (i === sel) {
        ctx.beginPath();
        ctx.arc(x, y, 11, 0, Math.PI * 2);
        ctx.strokeStyle = '#818cf8';
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.arc(x, y, i === sel ? 7 : 5.5, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      if (b.channel !== 'stereo') {
        ctx.fillStyle = '#c7d2fe';
        ctx.font = 'bold 10px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(b.channel === 'mid' ? 'M' : 'S', x, y - 14);
      }
      ctx.globalAlpha = 1;
    });
  }

  // ── pointer interaction ──────────────────────────────────────────────────

  private localPoint(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const r = this.canvas()?.nativeElement.getBoundingClientRect();
    return r ? { x: e.clientX - r.left, y: e.clientY - r.top } : { x: 0, y: 0 };
  }

  private nodePos(b: EqBand): { x: number; y: number } {
    const w = this.width();
    const plotH = this.height() - PAD.t - PAD.b;
    return {
      x: xOfFreq(Math.min(F_MAX, Math.max(F_MIN, b.freq)), w),
      y: Math.max(PAD.t, Math.min(this.height() - PAD.b, PAD.t + plotH * (1 - (b.gain + this.range) / (2 * this.range)))),
    };
  }

  private hit(p: { x: number; y: number }, touch: boolean): number {
    const radius = touch ? 24 : 16;
    let best = -1;
    let bestD = radius * radius;
    this.bands().forEach((b, i) => {
      const n = this.nodePos(b);
      const d = (n.x - p.x) ** 2 + (n.y - p.y) ** 2;
      if (d <= bestD) {
        bestD = d;
        best = i;
      }
    });
    return best;
  }

  protected onPointerDown(e: PointerEvent): void {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    const p = this.localPoint(e);
    const i = this.hit(p, e.pointerType !== 'mouse');
    this.closeMenu(false);
    if (i < 0) {
      this.selected.set(-1);
      return;
    }
    this.selected.set(i);
    if (!this.editable()) return;
    this.dragging = { index: i, pointerId: e.pointerId, startX: e.clientX, startY: e.clientY };
    try {
      this.canvas()?.nativeElement.setPointerCapture(e.pointerId);
    } catch {
      // capture is best effort
    }
    if (e.pointerType !== 'mouse') {
      this.clearPress();
      const cx = e.clientX;
      const cy = e.clientY;
      this.pressTimer = setTimeout(() => {
        this.pressTimer = null;
        this.dragging = null;
        this.openMenu(i, cx, cy);
      }, LONG_PRESS_MS);
    }
  }

  protected onPointerMove(e: PointerEvent): void {
    const d = this.dragging;
    if (!d || d.pointerId !== e.pointerId || !this.editable()) return;
    if (this.pressTimer && Math.hypot(e.clientX - d.startX, e.clientY - d.startY) > MOVE_SLOP) this.clearPress();
    if (this.pressTimer) return;
    const band = this.bands()[d.index];
    if (!band) return;
    const p = this.localPoint(e);
    const w = this.width();
    const plotH = this.height() - PAD.t - PAD.b;
    const freq = Math.round(clampFreq(Math.min(F_MAX, Math.max(F_MIN, freqOfX(p.x, w)))));
    const gain = Math.round(clampGain((1 - (p.y - PAD.t) / plotH) * 2 * this.range - this.range) * 10) / 10;
    this.bandChange.emit({ index: d.index, band: { ...band, freq, gain } });
  }

  protected onPointerUp(e: PointerEvent): void {
    this.clearPress();
    if (this.dragging && this.dragging.pointerId === e.pointerId) this.dragging = null;
  }

  protected onContextMenu(e: MouseEvent): void {
    e.preventDefault();
    if (!this.editable()) return;
    const i = this.hit(this.localPoint(e), false);
    if (i >= 0) {
      this.selected.set(i);
      this.openMenu(i, e.clientX, e.clientY);
    }
  }

  private onWheel = (e: WheelEvent): void => {
    if (!this.editable()) return;
    const i = this.hit(this.localPoint(e), false);
    const idx = i >= 0 ? i : this.selected();
    const band = this.bands()[idx];
    if (!band) return;
    e.preventDefault();
    if (i >= 0) this.selected.set(i);
    const q = Math.round(clampQ(band.q * Math.exp(-e.deltaY * 0.002)) * 100) / 100;
    this.bandChange.emit({ index: idx, band: { ...band, q } });
  };

  private clearPress(): void {
    if (this.pressTimer) clearTimeout(this.pressTimer);
    this.pressTimer = null;
  }

  // ── keyboard ─────────────────────────────────────────────────────────────

  protected onKeydown(e: KeyboardEvent): void {
    const n = this.bands().length;
    if (n === 0) return;
    let i = this.selected();
    if (e.key === ']' || e.key === '[') {
      i = i < 0 ? 0 : (i + (e.key === ']' ? 1 : -1) + n) % n;
      this.selected.set(i);
      e.preventDefault();
      return;
    }
    const band = this.bands()[i];
    if (!band || !this.editable()) return;
    const fine = e.shiftKey;
    let next: EqBand | null = null;
    switch (e.key) {
      case 'ArrowLeft':
      case 'ArrowRight': {
        const step = Math.pow(2, (e.key === 'ArrowRight' ? 1 : -1) * (fine ? 1 / 24 : 1 / 6));
        next = { ...band, freq: Math.round(clampFreq(band.freq * step)) };
        break;
      }
      case 'ArrowUp':
      case 'ArrowDown':
        next = { ...band, gain: Math.round(clampGain(band.gain + (e.key === 'ArrowUp' ? 1 : -1) * (fine ? 0.1 : 0.5)) * 10) / 10 };
        break;
      case 'PageUp':
      case 'PageDown':
        next = { ...band, q: Math.round(clampQ(band.q * (e.key === 'PageUp' ? 1.1 : 1 / 1.1)) * 100) / 100 };
        break;
      case 'Delete':
      case 'Backspace':
        if (this.allowRemove()) {
          this.bandRemove.emit(i);
          e.preventDefault();
        }
        return;
      case 'Enter':
      case 'ContextMenu': {
        const pos = this.nodePos(band);
        const r = this.canvas()?.nativeElement.getBoundingClientRect();
        this.openMenu(i, (r?.left ?? 0) + pos.x, (r?.top ?? 0) + pos.y);
        e.preventDefault();
        return;
      }
      default:
        return;
    }
    e.preventDefault();
    this.bandChange.emit({ index: i, band: next });
  }

  // ── band menu ────────────────────────────────────────────────────────────

  private openMenu(index: number, clientX: number, clientY: number): void {
    const vw = typeof window !== 'undefined' ? window.innerWidth : 800;
    const vh = typeof window !== 'undefined' ? window.innerHeight : 600;
    this.menu.set({ index, x: Math.max(8, Math.min(vw - 232, clientX)), y: Math.max(8, Math.min(vh - 330, clientY)) });
    setTimeout(() => this.menuEl()?.nativeElement.querySelector<HTMLElement>('button')?.focus(), 0);
  }

  protected closeMenu(restoreFocus = true): void {
    if (!this.menu()) return;
    this.menu.set(null);
    if (restoreFocus) this.canvas()?.nativeElement.focus();
  }

  protected onDocPointer(e: PointerEvent): void {
    const m = this.menuEl()?.nativeElement;
    if (this.menu() && m && !m.contains(e.target as Node)) this.closeMenu(false);
  }

  protected onMenuKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      this.closeMenu();
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const items = Array.from(this.menuEl()?.nativeElement.querySelectorAll<HTMLElement>('button') ?? []);
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next = items[(at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length];
    next?.focus();
    e.preventDefault();
  }

  protected menuBand(): EqBand | null {
    const m = this.menu();
    return m ? (this.bands()[m.index] ?? null) : null;
  }

  protected setType(type: EqFilterType): void {
    const m = this.menu();
    const b = this.menuBand();
    if (m && b) this.bandChange.emit({ index: m.index, band: { ...b, type } });
  }

  protected setChannel(channel: EqChannel): void {
    const m = this.menu();
    const b = this.menuBand();
    if (m && b) this.bandChange.emit({ index: m.index, band: { ...b, channel } });
  }

  protected resetGain(): void {
    const m = this.menu();
    const b = this.menuBand();
    if (m && b) this.bandChange.emit({ index: m.index, band: { ...b, gain: 0 } });
    this.closeMenu();
  }

  protected removeBand(): void {
    const m = this.menu();
    if (m) this.bandRemove.emit(m.index);
    this.closeMenu();
  }
}
