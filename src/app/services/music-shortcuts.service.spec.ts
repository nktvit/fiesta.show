import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideHttpClient } from '@angular/common/http';
import {
  bindingFromEvent, bindingMatches, findConflict, formatBinding, formatBindingParts, MUSIC_SHORTCUTS,
  MusicKeyBinding, MusicShortcutsService, sanitizeOverrides,
} from './music-shortcuts.service';

const ev = (key: string, mods: Partial<{ shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean }> = {}) =>
  ({ key, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...mods });

describe('music shortcut helpers', () => {
  it("ships Monochrome's defaults", () => {
    const by = (id: string) => MUSIC_SHORTCUTS.find((d) => d.id === id)!.binding;
    expect(by('playPause')).toEqual({ key: ' ', shift: false, ctrl: false, alt: false });
    expect(by('nextTrack')).toEqual({ key: 'arrowright', shift: true, ctrl: false, alt: false });
    expect(by('previousTrack')).toEqual({ key: 'arrowleft', shift: true, ctrl: false, alt: false });
    expect(by('visualizerCycle').key).toBe('\\');
    expect(by('visualizerNext').key).toBe(']');
    expect(by('visualizerPrev').key).toBe('[');
    expect(by('palette')).toEqual({ key: 'k', shift: false, ctrl: true, alt: false });
    expect(MUSIC_SHORTCUTS.map((d) => d.id as string)).not.toContain('multiSelect');
  });

  it('default bindings are unique', () => {
    const seen = new Set(MUSIC_SHORTCUTS.map((d) => JSON.stringify(d.binding)));
    expect(seen.size).toBe(MUSIC_SHORTCUTS.length);
  });

  it('turns key events into bindings; modifier-only presses are null', () => {
    expect(bindingFromEvent(ev('Shift', { shiftKey: true }))).toBeNull();
    expect(bindingFromEvent(ev('Control', { ctrlKey: true }))).toBeNull();
    expect(bindingFromEvent(ev('K', { metaKey: true }))).toEqual({ key: 'k', shift: false, ctrl: true, alt: false });
    expect(bindingFromEvent(ev('ArrowRight', { shiftKey: true }))).toEqual({ key: 'arrowright', shift: true, ctrl: false, alt: false });
  });

  it('ignores Shift for symbol keys ("?" is Shift+/ on a US layout)', () => {
    const help = MUSIC_SHORTCUTS.find((d) => d.id === 'help')!.binding;
    expect(bindingMatches(help, ev('?', { shiftKey: true }))).toBeTrue();
    expect(bindingMatches(help, ev('?'))).toBeTrue();
  });

  it('does not match when extra modifiers are held', () => {
    const play = MUSIC_SHORTCUTS.find((d) => d.id === 'playPause')!.binding;
    expect(bindingMatches(play, ev(' '))).toBeTrue();
    expect(bindingMatches(play, ev(' ', { ctrlKey: true }))).toBeFalse();
    const seek = MUSIC_SHORTCUTS.find((d) => d.id === 'seekForward')!.binding;
    expect(bindingMatches(seek, ev('ArrowRight', { shiftKey: true }))).toBeFalse();
    expect(bindingMatches(seek, ev('ArrowRight', { altKey: true }))).toBeFalse();
  });

  it('formats bindings', () => {
    const b = (key: string, o: Partial<MusicKeyBinding> = {}): MusicKeyBinding => ({ key, shift: false, ctrl: false, alt: false, ...o });
    expect(formatBinding(b(' '))).toBe('Space');
    expect(formatBinding(b('k', { ctrl: true }))).toBe('Ctrl+K');
    expect(formatBinding(b('k', { ctrl: true }), true)).toBe('⌘K');
    expect(formatBindingParts(b('arrowright', { shift: true }))).toEqual(['Shift', '→']);
    expect(formatBinding(b('escape'))).toBe('Esc');
  });

  it('finds conflicts', () => {
    const resolved = Object.fromEntries(MUSIC_SHORTCUTS.map((d) => [d.id, d.binding])) as Parameters<typeof findConflict>[0];
    expect(findConflict(resolved, 'shuffle', { key: 'r', shift: false, ctrl: false, alt: false })).toBe('repeat');
    expect(findConflict(resolved, 'shuffle', { key: 's', shift: false, ctrl: false, alt: false })).toBeNull();
    expect(findConflict(resolved, 'shuffle', { key: 'x', shift: false, ctrl: false, alt: false })).toBeNull();
  });

  it('sanitizes stored overrides', () => {
    const out = sanitizeOverrides({
      shuffle: { key: 'X', shift: true, ctrl: false, alt: false },
      repeat: { key: 'Shift' },
      escape: { key: 'x' },
      nonsense: { key: 'y' },
      mute: 'no',
    });
    expect(out.shuffle).toEqual({ key: 'x', shift: true, ctrl: false, alt: false });
    expect(out.repeat).toBeUndefined();
    expect(out.escape).toBeUndefined();
    expect(Object.keys(out)).toEqual(['shuffle']);
    expect(sanitizeOverrides(null)).toEqual({});
  });
});

describe('MusicShortcutsService', () => {
  let svc: MusicShortcutsService;
  beforeEach(() => {
    try { localStorage.removeItem('fiesta:music:shortcuts'); } catch { /* private mode */ }
    TestBed.configureTestingModule({ providers: [provideRouter([]), provideHttpClient()] });
    svc = TestBed.inject(MusicShortcutsService);
  });
  afterEach(() => {
    try { localStorage.removeItem('fiesta:music:shortcuts'); } catch { /* private mode */ }
  });

  const key = (k: string, o: Partial<MusicKeyBinding> = {}): MusicKeyBinding => ({ key: k, shift: false, ctrl: false, alt: false, ...o });

  it('rebinds, persists under fiesta:music:shortcuts, and resets', () => {
    expect(svc.binding('shuffle').key).toBe('s');
    expect(svc.setBinding('shuffle', key('x'))).toEqual({ ok: true });
    expect(svc.binding('shuffle').key).toBe('x');
    expect(svc.isCustom('shuffle')).toBeTrue();
    expect(JSON.parse(localStorage.getItem('fiesta:music:shortcuts') ?? '{}').shuffle.key).toBe('x');
    svc.resetBinding('shuffle');
    expect(svc.binding('shuffle').key).toBe('s');
    expect(svc.isCustom('shuffle')).toBeFalse();
  });

  it('reports a conflict instead of applying it', () => {
    const res = svc.setBinding('shuffle', key('r'));
    expect(res).toEqual({ ok: false, conflict: 'repeat' });
    expect(svc.binding('shuffle').key).toBe('s');
  });

  it('refuses to rebind the fixed Escape action', () => {
    expect(svc.setBinding('escape', key('x')).ok).toBeFalse();
  });

  it('resetAll clears every override', () => {
    svc.setBinding('shuffle', key('x'));
    svc.setBinding('mute', key('n'));
    svc.resetAll();
    expect(svc.isCustom('shuffle') || svc.isCustom('mute')).toBeFalse();
  });
});
