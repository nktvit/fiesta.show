import { MusicTrack } from './music.service';
import {
  PlayClock, SCROBBLE_QUEUE_MAX, ScrobbleQueueItem, audioscrobblerParams, audioscrobblerSign, enqueue, isMixedContent,
  listenBrainzPayload, malojaForm, normalizeServerUrl, primaryArtist, scrobbleMeta, scrobbleThreshold,
} from './music-scrobble-core';

const track = (over: Partial<MusicTrack> = {}): MusicTrack => ({
  id: 1, title: 'Song', artist: 'Ann & Bob', artistId: 1, album: 'Alb', albumId: 2, cover: '', duration: 200,
  explicit: false, trackNumber: 3, quality: 'LOSSLESS', ...over,
});

describe('scrobbleThreshold', () => {
  it('is a percentage of the track, capped at 4 minutes', () => {
    expect(scrobbleThreshold(200, 50)).toBe(100);
    expect(scrobbleThreshold(600, 50)).toBe(240);
    expect(scrobbleThreshold(600, 100)).toBe(240);
    expect(scrobbleThreshold(100, 25)).toBe(25);
  });
  it('never scrobbles tracks under 30 s', () => {
    expect(scrobbleThreshold(29, 50)).toBeNull();
    expect(scrobbleThreshold(30, 50)).toBe(15);
    expect(scrobbleThreshold(NaN, 50)).toBeNull();
  });
  it('clamps silly percentages', () => {
    expect(scrobbleThreshold(100, 500)).toBe(100);
    expect(scrobbleThreshold(100, -3)).toBe(1);
  });
});

describe('PlayClock', () => {
  it('counts only while running', () => {
    let t = 0;
    const c = new PlayClock(() => t);
    c.start();
    t = 10_000;
    expect(c.seconds()).toBe(10);
    c.stop();
    t = 50_000; // paused for 40 s
    expect(c.seconds()).toBe(10);
    c.start();
    t = 55_000;
    expect(c.seconds()).toBe(15);
    c.reset();
    expect(c.seconds()).toBe(0);
    expect(c.running).toBeFalse();
  });
  it('ignores a repeated start', () => {
    let t = 0;
    const c = new PlayClock(() => t);
    c.start();
    t = 2000;
    c.start();
    t = 4000;
    expect(c.seconds()).toBe(4);
  });
});

describe('metadata', () => {
  it('uses the first credited artist', () => {
    expect(primaryArtist(track())).toBe('Ann');
    expect(primaryArtist(track({ artists: [{ id: 9, name: 'Zed' }, { id: 8, name: 'Yo' }] }))).toBe('Zed');
    expect(primaryArtist(track({ artist: 'Ann feat. Bob' }))).toBe('Ann');
    expect(primaryArtist(track({ artist: '' }))).toBe('Unknown Artist');
  });
  it('builds meta with version and isrc', () => {
    const m = scrobbleMeta(track({ version: 'Remastered', isrc: 'GBX1', duration: 200.7 }));
    expect(m).toEqual({ artist: 'Ann', title: 'Song (Remastered)', album: 'Alb', duration: 200, trackNumber: 3, isrc: 'GBX1' });
  });
});

describe('queue', () => {
  const item = (n: number, over: Partial<ScrobbleQueueItem> = {}): ScrobbleQueueItem => ({
    id: 'i' + n, service: 'listenbrainz', kind: 'scrobble', meta: { artist: 'A', title: 'T' + n, album: '', duration: 100, trackNumber: 0, isrc: '' }, ts: n, tries: 0, ...over,
  });
  it('drops exact duplicates and caps its length', () => {
    expect(enqueue([item(1)], item(1, { id: 'other' })).length).toBe(1);
    let q: ScrobbleQueueItem[] = [];
    for (let i = 0; i < SCROBBLE_QUEUE_MAX + 5; i++) q = enqueue(q, item(i));
    expect(q.length).toBe(SCROBBLE_QUEUE_MAX);
    expect(q[0].ts).toBe(5);
  });
});

describe('payloads', () => {
  const meta = scrobbleMeta(track({ isrc: 'GBX1' }));
  it('ListenBrainz single has listened_at, playing_now does not', () => {
    const single = listenBrainzPayload('single', meta, 1700000000) as { listen_type: string; payload: { listened_at?: number; track_metadata: { artist_name: string; release_name: string } }[] };
    expect(single.listen_type).toBe('single');
    expect(single.payload[0].listened_at).toBe(1700000000);
    expect(single.payload[0].track_metadata.artist_name).toBe('Ann');
    expect(single.payload[0].track_metadata.release_name).toBe('Alb');
    const now = listenBrainzPayload('playing_now', meta, 1) as { payload: { listened_at?: number }[] };
    expect(now.payload[0].listened_at).toBeUndefined();
  });
  it('Maloja form carries key and time', () => {
    expect(malojaForm(meta, 5, 'K')).toEqual({ artist: 'Ann', title: 'Song', key: 'K', time: '5', album: 'Alb', duration: '200' });
  });
  it('audioscrobbler params per kind', () => {
    expect(audioscrobblerParams('love', meta, 5)).toEqual({ artist: 'Ann', track: 'Song' });
    expect(audioscrobblerParams('nowplaying', meta, 5)['timestamp']).toBeUndefined();
    expect(audioscrobblerParams('scrobble', meta, 5)['timestamp']).toBe('5');
  });
  it('signature sorts names and skips format', () => {
    const md5 = (s: string) => s;
    expect(audioscrobblerSign({ b: '2', a: '1', format: 'json' }, 'sec', md5)).toBe('a1b2sec');
  });
});

describe('server urls', () => {
  it('normalises', () => {
    expect(normalizeServerUrl(' maloja.example.com/ ')).toBe('https://maloja.example.com');
    expect(normalizeServerUrl('http://192.168.1.2:42010//')).toBe('http://192.168.1.2:42010');
    expect(normalizeServerUrl('')).toBe('');
  });
  it('flags mixed content on https pages only', () => {
    expect(isMixedContent('http://x.test', 'https:')).toBeTrue();
    expect(isMixedContent('https://x.test', 'https:')).toBeFalse();
    expect(isMixedContent('http://x.test', 'http:')).toBeFalse();
  });
});
