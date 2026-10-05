// Ported from Monochrome (Apache-2.0), js/metadata.flac.js (block layout) and js/dash-downloader.ts (segment handling) - adapted for Fiesta.
import { encodeFlacBlocks, FLAC_BLOCK, FlacBlock } from './music-flac-tags';
import { findBox, findBoxes, parseBoxes, utf8 } from './music-mp4-boxes';

/**
 * Pure-TS remux of TIDAL's FLAC-in-fMP4 into a native FLAC stream: the init
 * segment's `dfLa` box carries the FLAC metadata blocks (STREAMINFO first), and
 * every sample of every `moof`/`mdat` pair is one raw FLAC frame. Owned by package P12.
 */

/** The METADATA_BLOCKs stored in the first `fLaC` sample entry's `dfLa` box. */
export function readDfLaBlocks(init: Uint8Array): FlacBlock[] {
  const stsd = findBox(init, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stsd']);
  if (!stsd) throw new Error('flac: no stsd in the init segment');
  // stsd = version/flags (4) + entry count (4), then sample entries.
  const entry = parseBoxes(init, stsd.dataStart + 8, stsd.end).find((b) => b.type === 'fLaC');
  if (!entry) throw new Error('flac: no fLaC sample entry');
  // AudioSampleEntry: 6 reserved + 2 data ref + 8 reserved + channels/size/pre-defined/reserved (8) + rate (4) = 28 bytes.
  const dfLa = findBoxes(init, 'dfLa', entry.dataStart + 28, entry.end)[0];
  if (!dfLa) throw new Error('flac: no dfLa box');
  const blocks: FlacBlock[] = [];
  let pos = dfLa.dataStart + 4; // version + flags
  while (pos + 4 <= dfLa.end) {
    const head = init[pos];
    const len = (init[pos + 1] << 16) | (init[pos + 2] << 8) | init[pos + 3];
    if (pos + 4 + len > dfLa.end) break;
    blocks.push({ type: head & 0x7f, data: init.subarray(pos + 4, pos + 4 + len) });
    pos += 4 + len;
    if (head & 0x80) break;
  }
  if (!blocks.length || blocks[0].type !== FLAC_BLOCK.streamInfo) throw new Error('flac: dfLa has no STREAMINFO');
  return blocks;
}

/** The raw samples (FLAC frames) of every moof/mdat pair in a media segment (or several concatenated). */
export function readFragmentSamples(seg: Uint8Array): Uint8Array[] {
  const view = new DataView(seg.buffer, seg.byteOffset, seg.byteLength);
  const out: Uint8Array[] = [];
  const top = parseBoxes(seg);
  for (let i = 0; i < top.length; i++) {
    const moof = top[i];
    if (moof.type !== 'moof') continue;
    const mdat = top.slice(i + 1).find((b) => b.type === 'mdat');
    for (const traf of findBoxes(seg, 'traf', moof.dataStart, moof.end)) {
      const tfhd = findBox(seg, ['tfhd'], traf.dataStart, traf.end);
      if (!tfhd) continue;
      const tfFlags = view.getUint32(tfhd.dataStart, false) & 0xffffff;
      let p = tfhd.dataStart + 8; // version/flags + track id
      let base = moof.start;
      if (tfFlags & 0x1) {
        base = view.getUint32(p, false) * 0x100000000 + view.getUint32(p + 4, false);
        p += 8;
      }
      if (tfFlags & 0x2) p += 4;
      if (tfFlags & 0x8) p += 4;
      let defaultSize = 0;
      if (tfFlags & 0x10) {
        defaultSize = view.getUint32(p, false);
        p += 4;
      }
      let cursor = -1;
      for (const trun of findBoxes(seg, 'trun', traf.dataStart, traf.end)) {
        const flags = view.getUint32(trun.dataStart, false) & 0xffffff;
        const count = view.getUint32(trun.dataStart + 4, false);
        let q = trun.dataStart + 8;
        if (flags & 0x1) {
          cursor = base + view.getInt32(q, false);
          q += 4;
        } else if (cursor < 0) {
          cursor = mdat ? mdat.dataStart : moof.end + 8;
        }
        if (flags & 0x4) q += 4;
        for (let s = 0; s < count; s++) {
          if (flags & 0x100) q += 4;
          let size = defaultSize;
          if (flags & 0x200) {
            size = view.getUint32(q, false);
            q += 4;
          }
          if (flags & 0x400) q += 4;
          if (flags & 0x800) q += 4;
          if (cursor + size > seg.length) throw new Error('flac: sample runs past the segment');
          out.push(seg.subarray(cursor, cursor + size));
          cursor += size;
        }
      }
    }
  }
  return out;
}

/**
 * 'fLaC' + the dfLa blocks (replaced by `extra` for the same types; the last-block
 * flag set on the final block) + the frames, as parts ready for `new Blob(parts)`.
 */
export function remuxFlac(init: Uint8Array, segments: readonly Uint8Array[], extra: readonly FlacBlock[] = []): Uint8Array[] {
  const fromInit = readDfLaBlocks(init);
  const replaced = new Set<number>([FLAC_BLOCK.padding, ...extra.map((b) => b.type)]);
  const kept = fromInit.filter((b) => b.type === FLAC_BLOCK.streamInfo || !replaced.has(b.type));
  const frames: Uint8Array[] = [];
  for (const seg of segments) frames.push(...readFragmentSamples(seg));
  return [utf8('fLaC'), ...encodeFlacBlocks([...kept, ...extra]), ...frames];
}
