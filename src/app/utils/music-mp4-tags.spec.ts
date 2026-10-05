import { box, concatBytes, findBox, fullBox, makeFragment, parseBoxes, u32be } from './music-mp4-boxes';
import { buildIlst, readMp4Tags, tagMp4 } from './music-mp4-tags';

const ftyp = () => box('ftyp', new TextEncoder().encode('M4A '), u32be(0));
const moov = (...kids: Uint8Array[]) => box('moov', fullBox('mvhd', 0, 0, new Uint8Array(96)), ...kids);

describe('music-mp4-tags', () => {
  const tags = {
    title: 'Song', artist: 'Ann', album: 'LP', albumArtist: 'Ann', trackNumber: 3, trackTotal: 9, date: '2020-05-01',
    copyright: '(c) X', lyrics: '[00:01.00]hi', isrc: 'GBX000000001', cover: { mime: 'image/jpeg', data: new Uint8Array([0xff, 0xd8, 1, 2]) },
  };

  it('builds an ilst whose items are well-formed boxes', () => {
    const ilst = buildIlst(tags);
    const items = parseBoxes(ilst, 8, ilst.length).map((b) => b.type);
    expect(items).toEqual(['©nam', '©ART', '©alb', 'aART', '©day', 'cprt', '©lyr', 'trkn', '----', 'covr']);
  });

  it('writes a parsable moov/udta/meta/ilst into a fragmented file and keeps the fragments intact', () => {
    const frag = makeFragment([new Uint8Array([1, 2, 3])]);
    const file = concatBytes([ftyp(), moov(), frag]);
    const out = tagMp4(file, tags);
    expect(out).not.toBeNull();
    const bytes = concatBytes(out!);
    const meta = findBox(bytes, ['moov', 'udta', 'meta'])!;
    expect(meta).not.toBeNull();
    // meta is a full box: 4 bytes of version/flags, then hdlr and ilst.
    expect(parseBoxes(bytes, meta.dataStart + 4, meta.end).map((b) => b.type)).toEqual(['hdlr', 'ilst']);
    const back = readMp4Tags(bytes);
    expect(back['©nam']).toBe('Song');
    expect(back['©ART']).toBe('Ann');
    expect(back['trkn']).toBe('3/9');
    expect(back['ISRC']).toBe('GBX000000001');
    expect(back['covr']).toBe('4');
    expect(back['©lyr']).toBe('[00:01.00]hi');
    // The trailing moof/mdat is byte-identical.
    expect(Array.from(bytes.subarray(bytes.length - frag.length))).toEqual(Array.from(frag));
    // Box sizes add up to the file length.
    const top = parseBoxes(bytes);
    expect(top.map((b) => b.type)).toEqual(['ftyp', 'moov', 'moof', 'mdat']);
    expect(top[top.length - 1].end).toBe(bytes.length);
  });

  it('replaces an existing udta instead of stacking a second one', () => {
    const file = concatBytes([ftyp(), moov(box('udta', box('free', new Uint8Array(4)))), makeFragment([new Uint8Array(2)])]);
    const once = concatBytes(tagMp4(file, { title: 'A' })!);
    const twice = concatBytes(tagMp4(once, { title: 'B' })!);
    const moovBox = findBox(twice, ['moov'])!;
    expect(parseBoxes(twice, moovBox.dataStart, moovBox.end).filter((b) => b.type === 'udta').length).toBe(1);
    expect(readMp4Tags(twice)['©nam']).toBe('B');
  });

  it('shifts stco chunk offsets when the moov precedes the mdat in a progressive file', () => {
    const mdat = box('mdat', new Uint8Array(8).fill(7));
    const build = (offset: number) => concatBytes([ftyp(), moov(box('trak', box('mdia', box('minf', box('stbl', fullBox('stco', 0, 0, u32be(1), u32be(offset))))))), mdat]);
    // The real offset of the mdat payload = size of ftyp + moov + 8.
    const head = build(0);
    const payloadOffset = head.length - mdat.length + 8;
    const file = build(payloadOffset);
    const out = concatBytes(tagMp4(file, { title: 'X' })!);
    const stco = findBox(out, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stco'])!;
    const newOffset = new DataView(out.buffer, out.byteOffset).getUint32(stco.dataStart + 8, false);
    expect(Array.from(out.subarray(newOffset, newOffset + 8))).toEqual(new Array(8).fill(7));
  });

  it('declines files that are not MP4 or use absolute fragment offsets', () => {
    expect(tagMp4(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]), tags)).toBeNull();
    const tfhd = fullBox('tfhd', 0, 0x1, u32be(1), u32be(0), u32be(100));
    const moof = box('moof', box('traf', tfhd));
    expect(tagMp4(concatBytes([ftyp(), moov(), moof, box('mdat')]), tags)).toBeNull();
  });
});
