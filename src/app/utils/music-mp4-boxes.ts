/**
 * Minimal ISO-BMFF (MP4) box helpers: build boxes, walk them, and make a tiny
 * fragment. Pure; used by the FLAC remux, the ilst tag writer and their specs.
 * Owned by package P12.
 */

export interface Mp4Box {
  type: string;
  /** Offset of the box header. */
  start: number;
  /** Offset of the first payload byte (after the 8 or 16 byte header). */
  dataStart: number;
  /** Offset just past the box. */
  end: number;
}

const enc = new TextEncoder();

export function fourcc(type: string): Uint8Array {
  const out = new Uint8Array(4);
  for (let i = 0; i < 4; i++) out[i] = type.charCodeAt(i) & 0xff;
  return out;
}

export function u32be(n: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n >>> 0, false);
  return out;
}

export function u16be(n: number): Uint8Array {
  const out = new Uint8Array(2);
  new DataView(out.buffer).setUint16(0, n & 0xffff, false);
  return out;
}

export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}

export function utf8(s: string): Uint8Array {
  return enc.encode(s);
}

/** A box: 32-bit size, fourcc, then the payload parts. */
export function box(type: string, ...payload: Uint8Array[]): Uint8Array {
  const body = concatBytes(payload);
  return concatBytes([u32be(8 + body.length), fourcc(type), body]);
}

/** A "full box": version byte + 24-bit flags before the payload. */
export function fullBox(type: string, version: number, flags: number, ...payload: Uint8Array[]): Uint8Array {
  const head = new Uint8Array([version & 0xff, (flags >>> 16) & 0xff, (flags >>> 8) & 0xff, flags & 0xff]);
  return box(type, head, ...payload);
}

/** The boxes directly inside [start, end) of `buf`. Stops at a malformed size instead of throwing. */
export function parseBoxes(buf: Uint8Array, start = 0, end = buf.length): Mp4Box[] {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const out: Mp4Box[] = [];
  let pos = start;
  while (pos + 8 <= end) {
    let size = view.getUint32(pos, false);
    const type = String.fromCharCode(buf[pos + 4], buf[pos + 5], buf[pos + 6], buf[pos + 7]);
    let header = 8;
    if (size === 1) {
      if (pos + 16 > end) break;
      size = view.getUint32(pos + 8, false) * 0x100000000 + view.getUint32(pos + 12, false);
      header = 16;
    } else if (size === 0) {
      size = end - pos;
    }
    if (size < header || pos + size > end) break;
    out.push({ type, start: pos, dataStart: pos + header, end: pos + size });
    pos += size;
  }
  return out;
}

/** Follows a path of box types ("moov", "trak", ...) from the top; null when any step is missing. */
export function findBox(buf: Uint8Array, path: readonly string[], start = 0, end = buf.length): Mp4Box | null {
  let from = start;
  let to = end;
  let found: Mp4Box | null = null;
  for (const type of path) {
    found = parseBoxes(buf, from, to).find((b) => b.type === type) ?? null;
    if (!found) return null;
    from = found.dataStart;
    to = found.end;
  }
  return found;
}

/** Every top-level (or nested under `start..end`) box of `type`. */
export function findBoxes(buf: Uint8Array, type: string, start = 0, end = buf.length): Mp4Box[] {
  return parseBoxes(buf, start, end).filter((b) => b.type === type);
}

/**
 * A synthetic media fragment (moof + mdat) holding `samples`, with a trun that
 * carries per-sample sizes and a data offset relative to the moof. Specs use it
 * to build fMP4 without binary fixtures.
 */
export function makeFragment(samples: readonly Uint8Array[], sequence = 1, trackId = 1): Uint8Array {
  const mfhd = fullBox('mfhd', 0, 0, u32be(sequence));
  // tfhd flags 0x020000: default-base-is-moof.
  const tfhd = fullBox('tfhd', 0, 0x020000, u32be(trackId));
  const tfdt = fullBox('tfdt', 0, 0, u32be(0));
  const trunFlags = 0x000001 | 0x000200; // data offset + sample size
  const trunBody = (dataOffset: number) =>
    fullBox('trun', 0, trunFlags, u32be(samples.length), u32be(dataOffset), ...samples.map((s) => u32be(s.length)));
  const build = (off: number) => box('moof', mfhd, box('traf', tfhd, tfdt, trunBody(off)));
  const moofSize = build(0).length;
  return concatBytes([build(moofSize + 8), box('mdat', ...samples)]);
}
