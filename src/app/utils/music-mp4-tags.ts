// Ported from Monochrome (Apache-2.0), js/metadata.mp4.js (ilst atoms) - adapted for Fiesta.
import { box, concatBytes, findBox, fourcc, fullBox, parseBoxes, u16be, u32be, utf8 } from './music-mp4-boxes';

/**
 * Writes iTunes-style `moov/udta/meta/ilst` tags into an .m4a / fMP4 AAC file
 * (and reads them back). Pure. Owned by package P12.
 */

export interface Mp4Tags {
  title?: string;
  artist?: string;
  album?: string;
  albumArtist?: string;
  trackNumber?: number;
  trackTotal?: number;
  /** ISO date or year. */
  date?: string;
  copyright?: string;
  lyrics?: string;
  isrc?: string;
  cover?: { mime: string; data: Uint8Array };
}

const dataAtom = (type: number, payload: Uint8Array) => box('data', u32be(type), u32be(0), payload);
const textItem = (name: string, text: string) => box(name, dataAtom(1, utf8(text)));

/** The `ilst` box for `tags` (fields that are empty are left out). */
export function buildIlst(tags: Mp4Tags): Uint8Array {
  const items: Uint8Array[] = [];
  const text = (name: string, v: string | undefined) => {
    if (v && v.trim()) items.push(textItem(name, v.trim()));
  };
  text('©nam', tags.title);
  text('©ART', tags.artist);
  text('©alb', tags.album);
  text('aART', tags.albumArtist);
  text('©day', tags.date);
  text('cprt', tags.copyright);
  text('©lyr', tags.lyrics);
  if (tags.trackNumber && tags.trackNumber > 0) {
    items.push(box('trkn', dataAtom(0, concatBytes([u16be(0), u16be(tags.trackNumber), u16be(tags.trackTotal ?? 0), u16be(0)]))));
  }
  if (tags.isrc && tags.isrc.trim()) {
    items.push(box('----', fullBox('mean', 0, 0, utf8('com.apple.iTunes')), fullBox('name', 0, 0, utf8('ISRC')), dataAtom(1, utf8(tags.isrc.trim()))));
  }
  if (tags.cover && tags.cover.data.length) {
    items.push(box('covr', dataAtom(/png/i.test(tags.cover.mime) ? 14 : 13, tags.cover.data)));
  }
  return box('ilst', ...items);
}

/** `udta` > `meta` (with the mandatory mdir handler) > `ilst`. */
export function buildUdta(tags: Mp4Tags): Uint8Array {
  const hdlr = fullBox('hdlr', 0, 0, u32be(0), fourcc('mdir'), fourcc('appl'), u32be(0), u32be(0), new Uint8Array(1));
  return box('udta', fullBox('meta', 0, 0, hdlr, buildIlst(tags)));
}

/** Reads text items (keyed by fourcc, e.g. "©nam"), "trkn" as "n/total", "ISRC", and "covr" as the image byte length. */
export function readMp4Tags(bytes: Uint8Array): Record<string, string> {
  const out: Record<string, string> = {};
  const meta = findBox(bytes, ['moov', 'udta', 'meta']);
  if (!meta) return out;
  const ilst = parseBoxes(bytes, meta.dataStart + 4, meta.end).find((b) => b.type === 'ilst');
  if (!ilst) return out;
  const dec = new TextDecoder();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (const item of parseBoxes(bytes, ilst.dataStart, ilst.end)) {
    const data = parseBoxes(bytes, item.dataStart, item.end).find((b) => b.type === 'data');
    if (!data) continue;
    const payload = bytes.subarray(data.dataStart + 8, data.end);
    if (item.type === 'trkn') {
      out['trkn'] = `${view.getUint16(data.dataStart + 8 + 2, false)}/${view.getUint16(data.dataStart + 8 + 4, false)}`;
    } else if (item.type === 'covr') {
      out['covr'] = String(payload.length);
    } else if (item.type === '----') {
      const name = parseBoxes(bytes, item.dataStart, item.end).find((b) => b.type === 'name');
      if (name) out[dec.decode(bytes.subarray(name.dataStart + 4, name.end))] = dec.decode(payload);
    } else {
      out[item.type] = dec.decode(payload);
    }
  }
  return out;
}

/** Adds `delta` to every offset in the stco/co64 boxes of a trak (a private copy). */
function shiftChunkOffsets(trak: Uint8Array, delta: number): void {
  const view = new DataView(trak.buffer, trak.byteOffset, trak.byteLength);
  const stbl = findBox(trak, ['mdia', 'minf', 'stbl'], 8);
  if (!stbl) return;
  for (const b of parseBoxes(trak, stbl.dataStart, stbl.end)) {
    if (b.type !== 'stco' && b.type !== 'co64') continue;
    const count = view.getUint32(b.dataStart + 4, false);
    for (let i = 0; i < count; i++) {
      if (b.type === 'stco') {
        const p = b.dataStart + 8 + i * 4;
        view.setUint32(p, view.getUint32(p, false) + delta, false);
      } else {
        const p = b.dataStart + 8 + i * 8;
        const v = view.getUint32(p, false) * 0x100000000 + view.getUint32(p + 4, false) + delta;
        view.setUint32(p, Math.floor(v / 0x100000000), false);
        view.setUint32(p + 4, v >>> 0, false);
      }
    }
  }
}

/**
 * The file with `tags` in its moov, as parts for a Blob. Fragmented files only
 * need the moov to grow; progressive files with the moov ahead of the mdat get
 * their chunk offsets shifted. Returns null (leave the file untagged) when it is
 * not an MP4, or uses absolute fragment offsets that a bigger moov would break.
 */
export function tagMp4(bytes: Uint8Array, tags: Mp4Tags): Uint8Array[] | null {
  const top = parseBoxes(bytes);
  const moov = top.find((b) => b.type === 'moov');
  if (!moov || !top.some((b) => b.type === 'ftyp')) return null;
  const fragmented = top.some((b) => b.type === 'moof');
  if (fragmented) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (const moof of top.filter((b) => b.type === 'moof')) {
      for (const traf of parseBoxes(bytes, moof.dataStart, moof.end).filter((b) => b.type === 'traf')) {
        const tfhd = findBox(bytes, ['tfhd'], traf.dataStart, traf.end);
        if (tfhd && view.getUint32(tfhd.dataStart, false) & 0x1) return null;
      }
    }
  }
  const udta = buildUdta(tags);
  const children = parseBoxes(bytes, moov.dataStart, moov.end);
  const oldUdta = children.find((c) => c.type === 'udta');
  const delta = udta.length - (oldUdta ? oldUdta.end - oldUdta.start : 0);
  const shift = !fragmented && delta !== 0 && moov.start < (top.find((b) => b.type === 'mdat')?.start ?? -1);
  const kept: Uint8Array[] = [];
  for (const c of children) {
    if (c.type === 'udta') continue;
    const copy = bytes.slice(c.start, c.end);
    if (shift && c.type === 'trak') shiftChunkOffsets(copy, delta);
    kept.push(copy);
  }
  return [bytes.subarray(0, moov.start), box('moov', ...kept, udta), bytes.subarray(moov.end)];
}
