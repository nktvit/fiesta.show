import { fuzzyNormalize, fuzzyRank, fuzzyScore } from './music-fuzzy';

describe('music-fuzzy', () => {
  it('normalizes case and accents', () => {
    expect(fuzzyNormalize('  Beyoncé ')).toBe('beyonce');
  });

  it('ranks exact > prefix > word start > substring > subsequence', () => {
    const exact = fuzzyScore('library', 'library');
    const prefix = fuzzyScore('lib', 'library');
    const word = fuzzyScore('lib', 'go to library');
    const sub = fuzzyScore('ibr', 'library');
    const seq = fuzzyScore('lby', 'library');
    expect(exact).toBeGreaterThan(prefix);
    expect(prefix).toBeGreaterThan(word);
    expect(word).toBeGreaterThan(sub);
    expect(sub).toBeGreaterThan(seq);
    expect(seq).toBeGreaterThan(0);
  });

  it('returns 0 when a token matches nothing', () => {
    expect(fuzzyScore('zzz', 'Toggle shuffle')).toBe(0);
    expect(fuzzyScore('shuffle zzz', 'Toggle shuffle')).toBe(0);
  });

  it('matches several tokens in any order', () => {
    expect(fuzzyScore('shuffle toggle', 'Toggle shuffle')).toBeGreaterThan(0);
  });

  it('uses keywords as a weaker second source', () => {
    const viaLabel = fuzzyScore('sleep', 'Sleep timer', 'bedtime');
    const viaKeyword = fuzzyScore('bedtime', 'Sleep timer', 'bedtime');
    expect(viaKeyword).toBeGreaterThan(0);
    expect(viaLabel).toBeGreaterThan(viaKeyword);
  });

  it('rejects widely scattered subsequences', () => {
    expect(fuzzyScore('abc', 'a very long label with b somewhere and c at the far end here')).toBe(0);
  });

  it('empty query keeps the original order; otherwise filters and sorts', () => {
    const items = ['Go to Settings', 'Toggle shuffle', 'Go to Library', 'Sleep timer 30 min'];
    expect(fuzzyRank(items, '', (s) => [s]).map((r) => r.item)).toEqual(items);
    const ranked = fuzzyRank(items, 'go lib', (s) => [s]).map((r) => r.item);
    expect(ranked[0]).toBe('Go to Library');
    expect(fuzzyRank(items, 'sleep 30', (s) => [s]).map((r) => r.item)).toEqual(['Sleep timer 30 min']);
    expect(fuzzyRank(items, 'shuf', (s) => [s]).map((r) => r.item)).toEqual(['Toggle shuffle']);
  });
});
