import { calculateLineAlignments, isRightToLeftLanguage, parseTTML, parseTTMLTime, toMilliseconds } from './music-lyrics-ttml';

const FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttm="http://www.w3.org/ns/ttml#metadata" xmlns:itunes="http://music.apple.com/lyric-ttml-internal" xml:lang="en">
  <head>
    <metadata>
      <ttm:agent type="person" xml:id="v1"/>
      <ttm:agent type="person" xml:id="v2"/>
      <iTunesMetadata xmlns="http://music.apple.com/lyric-ttml-internal">
        <songwriters><songwriter>Ann Writer</songwriter><songwriter>Bo Composer</songwriter></songwriters>
        <translations><translation type="subtitle" xml:lang="es">
          <text for="L1">Hola mundo</text><text for="L2">Segunda linea</text>
        </translation></translations>
        <transliterations><transliteration xml:lang="en"><text for="L2">daini gyo</text></transliteration></transliterations>
      </iTunesMetadata>
    </metadata>
  </head>
  <body>
    <div itunes:song-part="Verse">
      <p begin="00:01.000" end="00:03.500" ttm:agent="v1" itunes:key="L1">
        <span begin="00:01.000" end="00:01.800">Hello </span><span begin="00:01.800" end="00:03.500">world</span>
      </p>
      <p begin="00:04.000" end="00:06.000" ttm:agent="v2" itunes:key="L2">Second line plain<span ttm:role="x-bg"><span begin="00:05.000" end="00:05.500">(ooh)</span></span></p>
    </div>
    <div itunes:song-part="Chorus">
      <p begin="1:00.000" end="1:02.000" ttm:agent="v1">Last one</p>
    </div>
  </body>
</tt>`;

describe('music-lyrics-ttml', () => {
  it('parses agents, a background vocal, word sync and an embedded translation into the line model', () => {
    const parsed = parseTTML(FIXTURE)!;
    expect(parsed).toBeTruthy();
    expect(parsed.songwriters).toEqual(['Ann Writer', 'Bo Composer']);

    const [l1, l2, bg, l3] = parsed.lines;
    expect(parsed.lines.length).toBe(4);

    expect(l1.text).toBe('Hello world');
    expect(l1.start).toBe(1);
    expect(l1.end).toBe(3.5);
    expect(l1.agent).toBe('v1');
    expect(l1.part).toBe('Verse');
    expect(l1.translation).toBe('Hola mundo');
    expect(l1.syllables).toEqual([
      { start: 1, end: 1.8, text: 'Hello ' },
      { start: 1.8, end: 3.5, text: 'world' },
    ]);
    expect(l1.align).toBe('start');

    expect(l2.text).toBe('Second line plain');
    expect(l2.agent).toBe('v2');
    expect(l2.translation).toBe('Segunda linea');
    expect(l2.romanized).toBe('daini gyo');
    expect(l2.syllables).toBeUndefined();
    expect(l2.align).toBe('end');

    expect(bg.background).toBe(true);
    expect(bg.text).toBe('ooh');
    expect(bg.start).toBe(5);
    expect(bg.end).toBe(5.5);
    expect(bg.agent).toBe('v2');

    expect(l3.start).toBe(60);
    expect(l3.part).toBe('Chorus');
  });

  it('returns null for invalid XML', () => {
    expect(parseTTML('<tt><p></tt>')).toBeNull();
    expect(parseTTML('')).toBeNull();
  });

  it('marks right-to-left lines', () => {
    const xml = `<tt xmlns="http://www.w3.org/ns/ttml"><body><div><p begin="1s" end="2s">مرحبا بالعالم</p></div></body></tt>`;
    expect(parseTTML(xml)!.lines[0].dir).toBe('rtl');
    expect(isRightToLeftLanguage('he-IL')).toBeTrue();
    expect(isRightToLeftLanguage('en')).toBeFalse();
  });

  it('parses TTML clock values', () => {
    expect(parseTTMLTime('00:01:02.500')).toBe(62500);
    expect(parseTTMLTime('1:02.5')).toBe(62500);
    expect(parseTTMLTime('12.5s')).toBe(12500);
    expect(parseTTMLTime('250ms')).toBe(250);
    expect(parseTTMLTime('bad', 7)).toBe(7);
    expect(parseTTMLTime(null)).toBe(0);
  });

  it('alternates duet sides and flips a lopsided result', () => {
    expect(calculateLineAlignments(['a', 'a', 'b', 'a'], {})).toEqual(['start', 'start', 'end', 'start']);
    expect(calculateLineAlignments(['a', 'x'], { a: 'group', x: 'group' })).toEqual(['start', 'start']);
    // v2000 ("other") first would sit right for every line: flipped back to the left.
    expect(calculateLineAlignments(['v2000', 'v2000'], {})).toEqual(['start', 'start']);
    expect(calculateLineAlignments([undefined], {})).toEqual([undefined]);
  });

  it('normalises KPoe style times', () => {
    expect(toMilliseconds(1.5)).toBe(1500);
    expect(toMilliseconds(1500)).toBe(1500);
    expect(toMilliseconds('x', 9)).toBe(9);
  });
});
