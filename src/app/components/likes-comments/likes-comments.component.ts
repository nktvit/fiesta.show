import { Component, computed, effect, ElementRef, inject, input, OnDestroy, signal, viewChild } from '@angular/core';
import { DecimalPipe, NgClass } from '@angular/common';
import { Comment, ContentRef, EDIT_WINDOW_MS, LikesCommentsService } from '../../services/likes-comments.service';

const ADJECTIVES = ['Curious', 'Sleepy', 'Brave', 'Mighty', 'Quiet', 'Jolly', 'Clever', 'Gentle'];
const ANIMALS = ['Panda', 'Falcon', 'Otter', 'Tiger', 'Owl', 'Fox', 'Wolf', 'Dolphin'];

function randomName(): string {
  const a = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const n = ANIMALS[Math.floor(Math.random() * ANIMALS.length)];
  return `${a} ${n}`;
}

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

@Component({
  selector: 'app-likes-comments',
  imports: [DecimalPipe, NgClass],
  templateUrl: './likes-comments.component.html',
  styleUrl: './likes-comments.component.css',
})
export class LikesCommentsComponent implements OnDestroy {
  readonly imdbId = input<string>('');
  readonly type = input<string>('movie');
  readonly season = input<number | null>(null);
  readonly episode = input<number | null>(null);
  // Two placements share this component: a compact like badge next to the
  // IMDb/RT/Metacritic ratings, and the full comment thread further down the
  // page. Each instance only fetches the data its own mode needs.
  readonly mode = input<'like' | 'comments'>('comments');

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

  readonly comments = signal<Comment[]>([]);
  readonly nextCursor = signal<number | null>(null);
  readonly loadingComments = signal(false);
  readonly loadingMore = signal(false);

  readonly identityMode = signal<'anonymous' | 'random' | 'custom'>('anonymous');
  readonly randomDisplayName = signal('');
  readonly customName = signal('');
  readonly commentText = signal('');
  readonly commentSpoiler = signal(false);
  readonly postingComment = signal(false);
  readonly moderationBanner = signal<string | null>(null);

  // Which top-level comment currently has its inline reply composer open —
  // replies go one level deep only, so there's no equivalent for replies.
  readonly replyingTo = signal<string | null>(null);
  readonly replyText = signal('');
  readonly replySpoiler = signal(false);
  readonly postingReply = signal(false);

  // Spoiler-masked comments the reader has chosen to uncover, by id. Deliberately
  // per-page-view state: revisiting the page masks them again.
  readonly revealed = signal<ReadonlySet<string>>(new Set());

  // Inline edit state — one comment (or reply) at a time.
  readonly editingId = signal<string | null>(null);
  readonly editText = signal('');
  readonly editSpoiler = signal(false);
  readonly savingEdit = signal(false);
  readonly editError = signal<string | null>(null);
  // Which comment the in-flight save belongs to, so a result that arrives
  // after the editor moved on can't land in the wrong one.
  private savingEditFor: string | null = null;

  // Ticks so relative timestamps stay honest and the Edit button disappears
  // when the 15-minute window closes, without needing a reload.
  private readonly now = signal(Date.now());
  private ticker: ReturnType<typeof setInterval> | null = null;

  private readonly contentRef = computed<ContentRef>(() => ({
    imdbId: this.imdbId(),
    type: this.type(),
    season: this.season(),
    episode: this.episode(),
  }));

  private readonly readyRef = computed<ContentRef | null>(() => {
    const ref = this.contentRef();
    if (!ref.imdbId) return null;
    if (ref.type === 'tv' && (!ref.season || !ref.episode)) return null;
    return ref;
  });

  constructor() {
    effect(() => {
      const ref = this.readyRef();
      if (ref) this.reload(ref);
    });

    // Only the thread instance needs a clock; the compact like badge shows no
    // timestamps. Read inside an effect rather than the constructor so the
    // `mode` input binding has actually been applied.
    effect(() => {
      if (this.mode() !== 'comments' || this.ticker) return;
      this.ticker = setInterval(() => this.now.set(Date.now()), 30_000);
    });

  }

  // Also clears burstTimeout, which had no teardown before this component
  // grew a lifecycle hook.
  ngOnDestroy(): void {
    this.destroyed = true;
    if (this.ticker) clearInterval(this.ticker);
    if (this.burstTimeout) clearTimeout(this.burstTimeout);
    // Cancels the rAF loop and clears the canvas — without it a burst fired
    // moments before a route change keeps animating against a detached view.
    this.cannon?.reset();
  }

