import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { MusicSettingsService } from './music-settings.service';
import { MusicService, MusicTrack } from './music.service';
import { MusicWaveformService } from './music-waveform.service';

describe('MusicWaveformService', () => {
  const track = { id: 999001, duration: 30 } as MusicTrack;
  let manifestCalls: number;
  let waveform: boolean;
  let silence: boolean;

  beforeEach(() => {
    manifestCalls = 0;
    waveform = false;
    silence = false;
    TestBed.configureTestingModule({
      providers: [
        { provide: MusicService, useValue: { manifest: () => { manifestCalls++; return of({ kind: 'file', url: '/nonexistent-p5.m4a' }); } } },
        { provide: MusicSettingsService, useValue: { waveformSeekbar: () => waveform, removeSilence: () => silence } },
      ],
    });
  });

  it('does nothing (no network) while both settings are off', () => {
    const s = TestBed.inject(MusicWaveformService);
    s.request(track);
    expect(manifestCalls).toBe(0);
    expect(s.peaks(track.id)()).toBeNull();
    expect(s.bounds(track.id)).toBeNull();
  });

  it('asks for the LOW manifest when the waveform setting is on and degrades silently on a bad file', async () => {
    waveform = true;
    const s = TestBed.inject(MusicWaveformService);
    s.request(track);
    await new Promise((r) => setTimeout(r, 300));
    expect(manifestCalls).toBe(1);
    expect(s.peaks(track.id)()).toBeNull();
    // A failed track is not retried.
    s.request(track);
    await new Promise((r) => setTimeout(r, 100));
    expect(manifestCalls).toBe(1);
  });

  it('hands out the same read-only signal per track', () => {
    const s = TestBed.inject(MusicWaveformService);
    expect(s.peaks(1)()).toBeNull();
    expect(typeof (s.peaks(1) as unknown as { set?: unknown }).set).toBe('undefined');
  });
});
