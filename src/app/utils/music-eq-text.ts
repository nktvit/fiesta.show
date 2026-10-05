// Ported from Monochrome (Apache-2.0), js/audio-context.js (exportEQToText / importEQFromText) - adapted for Fiesta.
import { clampBandCount, clampFreq, clampGain, clampPreamp, clampQ, EQ_MAX_BANDS, EqBand, EqFilterType } from './music-eq-core';

const TYPE_OUT: Record<EqFilterType, string> = { peaking: 'PK', lowshelf: 'LSC', highshelf: 'HSC' };
const TYPE_IN: Record<string, EqFilterType> = {
  PK: 'peaking', PEQ: 'peaking', LS: 'lowshelf', LSC: 'lowshelf', LSF: 'lowshelf', HS: 'highshelf', HSC: 'highshelf', HSF: 'highshelf',
};

export interface EqTextResult {
  preamp: number;
  bands: EqBand[];
}

/** EqualizerAPO / Peace text: `Preamp: x dB` then `Filter n: ON PK Fc f Hz Gain g dB Q q`. */
export function exportEqText(preamp: number, bands: readonly EqBand[]): string {
  const lines = [`Preamp: ${preamp.toFixed(1)} dB`];
  bands.forEach((b, i) => {
    lines.push(
      `Filter ${i + 1}: ${b.enabled ? 'ON' : 'OFF'} ${TYPE_OUT[b.type]} Fc ${Math.round(b.freq)} Hz Gain ${b.gain.toFixed(1)} dB Q ${b.q.toFixed(2)}`,
    );
  });
  return lines.join('\n');
}

const PREAMP_RE = /^Preamp:\s*([+-]?\d+(?:\.\d+)?)\s*dB/i;
const FILTER_RE = /^Filter\s*\d*\s*:\s*(ON|OFF)\s+(\w+)\s+Fc\s+(\d+(?:\.\d+)?)\s*Hz(?:\s+Gain\s*([+-]?\d+(?:\.\d+)?)\s*dB)?(?:\s+Q\s+(\d+(?:\.\d+)?))?/i;

/**
 * Parses EqualizerAPO / Peace text. Unknown filter types (low-pass, notch...)
 * are skipped; returns null when no usable filter line was found. Imported
 * bands are always stereo (the format has no mid/side).
 */
export function importEqText(text: string): EqTextResult | null {
  let preamp = 0;
  const bands: EqBand[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const p = PREAMP_RE.exec(line);
    if (p) {
      preamp = clampPreamp(parseFloat(p[1]));
      continue;
    }
    const m = FILTER_RE.exec(line);
    if (!m) continue;
    const type = TYPE_IN[m[2].toUpperCase()];
    if (!type) continue;
    if (bands.length >= EQ_MAX_BANDS) break;
    bands.push({
      type,
      enabled: m[1].toUpperCase() === 'ON',
      freq: clampFreq(parseFloat(m[3])),
      gain: clampGain(m[4] === undefined ? 0 : parseFloat(m[4])),
      q: clampQ(m[5] === undefined ? Math.SQRT1_2 : parseFloat(m[5])),
      channel: 'stereo',
    });
  }
  if (bands.length === 0) return null;
  return { preamp, bands };
}

/** How many bands the import would create (for the "n bands imported" toast). */
export const importedBandCount = (r: EqTextResult): number => clampBandCount(Math.max(r.bands.length, 3));
