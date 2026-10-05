import { Injectable, signal } from '@angular/core';

export interface MusicToastAction {
  label: string;
  run: () => void;
}

export interface MusicToastOptions {
  message: string;
  /** One button (Undo, View...). Clicking it runs the action and dismisses. */
  action?: MusicToastAction;
  /** 'warn' renders amber (warnings and errors). Default 'info'. */
  tone?: 'info' | 'warn';
  /** ms before it hides; default 4000 (6000 with an action). 0 = until dismissed. */
  duration?: number;
}

export interface MusicToast extends Required<Pick<MusicToastOptions, 'message' | 'tone'>> {
  id: number;
  action?: MusicToastAction;
}

const MAX_VISIBLE = 3;

/**
 * Short notices for player and library actions, rendered by
 * <app-music-toast-host> in an aria-live region (so screen readers hear them).
 */
@Injectable({ providedIn: 'root' })
export class MusicToastService {
  private readonly _toasts = signal<MusicToast[]>([]);
  private timers = new Map<number, ReturnType<typeof setTimeout>>();
  private seq = 0;

  /** Visible toasts, oldest first (at most 3). */
  readonly toasts = this._toasts.asReadonly();

  /** Shows a toast; returns its id (for dismiss). The same message twice in a row replaces the older one. */
  show(opts: MusicToastOptions): number {
    const id = ++this.seq;
    const toast: MusicToast = { id, message: opts.message, tone: opts.tone ?? 'info', action: opts.action };
    this._toasts.update((list) => {
      const dupes = list.filter((t) => t.message === toast.message);
      dupes.forEach((t) => this.clearTimer(t.id));
      const next = [...list.filter((t) => t.message !== toast.message), toast];
      next.slice(0, Math.max(0, next.length - MAX_VISIBLE)).forEach((t) => this.clearTimer(t.id));
      return next.slice(-MAX_VISIBLE);
    });
    const duration = opts.duration ?? (opts.action ? 6000 : 4000);
    if (duration > 0) this.timers.set(id, setTimeout(() => this.dismiss(id), duration));
    return id;
  }

  dismiss(id: number): void {
    this.clearTimer(id);
    this._toasts.update((list) => list.filter((t) => t.id !== id));
  }

  /** Runs a toast's action and dismisses it. */
  act(id: number): void {
    const t = this._toasts().find((x) => x.id === id);
    this.dismiss(id);
    try {
      t?.action?.run();
    } catch {
      // the action's own failure is not the toast's business
    }
  }

  clear(): void {
    for (const id of this.timers.keys()) this.clearTimer(id);
    this._toasts.set([]);
  }

  private clearTimer(id: number): void {
    const t = this.timers.get(id);
    if (t) clearTimeout(t);
    this.timers.delete(id);
  }
}
