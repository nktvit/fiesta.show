/**
 * Class the bottom-nav genre sheet puts on `<body>` to hold the page still
 * behind it. The rule itself lives in `src/styles.css`.
 *
 * `overflow: hidden` does not hold on iOS Safari, so the lock also pins the
 * body with `position: fixed` — and that collapses the window to the top,
 * firing a `scroll` event for the entire offset in one go. Anything watching
 * window scroll has to sit that out rather than read it as the user moving:
 * without this, opening the genre sheet over an expanded movie card closed the
 * card underneath it.
 *
 * The offset is restored on release, so a watcher that ignores the locked
 * period sees the page exactly where it left it.
 */
export const SCROLL_LOCK_CLASS = 'nav-sheet-open';

/** Cheap enough for a scroll handler: a class check, never a layout read. */
export const isScrollLocked = (): boolean =>
  document.body.classList.contains(SCROLL_LOCK_CLASS);
