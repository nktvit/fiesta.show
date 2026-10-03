import type Hls from 'hls.js';

// Exposes our own hls.js instance's quality levels as `video.videoRenditions`,
// the list Video.js v10's quality menu reads (VideoRenditionListLike in
// @videojs/media). Video.js only fills this list itself when its own
// <hlsjs-video> owns hls.js; we keep ours (tuned ABR config, error recovery,
// server escalation), so we provide the list.

export interface HlsRendition {
  id: string;
  width: number | undefined;
  height: number | undefined;
  bitrate: number | undefined;
  frameRate: number | undefined;
  codec: string | undefined;
  selected: boolean;
  active: boolean;
}

type LevelSource = Pick<Hls, 'levels' | 'autoLevelEnabled' | 'manualLevel' | 'nextLevel' | 'currentLevel'>;

function renditionEvent(type: string, rendition?: HlsRendition): Event {
  return Object.assign(new Event(type), rendition ? { rendition } : {});
}

export class HlsRenditionList extends EventTarget {
  [index: number]: HlsRendition;
  private items: HlsRendition[] = [];

  constructor(private readonly hls: LevelSource) {
    super();
  }

  get length(): number {
    return this.items.length;
  }

  [Symbol.iterator](): Iterator<HlsRendition> {
    return this.items[Symbol.iterator]();
  }

  getRenditionById(id: string): HlsRendition | null {
    return this.items.find((r) => r.id === id) ?? null;
  }

  // -1 = Auto (hls.js ABR). Anything else pins that level. manualLevel is the
  // viewer's pin; nextLevel would be the level of the next buffered fragment.
  get selectedIndex(): number {
    return this.hls.autoLevelEnabled ? -1 : this.hls.manualLevel;
  }

  set selectedIndex(index: number) {
    // nextLevel switches at the next fragment without flushing the buffer, so a
    // pick never stalls playback; -1 hands control back to ABR.
    this.hls.nextLevel = index >= 0 && index < this.items.length ? index : -1;
    this.items.forEach((r, i) => (r.selected = i === index));
    this.dispatchEvent(renditionEvent('change'));
  }

  // Rebuild from hls.levels (MANIFEST_PARSED / LEVELS_UPDATED).
  sync(): void {
    for (let i = 0; i < this.items.length; i++) delete this[i];
    this.items = this.hls.levels.map((l, i) => ({
      id: String(i),
      width: l.width || undefined,
      height: l.height || undefined,
      bitrate: l.bitrate || undefined,
      frameRate: l.frameRate || undefined,
      codec: l.videoCodec || undefined,
      selected: !this.hls.autoLevelEnabled && i === this.hls.manualLevel,
      active: i === this.hls.currentLevel,
    }));
    this.items.forEach((r, i) => (this[i] = r));
    for (const r of this.items) this.dispatchEvent(renditionEvent('addrendition', r));
  }

  // LEVEL_SWITCHED: which level is actually playing now.
  setActive(level: number): void {
    this.items.forEach((r, i) => (r.active = i === level));
    this.dispatchEvent(renditionEvent('activechange'));
  }
}

// Install on the <video> BEFORE hls.attachMedia(): Video.js re-reads
// `videoRenditions` on `loadstart`. Returns the list; call remove() on teardown.
export function installRenditions(video: HTMLVideoElement, hls: LevelSource): {
  list: HlsRenditionList;
  remove: () => void;
} {
  const list = new HlsRenditionList(hls);
  Object.defineProperty(video, 'videoRenditions', { configurable: true, get: () => list });
  return {
    list,
    remove: () => {
      delete (video as unknown as { videoRenditions?: unknown }).videoRenditions;
    },
  };
}
