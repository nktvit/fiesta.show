import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { MusicService } from './music.service';

describe('MusicService', () => {
  let service: MusicService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    service = TestBed.inject(MusicService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('search sends the query to /api/music', () => {
    service.search('daft punk').subscribe();
    const req = http.expectOne((r) => r.url === '/api/music');
    expect(req.request.params.get('action')).toBe('search');
    expect(req.request.params.get('q')).toBe('daft punk');
    req.flush({ tracks: [], albums: [], artists: [] });
  });

  it('album and artist send their ids', () => {
    service.album(1550545).subscribe();
    const a = http.expectOne((r) => r.url === '/api/music' && r.params.get('action') === 'album');
    expect(a.request.params.get('id')).toBe('1550545');
    a.flush({ album: {}, tracks: [] });

    service.artist('1566').subscribe();
    const b = http.expectOne((r) => r.url === '/api/music' && r.params.get('action') === 'artist');
    expect(b.request.params.get('id')).toBe('1566');
    b.flush({ artist: {}, topTracks: [], albums: [] });
  });

  it('manifest asks for the requested quality', () => {
    service.manifest(1550546, 'HIGH').subscribe();
    const req = http.expectOne((r) => r.url === '/api/music');
    expect(req.request.params.get('action')).toBe('manifest');
    expect(req.request.params.get('quality')).toBe('HIGH');
    req.flush({ presentation: 'FULL', quality: 'HIGH', signedIn: true, kind: 'segments', codec: 'mp4a.40.2' });
  });

  it('manifest accepts the Hi-Res tier', () => {
    service.manifest(1, 'HI_RES_LOSSLESS').subscribe((m) => expect(m.trackReplayGain).toBe(-5.8));
    const req = http.expectOne((r) => r.url === '/api/music');
    expect(req.request.params.get('quality')).toBe('HI_RES_LOSSLESS');
    req.flush({ presentation: 'FULL', quality: 'LOSSLESS', signedIn: true, kind: 'segments', codec: 'flac', trackReplayGain: -5.8 });
  });
});
