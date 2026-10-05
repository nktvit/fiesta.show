import { MusicTrack } from '../services/music.service';
import { buildShareUrl, parseSharePayload } from './music-share';

const t = (id: number): MusicTrack => ({
  id, title: 't' + id, artist: 'a', artistId: 1, album: 'x', albumId: 1, cover: '', duration: 1, explicit: false, trackNumber: 1, quality: '',
});

describe('music-share', () => {
  it('round-trips a playlist through buildShareUrl (v1 where supported)', async () => {
    const url = await buildShareUrl({ name: 'Road trip, "2026" éè', description: 'desc', tracks: [t(11), t(22), t(33)] });
    const d = new URL(url).searchParams.get('d') ?? '';
    expect(d.startsWith(typeof CompressionStream !== 'undefined' ? '1.' : '0.')).toBeTrue();
    expect(await parseSharePayload(d)).toEqual({ name: 'Road trip, "2026" éè', description: 'desc', ids: [11, 22, 33] });
  });

  it('v1 payloads are smaller than v0 for long lists', async () => {
    if (typeof CompressionStream === 'undefined') return;
    const tracks = Array.from({ length: 300 }, (_, i) => t(100000000 + i));
    const d = new URL(await buildShareUrl({ name: 'big', tracks })).searchParams.get('d') ?? '';
    const v0Length = btoa(JSON.stringify({ n: 'big', t: tracks.map((x) => x.id) })).length;
    expect(d.length).toBeLessThan(v0Length);
  });

  it('still reads v0 (plain base64url JSON)', async () => {
    const body = btoa(JSON.stringify({ n: 'Old', t: [5, 6] })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(await parseSharePayload('0.' + body)).toEqual({ name: 'Old', ids: [5, 6] });
  });

  it('caps at 500 ids and drops invalid ones', async () => {
    const ids = Array.from({ length: 700 }, (_, i) => i + 1);
    const body = btoa(JSON.stringify({ n: 'n', t: [...ids, -3, 1.5, 'x'] })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect((await parseSharePayload('0.' + body))?.ids.length).toBe(500);
  });

  it('rejects junk', async () => {
    expect(await parseSharePayload('')).toBeNull();
    expect(await parseSharePayload('9.abc')).toBeNull();
    expect(await parseSharePayload('0.@@@')).toBeNull();
    expect(await parseSharePayload('1.AAAA')).toBeNull();
  });
});
