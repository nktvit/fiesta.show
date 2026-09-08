import { inject, Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';

export interface Comment {
  id: string;
  text: string;
  displayName: string | null;
  country: string | null;
  createdAt: number;
  isMine: boolean;
  likeCount: number;
  liked: boolean;
}

export interface LikesResponse {
  count: number;
  liked: boolean;
}

export interface CommentsResponse {
  comments: Comment[];
  nextCursor: number | null;
}

export interface ContentRef {
  imdbId: string;
  type: string;
  season: number | null;
  episode: number | null;
}

@Injectable({ providedIn: 'root' })
export class LikesCommentsService {
  private static readonly CLIENT_ID_KEY = 'fiesta:client-id';

  private http = inject(HttpClient);

  get clientId(): string {
    if (typeof window === 'undefined') return '';
    try {
      let id = window.localStorage.getItem(LikesCommentsService.CLIENT_ID_KEY);
      if (!id) {
        id = crypto.randomUUID();
        window.localStorage.setItem(LikesCommentsService.CLIENT_ID_KEY, id);
      }
      return id;
    } catch {
      return '';
    }
  }

  getLikes(ref: ContentRef): Observable<LikesResponse> {
    return this.http.get<LikesResponse>(`/api/likes?${this.contentParams(ref)}`, {
      headers: { 'X-Client-Id': this.clientId },
    });
  }

  toggleLike(ref: ContentRef, action: 'like' | 'unlike'): Observable<LikesResponse> {
    return this.http.post<LikesResponse>('/api/likes', {
      ...this.contentBody(ref),
      clientId: this.clientId,
      action,
    });
  }

  toggleCommentLike(commentId: string, action: 'like' | 'unlike'): Observable<LikesResponse> {
    return this.http.post<LikesResponse>('/api/likes', {
      commentId,
      clientId: this.clientId,
      action,
    });
  }

  getComments(ref: ContentRef, cursor?: number | null): Observable<CommentsResponse> {
    let params = this.contentParams(ref);
    if (cursor != null) params += `&cursor=${cursor}`;
    return this.http.get<CommentsResponse>(`/api/comments?${params}`, {
      headers: { 'X-Client-Id': this.clientId },
    });
  }

  postComment(ref: ContentRef, text: string, displayName?: string | null): Observable<{ comment: Comment }> {
    return this.http.post<{ comment: Comment }>('/api/comments', {
      ...this.contentBody(ref),
      clientId: this.clientId,
      text,
      displayName: displayName || undefined,
    });
  }

  deleteComment(ref: ContentRef, commentId: string): Observable<{ deleted: boolean }> {
    return this.http.delete<{ deleted: boolean }>('/api/comments', {
      body: { ...this.contentBody(ref), commentId, clientId: this.clientId },
    });
  }

  private contentBody(ref: ContentRef): Record<string, unknown> {
    const body: Record<string, unknown> = { type: ref.type, id: ref.imdbId };
    if (ref.type === 'tv') {
      body['s'] = ref.season;
      body['e'] = ref.episode;
    }
    return body;
  }

  private contentParams(ref: ContentRef): string {
    const params = new URLSearchParams({ type: ref.type, id: ref.imdbId });
    if (ref.type === 'tv' && ref.season != null && ref.episode != null) {
      params.set('s', String(ref.season));
      params.set('e', String(ref.episode));
    }
    return params.toString();
  }
}
