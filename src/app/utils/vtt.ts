// Minimal WebVTT parser. The player feeds cues into the browser's TextTrack
// via addCue() instead of letting a <track> element fetch the file: a track
// whose src is (re)assigned after it is already in the DOM can silently never
// load in Chromium and WebKit, which is exactly the "picked a language,
// nothing appeared" failure viewers kept hitting. Cues added by script render
// through the native captions pipeline like any other.

export interface VttCue {
  start: number;
  end: number;
  text: string;
}

function parseTimestamp(raw: string): number {
  const m = raw.trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$/);
  if (!m) return NaN;
  const h = m[1] ? parseInt(m[1], 10) : 0;
  const ms = parseInt((m[4] + '00').slice(0, 3), 10);
  return h * 3600 + parseInt(m[2], 10) * 60 + parseInt(m[3], 10) + ms / 1000;
}

function cleanText(lines: string[]): string {
  return lines
    .join('\n')
    .replace(/\{\\[^}]*\}/g, '') // stray ASS/SSA override codes ({\an8} …)
    .replace(/<font[^>]*>|<\/font>/gi, '') // HTML font tags VTTCue can't render
    .trim();
}

export function parseVtt(vtt: string): VttCue[] {
  const cues: VttCue[] = [];
  const blocks = vtt.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split('\n');
    let timing = -1;
    for (let j = 0; j < lines.length && j < 3; j++) {
      if (lines[j].includes('-->')) {
        timing = j;
        break;
      }
    }
    if (timing === -1) continue;
    const [startRaw, rest = ''] = lines[timing].split('-->');
    const start = parseTimestamp(startRaw);
    const end = parseTimestamp(rest.trim().split(/\s+/)[0] ?? '');
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    const text = cleanText(lines.slice(timing + 1));
    if (!text) continue;
    cues.push({ start, end, text });
  }
  cues.sort((a, b) => a.start - b.start);
  return cues;
}
