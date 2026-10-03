import { HlsRenditionList, installRenditions } from './hls-renditions';

function fakeHls(levels: { width: number; height: number; bitrate: number }[]) {
  return {
    levels: levels.map((l) => ({ ...l, frameRate: 24, videoCodec: 'avc1' })),
    nextLevel: -1,
    currentLevel: 0,
    // hls.js: setting nextLevel pins manualLevel; -1 restores ABR.
    get manualLevel() { return this._manual ?? -1; },
    get autoLevelEnabled() { return (this._manual ?? -1) === -1; },
  } as any;
}

describe('HlsRenditionList', () => {
  const ladder = [
    { width: 640, height: 358, bitrate: 1_000_000 },
    { width: 1280, height: 714, bitrate: 3_281_926 },
    { width: 1920, height: 1072, bitrate: 5_145_364 },
  ];

  it('mirrors hls.levels as an indexed, iterable list', () => {
    const list = new HlsRenditionList(fakeHls(ladder));
    const added: unknown[] = [];
    list.addEventListener('addrendition', (e) => added.push((e as any).rendition));
    list.sync();
    expect(list.length).toBe(3);
    expect(list[2].height).toBe(1072);
    expect([...list].map((r) => r.id)).toEqual(['0', '1', '2']);
    expect(list.getRenditionById('1')?.width).toBe(1280);
    expect(added.length).toBe(3);
    expect(list.selectedIndex).toBe(-1);
  });

  it('pins a level through nextLevel and returns to Auto with -1', () => {
    const hls = fakeHls(ladder);
    const list = new HlsRenditionList(hls);
    list.sync();
    let changes = 0;
    list.addEventListener('change', () => changes++);
    list.selectedIndex = 1;
    hls._manual = hls.nextLevel; // what hls.js does inside its nextLevel setter
    expect(hls.nextLevel).toBe(1);
    expect(list.selectedIndex).toBe(1);
    expect(list[1].selected).toBeTrue();
    list.selectedIndex = -1;
    hls._manual = hls.nextLevel;
    expect(hls.nextLevel).toBe(-1);
    expect(list.selectedIndex).toBe(-1);
    expect(changes).toBe(2);
  });

  it('drops stale indices when the ladder shrinks', () => {
    const hls = fakeHls(ladder);
    const list = new HlsRenditionList(hls);
    list.sync();
    hls.levels = hls.levels.slice(0, 1);
    list.sync();
    expect(list.length).toBe(1);
    expect(list[2]).toBeUndefined();
  });

  it('marks the playing level active', () => {
    const list = new HlsRenditionList(fakeHls(ladder));
    list.sync();
    list.setActive(2);
    expect([...list].map((r) => r.active)).toEqual([false, false, true]);
  });

  it('installs and removes video.videoRenditions', () => {
    const video = document.createElement('video');
    const { list, remove } = installRenditions(video, fakeHls(ladder));
    expect((video as any).videoRenditions).toBe(list);
    remove();
    expect((video as any).videoRenditions).toBeUndefined();
  });
});
