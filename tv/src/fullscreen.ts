// Fullscreen API with the WebKit prefixes Chromium 47-era TV browsers still
// need. All calls are best-effort: a TV shell that already runs the browser
// edge-to-edge may reject or ignore them, and playback must not depend on it.

export function requestFullscreen(el: HTMLElement): void {
  const anyEl: any = el;
  const fn = anyEl.requestFullscreen || anyEl.webkitRequestFullscreen || anyEl.webkitRequestFullScreen || anyEl.mozRequestFullScreen;
  if (!fn) return;
  try {
    const result = fn.call(el);
    if (result && typeof result.catch === 'function') result.catch(function () {});
  } catch (e) {}
}

export function exitFullscreen(): void {
  const doc: any = document;
  if (!isFullscreen()) return;
  const fn = doc.exitFullscreen || doc.webkitExitFullscreen || doc.webkitCancelFullScreen || doc.mozCancelFullScreen;
  if (!fn) return;
  try {
    const result = fn.call(document);
    if (result && typeof result.catch === 'function') result.catch(function () {});
  } catch (e) {}
}

export function isFullscreen(): boolean {
  const doc: any = document;
  return !!(doc.fullscreenElement || doc.webkitFullscreenElement || doc.webkitCurrentFullScreenElement || doc.mozFullScreenElement);
}
