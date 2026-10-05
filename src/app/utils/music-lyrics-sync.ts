// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
// Derived from @uimaxbai/am-lyrics src/AmLyrics.ts - adapted for Fiesta.
import type { MusicLyricLine, MusicLyricSyllable } from './music-lyrics-types';

/** Gaps between lines longer than this get the three-dot indicator (seconds). */
export const MUSIC_LYRICS_GAP_SECONDS = 5;
/** After the last line ends, nothing stays highlighted. */
const END_GRACE_SECONDS = 0.25;

export interface MusicLyricGap {
  /** Index in `lines` of the line this gap sits before (lines.length when trailing). */
  beforeIndex: number;
  start: number;
  end: number;
}

/** Indices of lines that carry the main vocal (not background). */
export function mainLineIndices(lines: readonly MusicLyricLine[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < lines.length; i++) if (!lines[i].background) out.push(i);
  return out;
}

/**
 * The line to highlight at time `t` (seconds): the last main line that has
 * started, binary-searched. -1 before the first line, inside an instrumental
 * gap, or after the final line has ended.
 */
export function activeLineIndex(lines: readonly MusicLyricLine[], t: number, main: readonly number[] = mainLineIndices(lines)): number {
  let lo = 0;
  let hi = main.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[main[mid]].start <= t) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (found < 0) return -1;
  const idx = main[found];
  const line = lines[idx];
  const blockEnd = blockEndOf(lines, idx);
  const nextMain = found + 1 < main.length ? lines[main[found + 1]] : null;
  if (nextMain) {
    if (t >= blockEnd && nextMain.start - blockEnd >= MUSIC_LYRICS_GAP_SECONDS) return -1;
  } else if (t > Math.max(blockEnd, line.end) + END_GRACE_SECONDS) {
    return -1;
  }
  return idx;
}

/** End of a main line including the background line(s) that follow it. */
function blockEndOf(lines: readonly MusicLyricLine[], idx: number): number {
  let end = lines[idx].end;
  for (let j = idx + 1; j < lines.length && lines[j].background; j++) end = Math.max(end, lines[j].end);
  return end;
}

/** Instrumental gaps: before the first line and between lines, longer than the threshold. */
export function findInstrumentalGaps(lines: readonly MusicLyricLine[], threshold = MUSIC_LYRICS_GAP_SECONDS): MusicLyricGap[] {
  const gaps: MusicLyricGap[] = [];
  const main = mainLineIndices(lines);
  if (main.length === 0) return gaps;
  const first = lines[main[0]];
  if (first.start >= threshold) gaps.push({ beforeIndex: main[0], start: 0, end: first.start });
  for (let k = 0; k < main.length - 1; k++) {
    const end = blockEndOf(lines, main[k]);
    const next = lines[main[k + 1]].start;
    if (next - end >= threshold) gaps.push({ beforeIndex: main[k + 1], start: end, end: next });
  }
  return gaps;
}

export function activeGap(gaps: readonly MusicLyricGap[], t: number): MusicLyricGap | null {
  for (const g of gaps) if (t >= g.start && t < g.end) return g;
  return null;
}

/** 0..1 progress through a syllable at time `t`. */
export function syllableProgress(s: Pick<MusicLyricSyllable, 'start' | 'end'>, t: number): number {
  if (t <= s.start) return 0;
  if (s.end <= s.start) return 1;
  if (t >= s.end) return 1;
  return (t - s.start) / (s.end - s.start);
}

/** Whether a line is sounding at `t`. */
export function isLineSounding(line: Pick<MusicLyricLine, 'start' | 'end'>, t: number): boolean {
  return t >= line.start && t < line.end;
}

export interface MusicClockAnchor {
  /** Player position (seconds) when the anchor was taken. */
  position: number;
  /** performance.now() at that moment. */
  at: number;
}

/** Smooth position between the player's coarse timeupdate ticks. */
export function interpolatePosition(anchor: MusicClockAnchor, now: number, playing: boolean, rate: number, duration: number): number {
  if (!playing) return anchor.position;
  const est = anchor.position + ((now - anchor.at) / 1000) * (rate > 0 ? rate : 1);
  return duration > 0 ? Math.min(est, duration) : est;
}
