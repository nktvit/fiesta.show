// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
// Derived from @uimaxbai/am-lyrics src/AmLyrics.ts - adapted for Fiesta.
import type { MusicLrcMeta, MusicLyricLine, MusicLyricSyllable } from './music-lyrics-types';
import { looksRightToLeft } from './music-lyrics-ttml';

export interface MusicParsedLrc {
  lines: MusicLyricLine[];
  meta: MusicLrcMeta;
  /** The [offset:] tag in ms (already applied to the line times). */
  offsetMs: number;
}

const STAMP_RE = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g;
const LEAD_RE = /^((?:\s*\[\d{1,3}:\d{2}(?:[.:]\d{1,3})?\])+)(.*)$/;
const WORD_RE = /<(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?>/g;
const META_RE = /^\s*\[([a-zA-Z#]+):(.*)\]\s*$/;
/** Last line has no successor; give it this long. */
const LAST_LINE_SECONDS = 5;

function fracToMs(frac: string | undefined): number {
  if (!frac) return 0;
  return Number(frac.padEnd(3, '0').slice(0, 3));
}

function stampToMs(min: string, sec: string, frac?: string): number {
  return (Number(min) * 60 + Number(sec)) * 1000 + fracToMs(frac);
}

interface RawWord {
  text: string;
  start: number;
  /** null = ends with the line. */
  end: number | null;
}

/** Splits "<00:01.00>Hel<00:01.40>lo <00:02.00>" into timed syllables (ms). */
function parseWordTags(text: string, lineStartMs: number): { text: string; syllables?: RawWord[] } {
  WORD_RE.lastIndex = 0;
  const tags: { at: number; index: number; len: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = WORD_RE.exec(text))) tags.push({ at: stampToMs(m[1], m[2], m[3]), index: m.index, len: m[0].length });
  if (tags.length === 0) return { text: text.trim() };

  const segs: RawWord[] = [];
  const lead = text.slice(0, tags[0].index);
  if (lead.trim()) segs.push({ text: lead, start: lineStartMs, end: tags[0].at });
  for (let i = 0; i < tags.length; i++) {
    const seg = text.slice(tags[i].index + tags[i].len, i + 1 < tags.length ? tags[i + 1].index : text.length);
    // An empty segment (a closing tag) only ends the previous word, which already ends at this tag.
    if (seg !== '') segs.push({ text: seg, start: tags[i].at, end: i + 1 < tags.length ? tags[i + 1].at : null });
  }
  const full = segs.map((s) => s.text).join('').replace(/\s+/g, ' ').trim();
  return { text: full, syllables: segs.length > 0 ? segs : undefined };
}

/**
 * Parses LRC: [mm:ss.xx] lines, several timestamps per line, [offset:+/-ms],
 * header tags and A2 "enhanced" <mm:ss.xx> word tags. Empty lines are not
 * returned but close the previous line (so instrumental gaps stay visible).
 */
export function parseLRC(input: string): MusicParsedLrc {
  const meta: MusicLrcMeta = {};
  let offsetMs = 0;
  const entries: { start: number; text: string; syllables?: RawWord[] }[] = [];

  for (const raw of (input ?? '').replace(/^﻿/, '').split(/\r?\n/)) {
    const lead = raw.match(LEAD_RE);
    if (lead) {
      const stamps: number[] = [];
      STAMP_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = STAMP_RE.exec(lead[1]))) stamps.push(stampToMs(m[1], m[2], m[3]));
      const first = stamps[0];
      const parsed = parseWordTags(lead[2], first);
      for (const stamp of stamps) {
        const shift = stamp - first;
        entries.push({
          start: stamp,
          text: parsed.text,
          syllables: parsed.syllables?.map((s) => ({ start: s.start + shift, end: s.end === null ? null : s.end + shift, text: s.text })),
        });
      }
      continue;
    }
    const tag = raw.match(META_RE);
    if (tag) {
      const key = tag[1].toLowerCase();
      const value = tag[2].trim();
      if (key === 'offset') {
        const n = Number(value);
        if (Number.isFinite(n)) offsetMs = Math.round(n);
      } else if (key === 'ti' || key === 'ar' || key === 'al' || key === 're') {
        if (value) meta[key] = value;
      }
    }
  }

  // Positive offset = lyrics should appear sooner.
  const shifted = entries.map((e, i) => ({
    ...e,
    i,
    start: Math.max(0, e.start - offsetMs),
    syllables: e.syllables?.map((s) => ({ start: Math.max(0, s.start - offsetMs), end: s.end === null ? null : Math.max(0, s.end - offsetMs), text: s.text })),
  }));
  shifted.sort((a, b) => a.start - b.start || a.i - b.i);

  const lines: MusicLyricLine[] = [];
  for (let i = 0; i < shifted.length; i++) {
    const e = shifted[i];
    if (!e.text) continue;
    const endMs = i + 1 < shifted.length ? Math.max(shifted[i + 1].start, e.start) : e.start + LAST_LINE_SECONDS * 1000;
    const line: MusicLyricLine = { start: e.start / 1000, end: endMs / 1000, text: e.text };
    if (e.syllables && e.syllables.length > 0) {
      const syl: MusicLyricSyllable[] = e.syllables.map((s) => ({
        start: s.start / 1000,
        end: (s.end === null ? Math.max(endMs, s.start) : Math.max(s.end, s.start)) / 1000,
        text: s.text,
      }));
      line.syllables = syl;
    }
    if (looksRightToLeft(e.text)) line.dir = 'rtl';
    lines.push(line);
  }
  return { lines, meta, offsetMs };
}

/** Plain text (unsynced): one line per non-empty row, no timing. */
export function parsePlain(input: string): MusicLyricLine[] {
  return (input ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((text) => {
      const line: MusicLyricLine = { start: 0, end: 0, text };
      if (looksRightToLeft(text)) line.dir = 'rtl';
      return line;
    });
}

/** True when any line has timing. */
export function isSynced(lines: readonly MusicLyricLine[]): boolean {
  return lines.some((l) => l.start > 0 || l.end > 0);
}

export function isWordSynced(lines: readonly MusicLyricLine[]): boolean {
  return lines.some((l) => (l.syllables?.length ?? 0) > 1);
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

/** mm:ss.xx (hundredths, floored), as used by LRC. */
export function formatLRCTimestamp(seconds: number): string {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const minutes = Math.floor(ms / 60000);
  const secs = Math.floor((ms % 60000) / 1000);
  const hundredths = Math.floor((ms % 1000) / 10);
  return `${pad(minutes)}:${pad(secs)}.${pad(hundredths)}`;
}

/** HH:MM:SS.mmm, as used by TTML. */
export function formatTTMLTimestamp(seconds: number): string {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(ms % 1000, 3)}`;
}

function wrapBackground(text: string): string {
  return text.startsWith('(') && text.endsWith(')') ? text : `(${text})`;
}

/** Plain text. Background vocals go in parentheses. */
export function toPlain(lines: readonly MusicLyricLine[]): string {
  return lines
    .map((l) => (l.text ?? '').trim())
    .map((t, i) => (t && lines[i].background ? wrapBackground(t) : t))
    .filter(Boolean)
    .join('\n');
}

/** LRC with an optional header; unsynced lyrics come out as plain lines. */
export function toLRC(lines: readonly MusicLyricLine[], meta: MusicLrcMeta = {}): string {
  const synced = isSynced(lines);
  let out = '';
  for (const key of ['ti', 'ar', 'al', 're'] as const) {
    const v = meta[key]?.replace(/[\r\n]+/g, ' ').trim();
    if (v) out += `[${key}:${v}]\n`;
  }
  for (const line of lines) {
    const text = (line.text ?? '').trim();
    if (!text) continue;
    const shown = line.background ? wrapBackground(text) : text;
    out += synced ? `[${formatLRCTimestamp(line.start)}]${shown}\n` : `${shown}\n`;
  }
  return out;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** TTML with agents, song parts, word spans and background vocals. */
export function toTTML(lines: readonly MusicLyricLine[], opts: { songwriters?: readonly string[]; language?: string } = {}): string {
  const agents: string[] = [];
  for (const l of lines) if (l.agent && !agents.includes(l.agent)) agents.push(l.agent);

  let out = '<?xml version="1.0" encoding="UTF-8"?>\n';
  out +=
    '<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttm="http://www.w3.org/ns/ttml#metadata" xmlns:itunes="http://music.apple.com/lyric-ttml-internal"' +
    (opts.language ? ` xml:lang="${esc(opts.language)}"` : '') +
    '>\n';
  out += '  <head>\n    <metadata>\n';
  for (const a of agents) out += `      <ttm:agent type="person" xml:id="${esc(a)}"/>\n`;
  if (opts.songwriters?.length) {
    out += '      <iTunesMetadata xmlns="http://music.apple.com/lyric-ttml-internal"><songwriters>';
    for (const w of opts.songwriters) out += `<songwriter>${esc(w)}</songwriter>`;
    out += '</songwriters></iTunesMetadata>\n';
  }
  out += '    </metadata>\n  </head>\n  <body>\n';

  const span = (l: MusicLyricLine, indent: string) => {
    const syl = l.syllables?.length
      ? l.syllables
      : [{ start: l.start, end: l.end, text: l.text }];
    return syl
      .map((s) => `${indent}<span begin="${formatTTMLTimestamp(s.start)}" end="${formatTTMLTimestamp(s.end)}">${esc(s.text)}</span>\n`)
      .join('');
  };

  let part: string | undefined;
  let open = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.background) {
      // Orphan background line: its own paragraph.
      if (!open) {
        out += '    <div>\n';
        open = true;
      }
      out += `      <p begin="${formatTTMLTimestamp(line.start)}" end="${formatTTMLTimestamp(line.end)}"${line.agent ? ` ttm:agent="${esc(line.agent)}"` : ''}>\n`;
      out += `        <span ttm:role="x-bg">\n${span(line, '          ')}        </span>\n      </p>\n`;
      continue;
    }
    if (!open || line.part !== part) {
      if (open) out += '    </div>\n';
      part = line.part;
      out += part ? `    <div itunes:song-part="${esc(part)}">\n` : '    <div>\n';
      open = true;
    }
    out += `      <p begin="${formatTTMLTimestamp(line.start)}" end="${formatTTMLTimestamp(line.end)}"${line.agent ? ` ttm:agent="${esc(line.agent)}"` : ''}>\n`;
    out += span(line, '        ');
    const next = lines[i + 1];
    if (next?.background) {
      out += `        <span ttm:role="x-bg">\n${span(next, '          ')}        </span>\n`;
      i += 1;
    }
    out += '      </p>\n';
  }
  if (open) out += '    </div>\n';
  out += '  </body>\n</tt>\n';
  return out;
}
