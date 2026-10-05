import { remuxFlac, readDfLaBlocks, readFragmentSamples } from './music-flac-remux';
import { parseFlacFile } from './music-flac-tags';
import { makeFlacInit, streamInfo } from './music-flac-testkit';
import { box, concatBytes, makeFragment } from './music-mp4-boxes';

const frame = (n: number, len: number) => new Uint8Array(len).fill(n);

describe('music-flac-remux', () => {
  const f1 = frame(1, 10);
  const f2 = frame(2, 7);
  const f3 = frame(3, 12);
  const f4 = frame(4, 5);

  it('reads STREAMINFO from the dfLa box', () => {
    const blocks = readDfLaBlocks(makeFlacInit());
    expect(blocks.length).toBe(1);
    expect(blocks[0].type).toBe(0);
    expect(blocks[0].data.length).toBe(34);
    expect(Array.from(blocks[0].data.subarray(18, 20))).toEqual([0xab, 0xab]);
  });

  it('reads every sample from a moof/mdat pair', () => {
    const samples = readFragmentSamples(makeFragment([f1, f2]));
    expect(samples.map((s) => Array.from(s))).toEqual([Array.from(f1), Array.from(f2)]);
  });

  it('remuxes init + 2 segments into fLaC + STREAMINFO + the concatenated frames', () => {
    const parts = remuxFlac(makeFlacInit(), [makeFragment([f1, f2], 1), makeFragment([f3, f4], 2)]);
    const bytes = concatBytes(parts);
    expect(String.fromCharCode(...bytes.subarray(0, 4))).toBe('fLaC');
    // STREAMINFO header: last-block flag set (only block), type 0, length 34.
    expect(Array.from(bytes.subarray(4, 8))).toEqual([0x80, 0, 0, 34]);
    expect(Array.from(bytes.subarray(8, 42))).toEqual(Array.from(streamInfo()));
    expect(Array.from(bytes.subarray(42))).toEqual([...f1, ...f2, ...f3, ...f4]);
  });

  it('clears the last-block flag on STREAMINFO when blocks are added, and sets it on the final block', () => {
    const extra = [{ type: 4, data: new Uint8Array([1, 2, 3]) }, { type: 6, data: new Uint8Array([9]) }];
    const bytes = concatBytes(remuxFlac(makeFlacInit(), [makeFragment([f1])], extra));
    const parsed = parseFlacFile(bytes);
    expect(parsed?.blocks.map((b) => b.type)).toEqual([0, 4, 6]);
    expect(bytes[4] & 0x80).toBe(0);
    expect(Array.from(bytes.subarray(parsed!.audioOffset))).toEqual(Array.from(f1));
  });

  it('replaces blocks of the same type that the init already holds', () => {
    const init = makeFlacInit([{ type: 4, data: new Uint8Array([7, 7]) }]);
    const bytes = concatBytes(remuxFlac(init, [makeFragment([f1])], [{ type: 4, data: new Uint8Array([5]) }]));
    const parsed = parseFlacFile(bytes)!;
    expect(parsed.blocks.length).toBe(2);
    expect(Array.from(parsed.blocks[1].data)).toEqual([5]);
  });

  it('throws on an init without a fLaC entry', () => {
    expect(() => remuxFlac(box('moov'), [])).toThrow();
  });
});
