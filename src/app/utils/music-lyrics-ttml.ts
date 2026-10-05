// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
// Derived from @uimaxbai/am-lyrics src/AmLyrics.ts - adapted for Fiesta.
import type { MusicLyricLine, MusicLyricSyllable } from './music-lyrics-types';

export interface MusicParsedLyrics {
  lines: MusicLyricLine[];
  songwriters: string[];
}

/** Internal key attribute namespace used by lrc.red TTML files. */
const LRC_RED_NS = 'http://lrc.red/lyric-ttml-internal';
const RTL_LANGS = ['ar', 'dv', 'fa', 'he', 'ku', 'ps', 'ur', 'yi'];

export function isRightToLeftLanguage(language: string | null | undefined): boolean {
  if (!language) return false;
  return RTL_LANGS.includes(language.toLowerCase().split(/[-_]/)[0]);
}

/** Whether the text is mostly written right to left (Arabic, Hebrew, Syriac, Thaana). */
export function looksRightToLeft(text: string): boolean {
  const rtl = (text.match(/[֐-ࣿיִ-﷿ﹰ-﻿]/g) ?? []).length;
  const latin = (text.match(/[A-Za-zÀ-ɏЀ-ӿ぀-ヿ一-鿿가-힯]/g) ?? []).length;
  return rtl > 0 && rtl >= latin;
}

/** TTML clock values ("1:02.5", "00:01:02.500", "12.5s", "250ms") to milliseconds. */
export function parseTTMLTime(value: string | null | undefined, fallback = 0): number {
  if (!value) return fallback;
  const normalized = value.trim().toLowerCase();
  const unit = normalized.match(/^(-?\d+(?:\.\d+)?)(ms|h|m|s)$/);
  if (unit) {
    const mult: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };
    return Math.max(0, Math.round(Number(unit[1]) * (mult[unit[2]] ?? 1)));
  }
  const parts = normalized.split(':').map(Number);
  if (parts.some((p) => !Number.isFinite(p))) return fallback;
  let seconds: number;
  if (parts.length === 3) seconds = parts[0] * 3600 + parts[1] * 60 + parts[2];
  else if (parts.length === 2) seconds = parts[0] * 60 + parts[1];
  else if (parts.length === 1) seconds = parts[0];
  else return fallback;
  return Math.max(0, Math.round(seconds * 1000));
}

/**
 * Which side each line sits on. Groups stay left; people alternate when the
 * singer changes; if almost every line would land right, flip them all.
 */
export function calculateLineAlignments(
  lineSingers: (string | undefined)[],
  agentTypes: Record<string, string>,
): ('start' | 'end' | undefined)[] {
  const out: ('start' | 'end' | undefined)[] = new Array(lineSingers.length).fill(undefined);
  let leftNow = true;
  let lastPerson: string | null = null;
  let right = 0;
  let total = 0;

  lineSingers.forEach((singer, index) => {
    let side: 'start' | 'end' | undefined;
    if (singer) {
      let type = agentTypes[singer];
      if (!type) type = singer === 'v1000' ? 'group' : singer === 'v2000' ? 'other' : 'person';
      if (type === 'group') {
        side = 'start';
      } else {
        if (lastPerson === null) leftNow = type !== 'other';
        else if (singer !== lastPerson) leftNow = !leftNow;
        side = leftNow ? 'start' : 'end';
        lastPerson = singer;
      }
    }
    if (side) {
      total += 1;
      if (side === 'end') right += 1;
    }
    out[index] = side;
  });

  if (total > 0 && Math.round((right / total) * 100) >= 85) {
    for (let i = 0; i < out.length; i++) {
      if (out[i] === 'start') out[i] = 'end';
      else if (out[i] === 'end') out[i] = 'start';
    }
  }
  return out;
}

/** KPoe payloads mix seconds (fractional) and milliseconds (integers). */
export function toMilliseconds(value: unknown, fallback = 0): number {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  if (!Number.isInteger(num)) return Math.round(num * 1000);
  return Math.max(0, Math.round(num));
}

interface RawSyllable {
  text: string;
  start: number;
  end: number;
}

function withSpace(node: Element, text: string): string {
  const next = node.nextSibling;
  if (next && next.nodeType === 3 && /^\s/.test(next.textContent ?? '') && !text.endsWith(' ')) return text + ' ';
  return text;
}

