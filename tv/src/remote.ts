// TV remote handling. No spatial-nav library — Enter/OK is left to native
// <button> click-on-Enter behavior (works with zero JS on every browser this
// old), so the only custom logic needed is arrow-key focus movement and
// mapping the hardware Back button to browser history.

export const KEY = {
  LEFT: 37,
  UP: 38,
  RIGHT: 39,
  DOWN: 40,
  ENTER: 13,
  BACKSPACE: 8,
  ESCAPE: 27,
  // Samsung Tizen's hardware Back/Return remote button.
  TIZEN_BACK: 10009,
};

function focusableElements(): HTMLElement[] {
  const nodes = document.querySelectorAll('[data-focusable]');
  const out: HTMLElement[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const el = nodes[i] as HTMLElement;
    const rect = el.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) out.push(el);
  }
  return out;
}

function center(el: HTMLElement) {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

type Direction = 'up' | 'down' | 'left' | 'right';

// Nearest-neighbor spatial navigation: among focusable elements strictly in
// the pressed direction from the current one, pick whichever is closest,
// biased to stay aligned on the cross-axis (so moving "down" a poster grid
// tends to land in the same column rather than jumping to a visually closer
// but misaligned tile).
export function moveFocus(direction: Direction) {
  const active = document.activeElement as HTMLElement | null;
  const all = focusableElements();
  if (!active || all.indexOf(active) === -1) {
    if (all.length) all[0].focus();
    return;
  }

  const from = center(active);
  let best: HTMLElement | null = null;
  let bestScore = Infinity;

  for (let i = 0; i < all.length; i++) {
    const el = all[i];
    if (el === active) continue;
    const to = center(el);
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    let inDirection = false;
    let primary = 0;
    if (direction === 'up') { inDirection = dy < -1; primary = -dy; }
    else if (direction === 'down') { inDirection = dy > 1; primary = dy; }
    else if (direction === 'left') { inDirection = dx < -1; primary = -dx; }
    else { inDirection = dx > 1; primary = dx; }
    if (!inDirection) continue;

    const cross = (direction === 'up' || direction === 'down') ? Math.abs(dx) : Math.abs(dy);
    const score = primary + cross * 2;
    if (score < bestScore) { bestScore = score; best = el; }
  }

  if (best) {
    best.focus();
    // No options object — Chromium 47 only reliably supports the no-arg form.
    best.scrollIntoView();
  }
}

// Wires arrow-key focus movement and Back-button handling; returns a cleanup
// function. Backspace is ignored while a text <input> is focused so typing
// in Search isn't hijacked.
export function installRemoteNav(onBack: () => void): () => void {
  function handler(e: KeyboardEvent) {
    switch (e.keyCode) {
      case KEY.UP: moveFocus('up'); e.preventDefault(); break;
      case KEY.DOWN: moveFocus('down'); e.preventDefault(); break;
      case KEY.LEFT: moveFocus('left'); e.preventDefault(); break;
      case KEY.RIGHT: moveFocus('right'); e.preventDefault(); break;
      case KEY.TIZEN_BACK:
        e.preventDefault();
        onBack();
        break;
      case KEY.BACKSPACE:
      case KEY.ESCAPE: {
        const tag = (document.activeElement && document.activeElement.tagName) || '';
        if (e.keyCode === KEY.BACKSPACE && tag === 'INPUT') return;
        e.preventDefault();
        onBack();
        break;
      }
    }
  }
  document.addEventListener('keydown', handler);
  return function cleanup() {
    document.removeEventListener('keydown', handler);
  };
}
