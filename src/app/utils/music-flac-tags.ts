// Ported from Monochrome (Apache-2.0), js/metadata.flac.js - adapted for Fiesta.
import { concatBytes, utf8 } from './music-mp4-boxes';

/**
 * FLAC metadata blocks: Vorbis comments and PICTURE, plus reading and
 * rebuilding a native FLAC stream. Pure. Owned by package P12.
 */

export const FLAC_BLOCK = { streamInfo: 0, padding: 1, application: 2, seekTable: 3, vorbisComment: 4, cueSheet: 5, picture: 6 } as const;

export interface FlacBlock {
  type: number;
  data: Uint8Array;
}

export type FlacTags = Record<string, string | readonly string[] | undefined>;

const VENDOR = 'Stream Fiesta';

function le32(n: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n >>> 0, true);
  return out;
}

function be32(n: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n >>> 0, false);
  return out;
}

/** A VORBIS_COMMENT block. Keys are upper-cased; array values become repeated fields; empty values are skipped. */
export function vorbisCommentBlock(tags: FlacTags, vendor = VENDOR): FlacBlock {
  const fields: Uint8Array[] = [];
  for (const [key, raw] of Object.entries(tags)) {
    const values = raw === undefined ? [] : typeof raw === 'string' ? [raw] : [...raw];
    for (const v of values) {
      const text = String(v ?? '').trim();
      if (!text) continue;
      const name = key.toUpperCase().replace(/[^\x20-\x7c\x7e]/g, '').replace(/=/g, '');
      if (!name) continue;
      const bytes = utf8(`${name}=${text}`);
      fields.push(le32(bytes.length), bytes);
    }
  }
  const vendorBytes = utf8(vendor);
  return {
    type: FLAC_BLOCK.vorbisComment,
    data: concatBytes([le32(vendorBytes.length), vendorBytes, le32(fields.length / 2), ...fields]),
  };
}

/** Reads a VORBIS_COMMENT block back into upper-cased keys with arrays of values. */
export function parseVorbisComment(data: Uint8Array): { vendor: string; tags: Record<string, string[]> } {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const dec = new TextDecoder();
  let pos = 0;
  const vendorLen = view.getUint32(pos, true);
  pos += 4;
  const vendor = dec.decode(data.subarray(pos, pos + vendorLen));
  pos += vendorLen;
  const count = view.getUint32(pos, true);
  pos += 4;
  const tags: Record<string, string[]> = {};
  for (let i = 0; i < count && pos + 4 <= data.length; i++) {
    const len = view.getUint32(pos, true);
    pos += 4;
    const text = dec.decode(data.subarray(pos, pos + len));
    pos += len;
    const eq = text.indexOf('=');
    if (eq < 1) continue;
    (tags[text.slice(0, eq).toUpperCase()] ??= []).push(text.slice(eq + 1));
  }
  return { vendor, tags };
}

/** A PICTURE block (type 3 = front cover). Width/height 0 means unknown. */
export function pictureBlock(mime: string, image: Uint8Array, opts: { description?: string; width?: number; height?: number; pictureType?: number } = {}): FlacBlock {
  const mimeBytes = utf8(mime);
  const desc = utf8(opts.description ?? '');
  return {
    type: FLAC_BLOCK.picture,
    data: concatBytes([
      be32(opts.pictureType ?? 3),
      be32(mimeBytes.length), mimeBytes,
      be32(desc.length), desc,
      be32(opts.width ?? 0), be32(opts.height ?? 0), be32(24), be32(0),
      be32(image.length), image,
    ]),
  };
}

/** Reads a PICTURE block's mime and image bytes. */
export function parsePictureBlock(data: Uint8Array): { mime: string; image: Uint8Array } {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const dec = new TextDecoder();
  let pos = 4;
  const mimeLen = view.getUint32(pos, false);
  pos += 4;
  const mime = dec.decode(data.subarray(pos, pos + mimeLen));
  pos += mimeLen;
  const descLen = view.getUint32(pos, false);
  pos += 4 + descLen + 16;
  const imgLen = view.getUint32(pos, false);
  pos += 4;
  return { mime, image: data.subarray(pos, pos + imgLen) };
}

/** Block headers (last-block flag on the final one) followed by their data. Returns [] when empty. */
export function encodeFlacBlocks(blocks: readonly FlacBlock[]): Uint8Array[] {
  const out: Uint8Array[] = [];
  blocks.forEach((b, i) => {
    const last = i === blocks.length - 1;
    const len = b.data.length;
    out.push(new Uint8Array([(last ? 0x80 : 0) | (b.type & 0x7f), (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff]), b.data);
  });
  return out;
}

export function isFlac(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x66 && bytes[1] === 0x4c && bytes[2] === 0x61 && bytes[3] === 0x43;
}

/** The metadata blocks of a native FLAC file and where the audio frames start; null if it is not FLAC. */
export function parseFlacFile(bytes: Uint8Array): { blocks: FlacBlock[]; audioOffset: number } | null {
  if (!isFlac(bytes)) return null;
  const blocks: FlacBlock[] = [];
  let pos = 4;
  for (;;) {
    if (pos + 4 > bytes.length) return null;
    const head = bytes[pos];
    const len = (bytes[pos + 1] << 16) | (bytes[pos + 2] << 8) | bytes[pos + 3];
    if (pos + 4 + len > bytes.length) return null;
    blocks.push({ type: head & 0x7f, data: bytes.subarray(pos + 4, pos + 4 + len) });
    pos += 4 + len;
    if (head & 0x80) break;
  }
  return { blocks, audioOffset: pos };
}

/**
 * Re-tags a native FLAC file: its VORBIS_COMMENT and PICTURE blocks (and any
 * padding) are replaced by `extra`; everything else (STREAMINFO, seek table...)
 * is kept. Returns the file parts, or null when the input is not FLAC.
 */
export function rebuildFlacWithBlocks(bytes: Uint8Array, extra: readonly FlacBlock[]): Uint8Array[] | null {
  const parsed = parseFlacFile(bytes);
  if (!parsed) return null;
  const replaced = new Set<number>([FLAC_BLOCK.padding, ...extra.map((b) => b.type)]);
  const kept = parsed.blocks.filter((b) => !replaced.has(b.type));
  const head = kept.filter((b) => b.type === FLAC_BLOCK.streamInfo);
  const rest = kept.filter((b) => b.type !== FLAC_BLOCK.streamInfo);
  return [utf8('fLaC'), ...encodeFlacBlocks([...head, ...rest, ...extra]), bytes.subarray(parsed.audioOffset)];
}
