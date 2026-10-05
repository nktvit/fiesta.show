import { Component, computed, effect, ElementRef, inject, input, OnDestroy, signal, viewChild } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { ContentRef, LikesCommentsService } from '../../services/likes-comments.service';

// The particles are the button's OWN heart — the same path the filled <svg> in
// the template draws — rather than the ❤️ emoji this used to fire. A text
// shape is a *bitmap* shape, and canvas-confetti draws bitmaps at
// scaleX = scalar·|cos(wobble)|, scaleY = scalar·|sin(wobble)|; those are 90°
// out of phase, so the glyph is never full size on both axes at once and twice
// per wobble cycle one axis passes through zero. That is what turned the old
// burst into thin red slivers. `flat: true` (below) pins wobble to 0, fixing
// it for any shape; going to a path shape on top of that means the `colors`
// option applies (it is ignored for bitmaps, so the old call's colours did
// nothing) and drops the emoji-font dependency.
const HEART_PATH =
  'M11.645 20.91l-.007-.003-.022-.012a15.247 15.247 0 01-.383-.218 25.18 25.18 0 01-4.244-3.17C4.688 15.36 2.25 12.174 2.25 8.25 2.25 5.322 4.714 3 7.688 3A5.5 5.5 0 0112 5.052 5.5 5.5 0 0116.313 3c2.973 0 5.437 2.322 5.437 5.25 0 3.925-2.438 7.111-4.739 9.256a25.175 25.175 0 01-4.244 3.17 15.247 15.247 0 01-.383.219l-.022.012-.007.004-.003.001a.752.752 0 01-.704 0l-.003-.001z';

// Supplied by hand so shapeFromPath's 250,000-call isPointInPath bbox scan
// never runs on the first click. It follows the same convention — normalise
// the path's longer side to 10 units and centre it on the origin — computed
// from the path's exact bbox (x 2.25–21.75, y 3–20.91): scale = 10/19.5 =
// 0.5128, offset = -round(12)·scale. A particle is then 10·scalar wide, so
// scalar 1.15 gives 11.5px — the same size as the 14px icon's own glyph.
// The matrix must stay a plain array: canvas-confetti gates the path branch on
// Array.isArray(shape.matrix) and feeds it to `new DOMMatrix(...)`. @types
// declares DOMMatrix here, which the library itself never produces.
const HEART_SHAPE: import('canvas-confetti').Shape = {
  type: 'path',
  path: HEART_PATH,
  matrix: [0.5128, 0, 0, 0.5128, -6.1538, -6.1538] as unknown as DOMMatrix,
};

// Lighter than every stop in the indigo→fuchsia→pink gradient the pill turns
// into once liked, so the hearts hold up while still over it, and saturated
// enough to read against #0a0a0a. The layer this replaces was #6366f1/#d946ef
// drawn onto that same gradient, which is why it measured as running and
// looked like nothing.
const HEART_COLORS = ['#ff4d79', '#ff5e8a', '#ff8fb1'];
const SPARK_COLORS = ['#ffffff', '#ffe3ef', '#ffc7dd'];

// Geometry of the burst canvas, mirrored EXACTLY by the Tailwind utilities on
// <canvas #burstCanvas> in the template (w-[170px] h-[120px] -top-[70px],
// centred by left-1/2 -translate-x-1/2). The canvas edge clips silently, so
// growing the particle envelope past it guillotines hearts rather than erroring.
const BURST_W = 170;
const BURST_H = 120;
// The emitter sits dead centre on the button's TOP EDGE, so hearts rise out of
// the pill's rim instead of climbing through its own gradient. Centring on the
// button rather than on the heart icon is what keeps the whole plume on-screen
// at 360px, where the pill wraps onto its own line at x=16 and <main>'s
// overflow-x:hidden would otherwise slice the leftmost hearts in half.
const BURST_ORIGIN = { x: 0.5, y: 70 / BURST_H };

/**
 * The compact "Fiesta N" like pill next to the ratings. Split out of
 * LikesCommentsComponent so the comment thread (the bulk of that component)
 * can be @defer-ed below the fold without dragging this above-the-fold
 * control along, and so this one stays eager and tiny.
 */
