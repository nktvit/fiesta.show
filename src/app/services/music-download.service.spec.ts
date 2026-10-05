import { WritableSignal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Observable, of } from 'rxjs';
import { makeFlacInit } from '../utils/music-flac-testkit';
import { parseFlacFile, parseVorbisComment } from '../utils/music-flac-tags';
import { makeFragment } from '../utils/music-mp4-boxes';
import { MusicDownloadService } from './music-download.service';
import { MusicAlbum, MusicManifest, MusicService, MusicTrack } from './music.service';

const mk = (id: number, title: string): MusicTrack => ({
  id, title, artist: 'Ann', artistId: 1, album: 'LP', albumId: 5, cover: 'https://resources.tidal.com/images/a/b/640x640.jpg',
  duration: 10, explicit: false, trackNumber: id, quality: 'LOSSLESS', isrc: 'GBX00000000' + id,
});
const ALBUM: MusicAlbum = { id: 5, title: 'LP', artist: 'Ann', cover: 'https://resources.tidal.com/images/a/b/640x640.jpg', year: '2020', tracks: 2, duration: 20, quality: 'LOSSLESS' };
const MANIFEST: MusicManifest = {
  presentation: 'FULL', quality: 'LOSSLESS', signedIn: true, kind: 'segments', codec: 'flac', init: '/api/music?action=seg&u=init',
  media: '/api/music?action=seg&u=media', durations: [4, 4],
};

describe('MusicDownloadService', () => {
  let svc: MusicDownloadService;
  let saved: { name: string; blob: Blob }[];
  let manifestFor: () => Observable<MusicManifest>;

  const turnOn = () => ((svc as unknown as { switchOn: WritableSignal<boolean> }).switchOn.set(true));
  const settled = async (ms = 8000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (svc.tasks().length && svc.tasks().every((t) => t.status !== 'queued' && t.status !== 'running')) return;
      await new Promise((r) => setTimeout(r, 20));
    }
  };

  beforeEach(() => {
    localStorage.removeItem('fiesta:music:downloads');
    saved = [];
    manifestFor = () => of(MANIFEST);
    const blobs = new Map<string, Blob>();
    spyOn(URL, 'createObjectURL').and.callFake((b: Blob | MediaSource) => {
      const u = 'blob:test/' + blobs.size;
      blobs.set(u, b as Blob);
      return u;
    });
    spyOn(URL, 'revokeObjectURL').and.stub();
    spyOn(HTMLAnchorElement.prototype, 'click').and.callFake(function (this: HTMLAnchorElement) {
      saved.push({ name: this.download, blob: blobs.get(this.href)! });
    });
    spyOn(window, 'fetch').and.callFake((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('u=init')) return Promise.resolve(new Response(makeFlacInit() as BodyInit));
      if (url.includes('u=media')) return Promise.resolve(new Response(makeFragment([new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])], +url.split('&n=')[1]) as BodyInit));
      if (url.includes('action=img')) return Promise.resolve(new Response(new Uint8Array([0xff, 0xd8, 0xff]) as BodyInit, { headers: { 'content-type': 'image/jpeg' } }));
      return Promise.resolve(new Response('', { status: 404 }));
    });
    TestBed.configureTestingModule({
      providers: [{ provide: MusicService, useValue: { manifest: () => manifestFor(), artist: () => of({ artist: { id: 1, name: 'Ann', picture: '' }, topTracks: [], albums: [ALBUM, { ...ALBUM, id: 6, title: 'Two' }] }), album: () => of({ album: ALBUM, tracks: [mk(1, 'One')] }) } }],
    });
    svc = TestBed.inject(MusicDownloadService);
  });

  it('is off by default: enabled() is false and nothing is queued', async () => {
    expect(svc.enabled()).toBeFalse();
    await svc.downloadTrack(mk(1, 'One'));
    await svc.downloadAlbum(ALBUM, [mk(1, 'One'), mk(2, 'Two')]);
    await svc.downloadArtist(1);
    expect(svc.tasks().length).toBe(0);
    expect(svc.artistRequest()).toBeNull();
  });

  it('saves a track as "<Artist> - <Title>.flac" starting with fLaC and carrying tags', async () => {
    turnOn();
    await svc.downloadTrack(mk(1, 'One'));
    await settled();
    expect(svc.tasks()[0].status).toBe('done');
    expect(saved.length).toBe(1);
    expect(saved[0].name).toBe('Ann - One.flac');
    const bytes = new Uint8Array(await saved[0].blob.arrayBuffer());
    expect(String.fromCharCode(...bytes.subarray(0, 4))).toBe('fLaC');
    const parsed = parseFlacFile(bytes)!;
    expect(parsed.blocks.map((b) => b.type)).toEqual([0, 4, 6]);
    const tags = parseVorbisComment(parsed.blocks[1].data).tags;
    expect(tags['TITLE']).toEqual(['One']);
    expect(tags['ISRC']).toEqual(['GBX000000001']);
    // two segments x two frames each
    expect(bytes.length - parsed.audioOffset).toBe(2 * (3 + 2));
  });

  it('honours the filename template', async () => {
    turnOn();
    svc.setPrefs({ trackTemplate: '{album} - {track} {title}' });
    await svc.downloadTracks([mk(2, 'Two')]);
    await settled();
    expect(saved[0].name).toBe('LP - 02 Two.flac');
  });

  it('cancels a running download', async () => {
    turnOn();
    manifestFor = () => new Observable<MusicManifest>(() => undefined);
    await svc.downloadTrack(mk(1, 'One'));
    await new Promise((r) => setTimeout(r, 30));
    expect(svc.tasks()[0].status).toBe('running');
    svc.cancel(svc.tasks()[0].id);
    expect(svc.tasks()[0].status).toBe('cancelled');
  });

  it('marks a failing download as error and retries it', async () => {
    turnOn();
    let fail = true;
    manifestFor = () => (fail ? new Observable<MusicManifest>((s) => s.error(new Error('boom'))) : of(MANIFEST));
    await svc.downloadTrack(mk(1, 'One'));
    await settled();
    expect(svc.tasks()[0].status).toBe('error');
    fail = false;
    svc.retry(svc.tasks()[0].id);
    await settled();
    expect(svc.tasks()[0].status).toBe('done');
    expect(saved.length).toBe(1);
  });

  it('builds an album ZIP named "<Artist> - <Album>.zip" with numbered tracks, cover and sidecars', async () => {
    turnOn();
    svc.setPrefs({ lyricsSidecar: 'off', sidecars: { cover: true, m3u8: true, cue: true, nfo: true, json: true } });
    await svc.downloadAlbum(ALBUM, [mk(1, 'One'), mk(2, 'Two')]);
    await settled();
    expect(svc.tasks()[0].status).toBe('done');
    expect(saved[0].name).toBe('Ann - LP.zip');
    const text = new TextDecoder('latin1').decode(new Uint8Array(await saved[0].blob.arrayBuffer()));
    for (const n of ['01 - One.flac', '02 - Two.flac', 'cover.jpg', 'LP.m3u8', 'LP.cue', 'LP.nfo', 'LP.json']) expect(text).toContain(n);
    expect(text).not.toContain('.lrc');
  });

  it('asks before queueing an artist and then queues one task per album', async () => {
    turnOn();
    await svc.downloadArtist(1);
    expect(svc.artistRequest()?.albums.length).toBe(2);
    svc.confirmArtist();
    expect(svc.artistRequest()).toBeNull();
    expect(svc.tasks().length).toBe(2);
    await settled();
    expect(saved.map((s) => s.name)).toEqual(['Ann - LP.zip', 'Ann - LP.zip']);
  });
});
