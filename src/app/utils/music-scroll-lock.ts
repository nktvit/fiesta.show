/**
 * Ref-counted page scroll lock for music overlays (side panels, sheets,
 * dialogs, Now Playing). Several can be open at once; the page unlocks when the
 * last one releases.
 *
 * Same technique as the bottom-nav sheet (services/scroll-lock.ts): iOS Safari
 * ignores `overflow: hidden`, so the body is pinned with `position: fixed` and
 * `top: -<scrollY>px` (rule: `body.music-overlay-open` in styles.css), and the
 * scroll offset is restored on release. The class also hides the
 * Buy-Me-a-Coffee layers, which float above every app layer.
 */
export const MUSIC_SCROLL_LOCK_CLASS = 'music-overlay-open';

let holders = 0;
let savedY = 0;

function lock(): () => void {
  if (typeof document === 'undefined') return () => undefined;
  if (holders++ === 0) {
    savedY = window.scrollY;
    document.body.style.top = `-${savedY}px`;
    document.body.classList.add(MUSIC_SCROLL_LOCK_CLASS);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    release();
  };
}

function release(): void {
  if (typeof document === 'undefined' || holders === 0) return;
  if (--holders === 0) {
    document.body.classList.remove(MUSIC_SCROLL_LOCK_CLASS);
    document.body.style.top = '';
    window.scrollTo(0, savedY);
  }
}

export const musicScrollLock = {
  /** Locks the page; call the returned function (idempotent) to release. */
  lock,
  isLocked: (): boolean => holders > 0,
};
