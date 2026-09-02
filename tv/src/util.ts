// HTMLMediaElement.play() only started returning a Promise around Chrome 50
// — on Chromium 47 it returns undefined, so an unconditional `.catch(...)`
// throws. core-js/Babel can't fix this (it's a DOM behavior difference, not
// a missing language builtin), so every play() call goes through this.
export function safePlay(video: HTMLVideoElement): void {
  const result: any = video.play();
  if (result && typeof result.catch === 'function') {
    result.catch(function () {});
  }
}
