import { TestBed } from '@angular/core/testing';
import { musicStorage } from '../utils/music-storage';
import { MusicAutoEqService } from './music-autoeq.service';

describe('MusicAutoEqService', () => {
  beforeEach(() => musicStorage.remove('autoeq-profiles'));

  const bands = [{ type: 'peaking' as const, freq: 1000, gain: -3, q: 1.5, channel: 'stereo' as const, enabled: true }];

  it('saves, lists (newest first), persists and deletes profiles', () => {
    const s = TestBed.inject(MusicAutoEqService);
    const a = s.saveProfile({ name: 'HD 600', source: 'Sennheiser HD 600', target: 'harman_oe_2018', preamp: -3, bands });
    const b = s.saveProfile({ name: '  ', source: 'Custom', target: 'flat', preamp: 0, bands });
    expect(s.profiles().map((p) => p.id)).toEqual([b.id, a.id]);
    expect(b.name).toBe('Untitled');
    expect(musicStorage.read<unknown[]>('autoeq-profiles', []).length).toBe(2);
    s.deleteProfile(a.id);
    expect(s.profiles().length).toBe(1);
  });

  it('ignores corrupt stored profiles', () => {
    musicStorage.write('autoeq-profiles', [null, { id: 1 }, { id: 'x', bands: [] }, { id: 'ok', name: 'n', bands: [{ freq: 100, gain: 2, q: 1 }] }]);
    const s = TestBed.inject(MusicAutoEqService);
    expect(s.profiles().map((p) => p.id)).toEqual(['ok']);
  });

  it('parses custom measurement CSV and rejects junk', () => {
    const s = TestBed.inject(MusicAutoEqService);
    const rows = Array.from({ length: 20 }, (_, i) => `${20 * (i + 1)},${70 + i}`).join('\n');
    expect(s.parseCustomCurve('freq,spl\n' + rows).length).toBe(20);
    expect(() => s.parseCustomCurve('hello')).toThrowError(/frequency/);
  });
});
