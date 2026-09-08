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

  // The confetti burst is anchored to this element's position on screen.
  private readonly likeBtn = viewChild<ElementRef<HTMLElement>>('likeBtn');

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
    if (this.ticker) clearInterval(this.ticker);
    if (this.burstTimeout) clearTimeout(this.burstTimeout);
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
    } else if (this.burstTimeout) {
      clearTimeout(this.burstTimeout);
      this.justLiked.set(false);
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

  // Hearts spill out of the button itself, so the burst origin is the
  // button's own centre expressed in viewport fractions — canvas-confetti
  // defaults to the middle of the screen, which would look unrelated to the
  // thing that was clicked.
  private async fireHearts(): Promise<void> {
    const el = this.likeBtn()?.nativeElement;
    if (!el || typeof window === 'undefined') return;

    const rect = el.getBoundingClientRect();
    const origin = {
      x: (rect.left + rect.width / 2) / window.innerWidth,
      y: (rect.top + rect.height / 2) / window.innerHeight,
    };

    // Lazy-loaded so it stays out of the initial bundle — the same treatment
    // hls.js already gets on the player.
    const confetti = (await import('canvas-confetti')).default;
    const heart = confetti.shapeFromText({ text: '❤️', scalar: 2 });

    // `disableForReducedMotion` is the library's own guard, so these become
    // no-ops for that preference without branching on a media query here.
    confetti({
      origin,
      shapes: [heart],
      scalar: 2,
      particleCount: 14,
      spread: 70,
      startVelocity: 28,
      gravity: 0.7,
      ticks: 170,
      disableForReducedMotion: true,
    });
    // A faster, smaller second layer in Fiesta's own gradient colours — the
    // firework behind the hearts.
    confetti({
      origin,
      particleCount: 32,
      spread: 95,
      startVelocity: 34,
      scalar: 0.7,
      gravity: 0.9,
      ticks: 120,
      colors: ['#6366f1', '#d946ef', '#ec4899', '#818cf8', '#f0abfc'],
      disableForReducedMotion: true,
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
