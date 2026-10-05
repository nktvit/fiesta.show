import { box, concatBytes, fullBox, u16be, u32be } from './music-mp4-boxes';

/** Builders for synthetic FLAC-in-fMP4 init segments (specs only; no binary fixtures). */

/** A 34 byte STREAMINFO: 44.1 kHz, 2 ch, 16 bit, unknown total samples. */
export function streamInfo(): Uint8Array {
  const b = new Uint8Array(34);
  b.set([0x10, 0x00, 0x10, 0x00], 0); // min/max block size 4096
  // sample rate 44100 (20 bits), channels-1 (3 bits), bps-1 (5 bits)
  const rate = 44100;
  b[10] = (rate >> 12) & 0xff;
  b[11] = (rate >> 4) & 0xff;
  b[12] = ((rate & 0xf) << 4) | (1 << 1) | 0;
  b[13] = 15 << 4;
  b.fill(0xab, 18, 34); // md5
  return b;
}

/** An init segment: ftyp + moov/trak/mdia/minf/stbl/stsd/fLaC/dfLa. */
export function makeFlacInit(extraBlocks: { type: number; data: Uint8Array }[] = []): Uint8Array {
  const si = streamInfo();
  const blocks = [{ type: 0, data: si }, ...extraBlocks];
  const dfLaBlocks = blocks.map((b, i) => {
    const last = i === blocks.length - 1;
    return concatBytes([new Uint8Array([(last ? 0x80 : 0) | b.type, 0, (b.data.length >> 8) & 0xff, b.data.length & 0xff]), b.data]);
  });
  const dfLa = fullBox('dfLa', 0, 0, ...dfLaBlocks);
  const entryHeader = concatBytes([
    new Uint8Array(6), u16be(1), new Uint8Array(8), u16be(2), u16be(16), u16be(0), u16be(0), u32be(44100 << 16),
  ]);
  const flacEntry = box('fLaC', entryHeader, dfLa);
  const stsd = fullBox('stsd', 0, 0, u32be(1), flacEntry);
  const stbl = box('stbl', stsd);
  return concatBytes([box('ftyp', new TextEncoder().encode('iso5'), u32be(0)), box('moov', box('trak', box('mdia', box('minf', stbl))))]);
}
