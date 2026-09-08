import { Component, computed, effect, inject, input, signal } from '@angular/core';
import { DecimalPipe, NgClass } from '@angular/common';
import { Comment, ContentRef, LikesCommentsService } from '../../services/likes-comments.service';

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
export class LikesCommentsComponent {
  readonly imdbId = input<string>('');
  readonly type = input<string>('movie');
  readonly season = input<number | null>(null);
  readonly episode = input<number | null>(null);
  // Two placements share this component: a compact like badge next to the
  // IMDb/RT/Metacritic ratings, and the full comment thread further down the
  // page. Each instance only fetches the data its own mode needs.
  readonly mode = input<'like' | 'comments'>('comments');

  private readonly service = inject(LikesCommentsService);

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
  readonly postingComment = signal(false);
  readonly moderationBanner = signal<string | null>(null);

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

  toggleCommentLike(comment: Comment): void {
    const nextLiked = !comment.liked;
    const prevCount = comment.likeCount;
    const nextCount = prevCount + (nextLiked ? 1 : -1);

    this.comments.update((list) =>
      list.map((c) => (c.id === comment.id ? { ...c, liked: nextLiked, likeCount: nextCount } : c)),
    );

    this.service.toggleCommentLike(comment.id, nextLiked ? 'like' : 'unlike').subscribe({
      next: (res) => {
        this.comments.update((list) =>
          list.map((c) => (c.id === comment.id ? { ...c, liked: res.liked, likeCount: res.count } : c)),
        );
      },
      error: () => {
        this.comments.update((list) =>
          list.map((c) => (c.id === comment.id ? { ...c, liked: !nextLiked, likeCount: prevCount } : c)),
        );
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
    this.service.postComment(ref, text, displayName).subscribe({
      next: (res) => {
        this.comments.update((c) => [res.comment, ...c]);
        this.commentText.set('');
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
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60) return 'just now';
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.floor(h / 24);
    return `${d}d ago`;
  }
}
