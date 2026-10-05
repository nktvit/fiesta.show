import { formatLRCTimestamp, formatTTMLTimestamp, isSynced, isWordSynced, parseLRC, parsePlain, toLRC, toPlain, toTTML } from './music-lyrics-lrc';
import { parseTTML } from './music-lyrics-ttml';

const SAMPLE = `[ti:Song Title]
[ar:Some Artist]
[al:The Album]
[offset:500]
[00:12.00]First line
[00:20.50][01:05.25]Chorus line
[00:30.00]
[00:36.10]After the break
`;

describe('music-lyrics-lrc', () => {
  it('parses tags, multiple timestamps per line and [offset:]', () => {
    const { lines, meta, offsetMs } = parseLRC(SAMPLE);
    expect(meta).toEqual({ ti: 'Song Title', ar: 'Some Artist', al: 'The Album' });
    expect(offsetMs).toBe(500);
    // offset +500 ms: lyrics appear half a second sooner
    expect(lines.map((l) => [l.start, l.text])).toEqual([
      [11.5, 'First line'],
      [20, 'Chorus line'],
      [35.6, 'After the break'],
      [64.75, 'Chorus line'],
    ]);
    // an empty line closes the previous one (so the gap is visible)
    expect(lines[1].end).toBe(29.5);
    // the last line has no successor: 5 s
    expect(lines[3].end).toBeCloseTo(69.75, 5);
  });

  it('reads 1, 2 and 3 digit fractions correctly', () => {
    const { lines } = parseLRC('[00:01.5]a\n[00:02.05]b\n[00:03.123]c');
    expect(lines.map((l) => l.start)).toEqual([1.5, 2.05, 3.123]);
  });

  it('parses A2 enhanced word tags into syllables', () => {
    const { lines } = parseLRC('[00:10.00]<00:10.00>Hel<00:10.40>lo <00:11.00>world<00:11.80>\n[00:13.00]plain');
    expect(lines[0].text).toBe('Hello world');
    expect(lines[0].syllables).toEqual([
      { start: 10, end: 10.4, text: 'Hel' },
      { start: 10.4, end: 11, text: 'lo ' },
      { start: 11, end: 11.8, text: 'world' },
    ]);
    expect(isWordSynced(lines)).toBeTrue();
    expect(lines[1].syllables).toBeUndefined();
  });

  it('round-trips: toLRC(parseLRC(x)) is stable', () => {
    const first = parseLRC(SAMPLE);
    const a = toLRC(first.lines, first.meta);
    const second = parseLRC(a);
    const b = toLRC(second.lines, second.meta);
    expect(b).toBe(a);
    expect(a).toContain('[ti:Song Title]');
    expect(a).toContain('[00:11.50]First line');
    expect(a).toContain('[01:04.75]Chorus line');
  });

  it('writes background vocals in parentheses (and stays stable)', () => {
    const lines = [
      { start: 1, end: 2, text: 'Main' },
      { start: 1.5, end: 2, text: 'ooh', background: true },
    ];
    const a = toLRC(lines);
    expect(a).toBe('[00:01.00]Main\n[00:01.50](ooh)\n');
    expect(toLRC(parseLRC(a).lines)).toBe(a);
    expect(toPlain(lines)).toBe('Main\n(ooh)');
  });

  it('writes unsynced lyrics as plain rows and parses plain text', () => {
    const plain = parsePlain('one\n\n  two  \n');
    expect(plain.map((l) => l.text)).toEqual(['one', 'two']);
    expect(isSynced(plain)).toBeFalse();
    expect(toLRC(plain)).toBe('one\ntwo\n');
  });

  it('formats timestamps', () => {
    expect(formatLRCTimestamp(61.239)).toBe('01:01.23');
    expect(formatLRCTimestamp(0)).toBe('00:00.00');
    expect(formatTTMLTimestamp(3723.5)).toBe('01:02:03.500');
  });

  it('writes TTML that parses back to the same lines', () => {
    const lines = [
      { start: 1, end: 3.5, text: 'Hello world', agent: 'v1', part: 'Verse', syllables: [{ start: 1, end: 1.8, text: 'Hello ' }, { start: 1.8, end: 3.5, text: 'world' }] },
      { start: 2.5, end: 3, text: 'ooh', background: true, agent: 'v1' },
      { start: 4, end: 6, text: 'Fish & <chips>', agent: 'v2', part: 'Chorus' },
    ];
    const xml = toTTML(lines, { songwriters: ['A & B'] });
    const back = parseTTML(xml)!;
    expect(back.songwriters).toEqual(['A & B']);
    expect(back.lines.map((l) => [l.text, l.start, l.end, l.background ?? false, l.agent, l.part])).toEqual([
      ['Hello world', 1, 3.5, false, 'v1', 'Verse'],
      ['ooh', 2.5, 3, true, 'v1', 'Verse'],
      ['Fish & <chips>', 4, 6, false, 'v2', 'Chorus'],
    ]);
    expect(back.lines[0].syllables?.length).toBe(2);
  });
});