@Component({
  selector: 'app-like-badge',
  imports: [DecimalPipe],
  templateUrl: './like-badge.component.html',
  styleUrl: './like-badge.component.css',
})
export class LikeBadgeComponent implements OnDestroy {
  readonly imdbId = input<string>('');
  readonly type = input<string>('movie');
  readonly season = input<number | null>(null);
  readonly episode = input<number | null>(null);

  private readonly service = inject(LikesCommentsService);

  // The burst paints into this canvas, which is parented to the button.
  private readonly burstCanvas = viewChild<ElementRef<HTMLCanvasElement>>('burstCanvas');
  private cannon: import('canvas-confetti').CreateTypes | null = null;
  private cannonPromise: Promise<import('canvas-confetti').CreateTypes> | null = null;
  // Bumped by anything that should abandon a burst that hasn't started yet —
  // an unlike, or a second click — since the library import is asynchronous.
  private burstToken = 0;
  private destroyed = false;

  readonly likeCount = signal(0);
  readonly liked = signal(false);
  // Drives the heart-pop + particle-burst animation for one cycle right
  // after a fresh like (not on unlike, and not on the initial server fetch).
  readonly justLiked = signal(false);
  private burstTimeout: ReturnType<typeof setTimeout> | null = null;

  private readonly readyRef = computed<ContentRef | null>(() => {
    const imdbId = this.imdbId();
    if (!imdbId) return null;
    const ref: ContentRef = { imdbId, type: this.type(), season: this.season(), episode: this.episode() };
    if (ref.type === 'tv' && (!ref.season || !ref.episode)) return null;
    return ref;
  });

  constructor() {
    effect(() => {
      const ref = this.readyRef();
      if (ref) this.reload(ref);
    });
  }

  // Clears burstTimeout and cancels the rAF loop / canvas: without it a burst fired
  // moments before a route change keeps animating against a detached view.
  ngOnDestroy(): void {
    this.destroyed = true;
    if (this.burstTimeout) clearTimeout(this.burstTimeout);
    this.cannon?.reset();
  }

  private reload(ref: ContentRef): void {
    this.service.getLikes(ref).subscribe({
      next: (res) => {
        this.likeCount.set(res.count);
        this.liked.set(res.liked);
      },
      error: () => {},
    });
  }

  toggleLike(): void {
    const ref = this.readyRef();
    if (!ref) return;

    const nextLiked = !this.liked();
    const prevCount = this.likeCount();
    this.liked.set(nextLiked);
    this.likeCount.set(prevCount + (nextLiked ? 1 : -1));

    if (nextLiked) {
      if (this.burstTimeout) clearTimeout(this.burstTimeout);
      this.justLiked.set(true);
      this.burstTimeout = setTimeout(() => this.justLiked.set(false), 650);
      void this.fireHearts();
    } else {
      if (this.burstTimeout) clearTimeout(this.burstTimeout);
      this.justLiked.set(false);
      // An unlike has to take the burst with it. Without the reset(), hearts
      // keep pouring out for another second and a half from a pill that has
      // already gone grey and counted back down. Bumping the token covers the
      // other half: a burst still waiting on the dynamic import never fires.
      this.burstToken++;
      this.cannon?.reset();
    }

    this.service.toggleLike(ref, nextLiked ? 'like' : 'unlike').subscribe({
      next: (res) => {
        this.likeCount.set(res.count);
        this.liked.set(res.liked);
      },
      error: () => {
        this.liked.set(!nextLiked);
        this.likeCount.set(prevCount);
      },
    });
  }

  // Called from (pointerenter)/(focus) on the button. The chunk is only ~4 kB,
  // but on a cold cache the round trip is enough to leave a visible gap
  // between the click and the first heart — measured ~150ms against a real
  // preview, i.e. the burst arrives after the pill has already turned. Warming
  // it on approach closes that, while still downloading nothing for a visitor
  // who never goes near the button, and nothing at all under reduced motion.
  preloadBurst(): void {
    void this.ensureCannon();
  }

