// WebVTT fetched and rendered by us instead of a <track> element: native
// text-track rendering on old TV browsers is unreliable (Samsung's 2017
// engine often fetches the file but never paints a cue, and its built-in CC
// toggle is a tiny hit target a remote can't reach). Fetching the text and
// drawing the active cue into our own overlay works on anything with fetch().

export interface Cue {
  start: number;
  end: number;
  text: string;
}

function parseTimestamp(raw: string): number {
  // "hh:mm:ss.mmm" or "mm:ss.mmm"
  const m = raw.trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$/);
  if (!m) return NaN;
  const h = m[1] ? parseInt(m[1], 10) : 0;
  const mm = parseInt(m[2], 10);
  const ss = parseInt(m[3], 10);
  const ms = parseInt((m[4] + '00').slice(0, 3), 10);
  return h * 3600 + mm * 60 + ss + ms / 1000;
}

function cleanText(lines: string[]): string {
  return lines
    .join('\n')
    .replace(/<[^>]*>/g, '')         // <i>, <b>, <c.class>, <00:00:01.000> timing tags
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/\{\\[^}]*\}/g, '')      // stray ASS/SSA style codes
    .trim();
}

export function parseVtt(vtt: string): Cue[] {
  const cues: Cue[] = [];
  const blocks = vtt.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split(/\n{2,}/);
  for (let i = 0; i < blocks.length; i++) {
    const lines = blocks[i].split('\n');
    let timing = -1;
    for (let j = 0; j < lines.length && j < 3; j++) {
      if (lines[j].indexOf('-->') !== -1) { timing = j; break; }
    }
    if (timing === -1) continue;
    const arrow = lines[timing].split('-->');
    const start = parseTimestamp(arrow[0]);
    // Cue settings (e.g. "line:90% align:start") follow the end time.
    const end = parseTimestamp((arrow[1] || '').trim().split(/\s+/)[0] || '');
    if (!isFinite(start) || !isFinite(end) || end <= start) continue;
    const text = cleanText(lines.slice(timing + 1));
    if (!text) continue;
    cues.push({ start: start, end: end, text: text });
  }
  cues.sort(function (a, b) { return a.start - b.start; });
  return cues;
}

export function fetchCues(src: string): Promise<Cue[]> {
  return fetch(src).then(function (res) {
    if (!res.ok) throw new Error('subtitle download failed (' + res.status + ')');
    return res.text();
  }).then(parseVtt);
}

// Binary search for the first cue that could still be active at `time`,
// then walk forward to collect overlapping ones. Called on every timeupdate
// so it has to stay cheap on a TV CPU.
export function activeCueText(cues: Cue[], time: number): string {
  if (!cues.length) return '';
  let lo = 0;
  let hi = cues.length - 1;
  let idx = cues.length;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cues[mid].end > time) { idx = mid; hi = mid - 1; } else { lo = mid + 1; }
  }
  const out: string[] = [];
  for (let i = idx; i < cues.length && i < idx + 4; i++) {
    const c = cues[i];
    if (c.start > time) break;
    if (c.end > time) out.push(c.text);
  }
  return out.join('\n');
}