function toSyllables(raw: RawSyllable[]): MusicLyricSyllable[] {
  const out = raw.map((r) => ({ start: r.start / 1000, end: Math.max(r.start, r.end) / 1000, text: r.text }));
  if (out.length > 0) {
    out[0].text = out[0].text.trimStart();
    out[out.length - 1].text = out[out.length - 1].text.trimEnd();
  }
  return out;
}

function joinText(raw: RawSyllable[]): string {
  return raw.map((r) => r.text).join('').replace(/\s+/g, ' ').trim();
}

/**
 * Parses a TTML lyrics document (Apple / lrc.red / BiniLyrics flavour) into
 * the line model: agents (duets), background vocals (their own line right after
 * the main one, `background: true`), word timing, song parts, embedded
 * translations and transliterations. Returns null when it is not valid TTML.
 */
export function parseTTML(ttml: string): MusicParsedLyrics | null {
  if (typeof DOMParser === 'undefined' || !ttml) return null;
  try {
    const doc = new DOMParser().parseFromString(ttml, 'text/xml');
    if (doc.getElementsByTagName('parsererror').length > 0) return null;

    const agentTypes: Record<string, string> = {};
    const agents = doc.getElementsByTagName('ttm:agent');
    for (let i = 0; i < agents.length; i++) {
      const id = agents[i].getAttribute('xml:id');
      const type = agents[i].getAttribute('type');
      if (id && type) agentTypes[id] = type;
    }
    const docLang = doc.documentElement.getAttribute('xml:lang') || doc.documentElement.getAttribute('lang');

    const songwriters: string[] = [];
    const writerNodes = doc.getElementsByTagName('songwriter');
    for (let i = 0; i < writerNodes.length; i++) {
      const name = writerNodes[i].textContent?.trim();
      if (name) songwriters.push(name);
    }

    const translations: Record<string, string> = {};
    const translationNodes = doc.getElementsByTagName('translation');
    for (let i = 0; i < translationNodes.length; i++) {
      const texts = translationNodes[i].getElementsByTagName('text');
      for (let j = 0; j < texts.length; j++) {
        const key = texts[j].getAttribute('for');
        const value = texts[j].textContent?.trim();
        if (key && value && !(key in translations)) translations[key] = value;
      }
    }

    const transliterations: Record<string, string> = {};
    const translitNodes = doc.getElementsByTagName('transliteration');
    for (let i = 0; i < translitNodes.length; i++) {
      const texts = translitNodes[i].getElementsByTagName('text');
      for (let j = 0; j < texts.length; j++) {
        const key = texts[j].getAttribute('for');
        const value = (texts[j].textContent ?? '').trim().replace(/\s+/g, ' ');
        if (key && value && !(key in transliterations)) transliterations[key] = value;
      }
    }

    interface Draft {
      main: MusicLyricLine;
      bg: MusicLyricLine | null;
      singer?: string;
    }
    const drafts: Draft[] = [];
    const pNodes = doc.getElementsByTagName('p');

    for (let i = 0; i < pNodes.length; i++) {
      const p = pNodes[i];
      const key = p.getAttributeNS(LRC_RED_NS, 'key') || p.getAttribute('itunes:key') || '';
      const beginMs = parseTTMLTime(p.getAttribute('begin'));
      const endMs = parseTTMLTime(p.getAttribute('end'), beginMs);
      const agent = p.getAttribute('ttm:agent') || undefined;
      const lang = p.getAttribute('xml:lang') || p.getAttribute('lang') || docLang;
      const parent = p.parentNode as Element | null;
      const part =
        (parent?.tagName === 'div' &&
          (parent.getAttributeNS(LRC_RED_NS, 'songPart') || parent.getAttribute('itunes:song-part') || parent.getAttribute('itunes:songPart'))) ||
        undefined;

      const main: RawSyllable[] = [];
      const bg: RawSyllable[] = [];
      const spans = p.getElementsByTagName('span');
      for (let j = 0; j < spans.length; j++) {
        const span = spans[j];
        const isBgContainer = span.getAttribute('ttm:role') === 'x-bg';
        const inBg = (span.parentNode as Element | null)?.getAttribute?.('ttm:role') === 'x-bg';
        if (isBgContainer) {
          const inner = span.getElementsByTagName('span');
          if (inner.length === 0) {
            const start = parseTTMLTime(span.getAttribute('begin'), beginMs);
            bg.push({ text: span.textContent ?? '', start, end: Math.max(start, parseTTMLTime(span.getAttribute('end'), endMs)) });
          }
          for (let k = 0; k < inner.length; k++) {
            const text = withSpace(inner[k], inner[k].textContent ?? '');
            const start = parseTTMLTime(inner[k].getAttribute('begin'), beginMs);
            bg.push({ text, start, end: Math.max(start, parseTTMLTime(inner[k].getAttribute('end'), endMs)) });
          }
          continue;
        }
        if (inBg) continue;
        const text = withSpace(span, span.textContent ?? '');
        const start = parseTTMLTime(span.getAttribute('begin'), beginMs);
        main.push({ text, start, end: Math.max(start, parseTTMLTime(span.getAttribute('end'), endMs)) });
      }

      let wordSynced = false;
      for (let j = 0; j < spans.length; j++) {
        const sp = spans[j];
        const bgish = sp.getAttribute('ttm:role') === 'x-bg' || (sp.parentNode as Element | null)?.getAttribute?.('ttm:role') === 'x-bg';
        if (!bgish && sp.getAttribute('begin') && sp.getAttribute('end')) wordSynced = true;
      }
      if (main.length === 0) {
        const own = Array.from(p.childNodes)
          .filter((n) => !(n instanceof Element && n.getAttribute('ttm:role') === 'x-bg'))
          .map((n) => n.textContent ?? '')
          .join('');
        if (own.trim()) main.push({ text: own.trim(), start: beginMs, end: endMs });
      }
      if (main.length === 0 && bg.length === 0) continue;

      const mainText = joinText(main);
      const mainStart = p.getAttribute('begin') || main.length === 0 ? beginMs : Math.min(...main.map((s) => s.start));
      const mainEnd = Math.max(endMs, mainStart, ...main.map((s) => s.end));
      const dir: 'rtl' | undefined =
        p.getAttribute('dir') === 'rtl' || isRightToLeftLanguage(lang) || looksRightToLeft(mainText) ? 'rtl' : undefined;

      const mainLine: MusicLyricLine = {
        start: mainStart / 1000,
        end: mainEnd / 1000,
        text: mainText,
      };
      if (wordSynced && main.length > 0) mainLine.syllables = toSyllables(main);
      if (agent) mainLine.agent = agent;
      if (part) mainLine.part = part;
      if (dir) mainLine.dir = dir;
      if (key && translations[key]) mainLine.translation = translations[key];
      if (key && transliterations[key]) mainLine.romanized = transliterations[key];

      let bgLine: MusicLyricLine | null = null;
      if (bg.length > 0) {
        const bgText = joinText(bg).replace(/^\((.*)\)$/, '$1');
        const bgStart = Math.min(...bg.map((s) => s.start));
        const bgEnd = Math.max(...bg.map((s) => s.end), bgStart);
        if (bgText) {
          bgLine = { start: bgStart / 1000, end: bgEnd / 1000, text: bgText, background: true };
          if (bg.length > 1) bgLine.syllables = toSyllables(bg);
          if (agent) bgLine.agent = agent;
          if (part) bgLine.part = part;
          if (dir) bgLine.dir = dir;
        }
      }
      if (mainText) drafts.push({ main: mainLine, bg: bgLine, singer: agent });
      else if (bgLine) drafts.push({ main: bgLine, bg: null, singer: agent });
    }

    // Order by start time (stable), keeping each background line with its main line.
    const sorted = drafts
      .map((d, idx) => ({ d, idx }))
      .sort((a, b) => a.d.main.start - b.d.main.start || a.idx - b.idx)
      .map((x) => x.d);
    const alignments = calculateLineAlignments(
      sorted.map((d) => d.singer),
      agentTypes,
    );
    const lines: MusicLyricLine[] = [];
    sorted.forEach((d, i) => {
      const align = alignments[i];
      if (align) {
        d.main.align = align;
        if (d.bg) d.bg.align = align;
      }
      lines.push(d.main);
      if (d.bg) lines.push(d.bg);
    });
    return { lines, songwriters };
  } catch {
    return null;
  }
}
