import { parseIndexMarkdown, FALLBACK_INDEX, measurementUrls, parseFrData, searchHeadphones } from './music-autoeq-data';

describe('music-autoeq-data', () => {
  it('parses whitespace, csv with header (raw column), semicolons and european decimals', () => {
    expect(parseFrData('20 70\n100 71.5\n# x\n1000 72')).toEqual([{ freq: 20, gain: 70 }, { freq: 100, gain: 71.5 }, { freq: 1000, gain: 72 }]);
    const csv = 'frequency,raw,error,smoothed\n1000,80.1,0.2,80\n20,75,0,75';
    expect(parseFrData(csv)).toEqual([{ freq: 20, gain: 75 }, { freq: 1000, gain: 80.1 }]);
    expect(parseFrData('freq;spl\n100;70,5\n200;71,25')).toEqual([{ freq: 100, gain: 70.5 }, { freq: 200, gain: 71.25 }]);
    expect(parseFrData('')).toEqual([]);
    expect(parseFrData('hello,world')).toEqual([]);
  });

  it('parses AutoEq INDEX.md lines, including names with parentheses', () => {
    const idx = parseIndexMarkdown([
      '# Index',
      'Some prose.',
      '',
      '- [Sennheiser HD 650](./oratory1990/over-ear/Sennheiser%20HD%20650) by oratory1990',
      '- [1MORE Aero (ANC Off)](./HypetheSonics/GRAS%20RA0045%20in-ear/1MORE%20Aero%20(ANC%20Off)) by HypetheSonics on GRAS RA0045',
      '- [Sennheiser HD 600](./crinacle/GRAS%2043AG-7%20over-ear/Sennheiser%20HD%20600) by crinacle on GRAS 43AG-7',
      '- [Apple AirPods Pro2](./Rtings/Bruel%20%26%20Kjaer%205128%20in-ear/Apple%20AirPods%20Pro2) by Rtings on Bruel & Kjaer 5128',
    ].join('\n'));
    expect(idx.map((e) => e.name)).toEqual(['1MORE Aero (ANC Off) (HypetheSonics)', 'Apple AirPods Pro2 (Rtings)', 'Sennheiser HD 650 (oratory1990)']);
    expect(idx[0].path).toBe('HypetheSonics/GRAS RA0045 in-ear/1MORE Aero (ANC Off)');
    expect(idx[0].fileName).toBe('1MORE Aero (ANC Off).csv');
    expect(idx[1].type).toBe('in-ear');
    expect(idx[2].type).toBe('over-ear');
    expect(idx.length).toBe(3); // the crinacle line (no measurement file in the repo) is skipped
    expect(parseIndexMarkdown('nothing')).toEqual([]);
  });

  it('searches by words and type, and encodes measurement urls', () => {
    expect(searchHeadphones('hd 600', FALLBACK_INDEX).length).toBe(2);
    expect(searchHeadphones('', FALLBACK_INDEX, 'in-ear').every((e) => e.type === 'in-ear')).toBeTrue();
    expect(searchHeadphones('', FALLBACK_INDEX, 'all', 2).length).toBe(2);
    const urls = measurementUrls(FALLBACK_INDEX[0]);
    expect(urls[0]).toContain('raw.githubusercontent.com');
    expect(urls[0]).toContain('Bruel%20%26%20Kjaer%205128%20over-ear');
    expect(urls[1]).toContain('cdn.jsdelivr.net');
  });
});