  private reload(ref: ContentRef): void {
    if (this.mode() === 'like') {
      this.service.getLikes(ref).subscribe({
        next: (res) => {
          this.likeCount.set(res.count);
          this.liked.set(res.liked);
        },
        error: () => {},
      });
      return;
    }

    this.moderationBanner.set(null);
    this.commentText.set('');
    this.commentSpoiler.set(false);
    this.replyingTo.set(null);
    this.cancelEdit();
    this.revealed.set(new Set());
    this.loadingComments.set(true);
    this.comments.set([]);
    this.nextCursor.set(null);
    this.service.getComments(ref).subscribe({
      next: (res) => {
        this.comments.set(res.comments);
        this.nextCursor.set(res.nextCursor);
        this.loadingComments.set(false);
      },
      error: () => this.loadingComments.set(false),
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

  // `parentId` set means `comment` is a reply nested under that top-level
  // comment; omitted means `comment` is itself top-level.
  private patchComment(commentId: string, parentId: string | null, patch: Partial<Comment>): void {
    this.comments.update((list) =>
      list.map((c) => {
        if (!parentId) return c.id === commentId ? { ...c, ...patch } : c;
        if (c.id !== parentId) return c;
        return { ...c, replies: (c.replies || []).map((r) => (r.id === commentId ? { ...r, ...patch } : r)) };
      }),
    );
  }

  toggleCommentLike(comment: Comment, parentId: string | null = null): void {
    const nextLiked = !comment.liked;
    const prevCount = comment.likeCount;
    const nextCount = prevCount + (nextLiked ? 1 : -1);

    this.patchComment(comment.id, parentId, { liked: nextLiked, likeCount: nextCount });

    this.service.toggleCommentLike(comment.id, nextLiked ? 'like' : 'unlike').subscribe({
      next: (res) => this.patchComment(comment.id, parentId, { liked: res.liked, likeCount: res.count }),
      error: () => this.patchComment(comment.id, parentId, { liked: !nextLiked, likeCount: prevCount }),
    });
  }

  deleteComment(comment: Comment, parentId: string | null = null): void {
    const ref = this.readyRef();
    if (!ref || !comment.isMine) return;
    if (typeof window !== 'undefined' && !window.confirm('Delete this comment?')) return;

    const prev = this.comments();
    if (!parentId) {
      this.comments.update((list) => list.filter((c) => c.id !== comment.id));
    } else {
      this.comments.update((list) =>
        list.map((c) => (c.id === parentId ? { ...c, replies: (c.replies || []).filter((r) => r.id !== comment.id) } : c)),
      );
    }

    this.service.deleteComment(ref, comment.id, parentId).subscribe({
      error: () => this.comments.set(prev),
    });
  }

  // A spoiler-masked comment stays masked until the reader asks for it, and
  // can be put back under the mask with the same control.
  isRevealed(commentId: string): boolean {
    return this.revealed().has(commentId);
  }

  toggleReveal(commentId: string): void {
    this.revealed.update((set) => {
      const next = new Set(set);
      if (!next.delete(commentId)) next.add(commentId);
      return next;
    });
  }

  // Mirrors the server's own window check (api/comments.js) — this only
  // decides whether to offer the button; the server is what enforces it.
  canEdit(comment: Comment): boolean {
    return !!comment.isMine && this.now() - comment.createdAt < EDIT_WINDOW_MS;
  }

  editTimeLeft(comment: Comment): string {
    const left = EDIT_WINDOW_MS - (this.now() - comment.createdAt);
    if (left <= 0) return 'no time';
    const m = Math.ceil(left / 60000);
    return `${m}m`;
  }

  startEdit(comment: Comment): void {
    this.editingId.set(comment.id);
    this.editText.set(comment.text);
    this.editSpoiler.set(!!comment.spoiler);
    this.editError.set(null);
  }

  cancelEdit(): void {
    this.editingId.set(null);
    this.editText.set('');
    this.editSpoiler.set(false);
    this.editError.set(null);
    // Also drops any in-flight save. A text edit waits on a moderation call
    // that can take seconds, which is exactly when someone gives up and hits
    // Cancel — without this the spinner would stay stuck on whatever editor
    // they open next, and that request's result would land in it.
    this.savingEdit.set(false);
    this.savingEditFor = null;
  }

  saveEdit(comment: Comment, parentId: string | null = null): void {
    const ref = this.readyRef();
    const text = this.editText().trim();
    if (!ref || !text || this.savingEdit()) return;
    const spoiler = this.editSpoiler();

    // No optimistic patch here: an edit can be rejected by moderation, and
    // showing the new text before the server has accepted it would flash
    // content that never actually got posted.
    this.editError.set(null);
    this.savingEdit.set(true);
    this.savingEditFor = comment.id;
    this.service.editComment(ref, comment.id, text, spoiler, parentId).subscribe({
      next: (res) => {
        // Patch only what an edit can change — likes and replies live in the
        // local copy and aren't part of the PATCH response. This applies even
        // if the editor has since been closed: the server accepted the edit,
        // so the thread should show it either way.
        this.patchComment(comment.id, parentId, {
          text: res.comment.text,
          spoiler: res.comment.spoiler,
          editedAt: res.comment.editedAt,
        });
        if (this.savingEditFor !== comment.id) return;
        this.cancelEdit();
      },
      error: (err) => {
        // Dropped on the floor if the editor moved on — showing this comment's
        // rejection reason inside a different comment's form would misattribute it.
        if (this.savingEditFor !== comment.id) return;
        this.editError.set(err?.error?.error || "Couldn't save your edit right now — please try again.");
        this.savingEdit.set(false);
      },
    });
  }

  startReply(commentId: string): void {
    this.replyingTo.set(this.replyingTo() === commentId ? null : commentId);
    this.replyText.set('');
    this.replySpoiler.set(false);
  }

  postReply(parent: Comment): void {
    const text = this.replyText().trim();
    const ref = this.readyRef();
    if (!text || !ref || this.postingReply()) return;

    this.postingReply.set(true);
    this.service.postComment(ref, text, null, parent.id, this.replySpoiler()).subscribe({
      next: (res) => {
        this.comments.update((list) =>
          list.map((c) => (c.id === parent.id ? { ...c, replies: [...(c.replies || []), res.comment] } : c)),
        );
        this.replyText.set('');
        this.replySpoiler.set(false);
        this.replyingTo.set(null);
        this.postingReply.set(false);
      },
      error: (err) => {
        this.moderationBanner.set(err?.error?.error || "Couldn't post your reply right now — please try again.");
        this.postingReply.set(false);
      },
    });
  }

  loadMore(): void {
    const cursor = this.nextCursor();
    const ref = this.readyRef();
    if (cursor == null || !ref || this.loadingMore()) return;

    this.loadingMore.set(true);
    this.service.getComments(ref, cursor).subscribe({
      next: (res) => {
        this.comments.update((c) => [...c, ...res.comments]);
        this.nextCursor.set(res.nextCursor);
        this.loadingMore.set(false);
      },
      error: () => this.loadingMore.set(false),
    });
  }

  setIdentityMode(mode: 'anonymous' | 'random' | 'custom'): void {
    this.identityMode.set(mode);
    if (mode === 'random' && !this.randomDisplayName()) {
      this.randomDisplayName.set(randomName());
    }
  }

  postComment(): void {
    const text = this.commentText().trim();
    const ref = this.readyRef();
    if (!text || !ref || this.postingComment()) return;

    let displayName: string | null = null;
    if (this.identityMode() === 'random') {
      displayName = this.randomDisplayName() || randomName();
    } else if (this.identityMode() === 'custom') {
      const name = this.customName().trim();
      if (!name) return;
      displayName = name;
    }

    this.moderationBanner.set(null);
    this.postingComment.set(true);
    this.service.postComment(ref, text, displayName, null, this.commentSpoiler()).subscribe({
      next: (res) => {
        this.comments.update((c) => [res.comment, ...c]);
        this.commentText.set('');
        this.commentSpoiler.set(false);
        this.postingComment.set(false);
      },
      error: (err) => {
        this.moderationBanner.set(err?.error?.error || "Couldn't post your comment right now — please try again.");
        this.postingComment.set(false);
      },
    });
  }

  countryFlag(country: string | null): string {
    if (!country || !/^[A-Za-z]{2}$/.test(country)) return '';
    const codePoints = [...country.toUpperCase()].map((c) => 127397 + c.charCodeAt(0));
    return String.fromCodePoint(...codePoints);
  }

  countryName(country: string | null): string {
    if (!country) return '';
    try {
      return new Intl.DisplayNames(['en'], { type: 'region' }).of(country) || country;
    } catch {
      return country;
    }
  }

  timeAgo(ts: number): string {
    const s = Math.floor((this.now() - ts) / 1000);
    if (s < 60) return 'just now';
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.floor(h / 24);
    return `${d}d ago`;
  }
}