  // One cannon for the component's lifetime, on our own canvas. The ??= is
  // what makes this idempotent, so a hover, a focus and two fast clicks all
  // share a single import and a single create().
  private ensureCannon(): Promise<import('canvas-confetti').CreateTypes> | null {
    if (typeof window === 'undefined') return null;
    const canvas = this.burstCanvas()?.nativeElement;
    if (!canvas) return null;
    // Checked here rather than delegated to the library: canvas-confetti
    // samples this once when a cannon is constructed and caches it for that
    // cannon's whole life, and returning first means a reduced-motion visitor
    // never even downloads the chunk. (Lazily imported so it stays out of the
    // initial bundle — the same treatment hls.js already gets on the player.)
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return null;
    this.cannonPromise ??= import('canvas-confetti').then((m) => {
      const fire = m.default.create(canvas, { resize: false, disableForReducedMotion: true });
      this.cannon = fire;
      return fire;
    });
    return this.cannonPromise;
  }

  // A small fan of hearts spilling out of the pill's own top edge.
  //
  // The numbers below are the whole fix, so they are worth stating: travel
  // along the launch direction is a geometric series, total = v0/(1 - decay)
  // with v0 randomised over [0.5, 1.5]·startVelocity, and `gravity` is NOT an
  // acceleration — canvas-confetti adds 3·gravity to y once per tick, so the
  // total fall is just 3·gravity·ticks. The version this replaces used
  // startVelocity 28 at the default decay 0.9 (= up to 420px of travel) with
  // gravity 0.7 over 170 ticks (= 357px of rain), which is why the hearts were
  // already 150-300px away over the hero photo 120ms after the click and
  // nothing was ever visible at the button. Measured here: ~45px up, ~44px to
  // each side, last pixel gone by ~950ms.
  private async fireHearts(): Promise<void> {
    const canvas = this.burstCanvas()?.nativeElement;
    const pending = this.ensureCannon();
    if (!canvas || !pending) return;

    // The physics run in backing-store pixels, so every LENGTH below is scaled
    // by `s` to keep the burst the same physical size on a Retina screen.
    // decay, ticks, spread and the origin are ratios and are not. Safe to do
    // after create(): the library reads canvas.width per fire, not per cannon.
    const s = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.round(BURST_W * s);
    if (canvas.width !== w) {
      canvas.width = w;
      canvas.height = Math.round(BURST_H * s);
    }

    const token = ++this.burstToken;
    const fire = await pending;
    // If the import was cold, the like may have been undone by now, or the
    // whole view thrown away.
    if (this.destroyed) {
      fire.reset();
      return;
    }
    if (token !== this.burstToken || !this.liked()) return;

    const base = { origin: BURST_ORIGIN, flat: true, disableForReducedMotion: true };

    // Fired first so the hearts paint over it: a fast, near-white spray that
    // reads as the impact and lifts the burst off whatever it crosses.
    fire({
      ...base,
      particleCount: 10,
      spread: 100,
      startVelocity: 6 * s,
      decay: 0.8,
      gravity: 0.3 * s,
      ticks: 30,
      scalar: 0.32 * s,
      shapes: ['circle'],
      colors: SPARK_COLORS,
    });
    // Two heart layers, not one. `flat: true` also pins rotation at zero, so a
    // single layer of identically sized upright hearts fans out like a
    // formation; a smaller, slower set behind the near one reads as depth.
    fire({
      ...base,
      particleCount: 4,
      spread: 120,
      startVelocity: 4.6 * s,
      decay: 0.87,
      gravity: 0.17 * s,
      ticks: 58,
      scalar: 0.85 * s,
      shapes: [HEART_SHAPE],
      colors: HEART_COLORS,
    });
    fire({
      ...base,
      particleCount: 5,
      spread: 105,
      startVelocity: 5.6 * s,
      decay: 0.86,
      gravity: 0.2 * s,
      ticks: 50,
      scalar: 1.15 * s,
      shapes: [HEART_SHAPE],
      colors: HEART_COLORS,
    });
  }
}
