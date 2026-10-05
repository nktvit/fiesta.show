import { encodeFlacBlocks, isFlac, parseFlacFile, parsePictureBlock, parseVorbisComment, pictureBlock, rebuildFlacWithBlocks, vorbisCommentBlock } from './music-flac-tags';
import { concatBytes } from './music-mp4-boxes';

describe('music-flac-tags', () => {
  it('round-trips Vorbis comments, including repeated and non-ASCII values', () => {
    const block = vorbisCommentBlock({ title: 'Été', ARTIST: ['A', 'B'], album: 'Alb', empty: '', none: undefined, 'bad=key': 'x' });
    const back = parseVorbisComment(block.data);
    expect(back.vendor).toBe('Stream Fiesta');
    expect(back.tags['TITLE']).toEqual(['Été']);
    expect(back.tags['ARTIST']).toEqual(['A', 'B']);
    expect(back.tags['ALBUM']).toEqual(['Alb']);
    expect(back.tags['EMPTY']).toBeUndefined();
    expect(back.tags['BADKEY']).toEqual(['x']);
  });

  it('round-trips a PICTURE block', () => {
    const img = new Uint8Array([0xff, 0xd8, 1, 2, 3]);
    const back = parsePictureBlock(pictureBlock('image/jpeg', img).data);
    expect(back.mime).toBe('image/jpeg');
    expect(Array.from(back.image)).toEqual(Array.from(img));
  });

  it('encodes the last-block flag on the final block only', () => {
    const parts = encodeFlacBlocks([{ type: 0, data: new Uint8Array(2) }, { type: 4, data: new Uint8Array(1) }]);
    expect(parts[0][0]).toBe(0);
    expect(parts[2][0]).toBe(0x84);
  });

  it('re-tags a native FLAC, replacing old comments and keeping the audio', () => {
    const si = { type: 0, data: new Uint8Array(34).fill(1) };
    const oldTags = vorbisCommentBlock({ title: 'Old' });
    const audio = new Uint8Array([0xff, 0xf8, 9, 9]);
    const file = concatBytes([new TextEncoder().encode('fLaC'), ...encodeFlacBlocks([si, oldTags]), audio]);
    expect(isFlac(file)).toBeTrue();
    const out = rebuildFlacWithBlocks(file, [vorbisCommentBlock({ title: 'New' })])!;
    const bytes = concatBytes(out);
    const parsed = parseFlacFile(bytes)!;
    expect(parsed.blocks.map((b) => b.type)).toEqual([0, 4]);
    expect(parseVorbisComment(parsed.blocks[1].data).tags['TITLE']).toEqual(['New']);
    expect(Array.from(bytes.subarray(parsed.audioOffset))).toEqual(Array.from(audio));
  });

  it('returns null for non-FLAC input', () => {
    expect(rebuildFlacWithBlocks(new Uint8Array([1, 2, 3, 4, 5]), [])).toBeNull();
    expect(parseFlacFile(new Uint8Array(3))).toBeNull();
  });
});
