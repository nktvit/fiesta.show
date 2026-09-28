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

// TV browsers differ in what they will put fullscreen: some only honour a
// request on the stage element, some only on <html>, some on nothing at
// all (Samsung's Tizen browser keeps its address bar unless the viewer uses
// the browser's own Full Screen mode). Try in order, then report the result
// to the caller after the browser has had a moment to react.
export function requestFullscreenCascade(el: HTMLElement | null, done: (ok: boolean) => void): void {
  if (isFullscreen()) { done(true); return; }
  if (el) requestFullscreen(el);
  setTimeout(function () {
    if (isFullscreen()) { done(true); return; }
    requestFullscreen(document.documentElement);
    setTimeout(function () { done(isFullscreen()); }, 400);
  }, 400);
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
