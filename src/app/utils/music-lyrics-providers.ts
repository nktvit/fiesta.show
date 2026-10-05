// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
// Derived from @uimaxbai/am-lyrics src/AmLyrics.ts - adapted for Fiesta.
import { isSynced, isWordSynced, parseLRC, parsePlain } from './music-lyrics-lrc';
import type { MusicLyricsQuery } from './music-lyrics-meta';
import { calculateLineAlignments, looksRightToLeft, parseTTML, toMilliseconds } from './music-lyrics-ttml';
import type { MusicLyricLine, MusicLyricSyllable } from './music-lyrics-types';

/** Every request gets this long before it is abandoned and the next provider is tried. */
export const MUSIC_LYRICS_TIMEOUT_MS = 8000;

export type MusicLyricsProviderId = 'owner' | 'lrcred' | 'bini' | 'unison' | 'lyricsplus' | 'lrclib' | 'genius';

export const MUSIC_LYRICS_PROVIDERS: readonly { id: MusicLyricsProviderId; label: string; hint: string }[] = [
  { id: 'lrcred', label: 'lrc.red', hint: 'Word-synced, matched by ISRC' },
  { id: 'bini', label: 'BiniLyrics', hint: 'Word-synced community cache' },
  { id: 'unison', label: 'Unison', hint: 'Line and word synced' },
  { id: 'lyricsplus', label: 'LyricsPlus', hint: 'Apple, Musixmatch, QQ and more' },
  { id: 'lrclib', label: 'LRCLIB', hint: 'Line-synced and plain text' },
  { id: 'genius', label: 'Genius', hint: 'Plain text, last resort' },
];

export const MUSIC_LYRICS_DISPLAY_NAMES: Record<MusicLyricsProviderId, string> = {
  owner: 'Fiesta',
  lrcred: 'lrc.red',
  bini: 'BiniLyrics',
  unison: 'Unison',
  lyricsplus: 'LyricsPlus',
  lrclib: 'LRCLIB',
  genius: 'Genius',
};

export const KPOE_SERVERS = [
  'https://lyricsplus.binimum.org',
  'https://lyricsplus-seven.vercel.app',
  'https://lyricsplus.prjktla.workers.dev',
  'https://lyrics-plus-backend.vercel.app',
] as const;
export const KPOE_SOURCE_ORDER = 'apple,lyricsplus,musixmatch,spotify,qq,deezer,musixmatch-word';
export const GENIUS_WORKER_URL = 'https://fetch-genius.samidy.workers.dev/';

/** One provider's answer. */
export interface MusicLyricsSourceResult {
  provider: MusicLyricsProviderId;
  /** Name shown in the footer. */
  source: string;
  lines: MusicLyricLine[];
  songwriters: string[];
}

export interface MusicLyricsCtx {
  fetchFn: typeof fetch;
  signal?: AbortSignal;
  timeoutMs: number;
  /** For picking random mirrors; tests pass a fixed one. */
  random: () => number;
  /** Which providers got any HTTP answer / failed outright (for "no lyrics" vs "network down"). */
  responded: Set<MusicLyricsProviderId>;
  errored: Set<MusicLyricsProviderId>;
  tried: Set<MusicLyricsProviderId>;
}

export function createLyricsCtx(partial: Partial<Pick<MusicLyricsCtx, 'fetchFn' | 'signal' | 'timeoutMs' | 'random'>> = {}): MusicLyricsCtx {
  return {
    fetchFn: partial.fetchFn ?? ((...args) => fetch(...args)),
    signal: partial.signal,
    timeoutMs: partial.timeoutMs ?? MUSIC_LYRICS_TIMEOUT_MS,
    random: partial.random ?? Math.random,
    responded: new Set(),
    errored: new Set(),
    tried: new Set(),
  };
}

function abortError(): DOMException {
  return new DOMException('Lyrics request aborted', 'AbortError');
}

function throwIfAborted(ctx: MusicLyricsCtx): void {
  if (ctx.signal?.aborted) throw abortError();
}

/**
 * GET with an 8 s timeout (an AbortSignal merged with the caller's). Returns
 * the response (any status) or null when the request failed or timed out.
 */
async function request(ctx: MusicLyricsCtx, provider: MusicLyricsProviderId, url: string): Promise<Response | null> {
  throwIfAborted(ctx);
  ctx.tried.add(provider);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ctx.timeoutMs);
  const onAbort = () => controller.abort();
  ctx.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await ctx.fetchFn(url, { signal: controller.signal });
    ctx.responded.add(provider);
    return res;
  } catch {
    throwIfAborted(ctx);
    ctx.errored.add(provider);
    return null;
  } finally {
    clearTimeout(timer);
    ctx.signal?.removeEventListener('abort', onAbort);
  }
}

async function readJson(res: Response | null): Promise<unknown> {
  if (!res?.ok) return null;
  try {
    return await res.json();
  } catch {
    return null;
  }
}

async function readText(res: Response | null): Promise<string | null> {
  if (!res?.ok) return null;
  try {
    return await res.text();
  } catch {
    return null;
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const asString = (v: unknown): string => (typeof v === 'string' ? v : '');

function result(provider: MusicLyricsProviderId, lines: MusicLyricLine[], songwriters: string[] = [], source?: string): MusicLyricsSourceResult | null {
  if (lines.length === 0) return null;
  return { provider, source: source ?? MUSIC_LYRICS_DISPLAY_NAMES[provider], lines, songwriters };
}

function secs(n: number): string {
  return String(Math.round(n));
}

// ───────────────────────────── owner override ─────────────────────────────

const looksLikeHtml = (s: string) => /^\s*<(?:!doctype\s+html|html|head|body)\b/i.test(s);

/** `/assets/music/lyrics/{trackId}.ttml` then `.lrc`: the owner's files beat every provider. */
export async function fetchOwnerLyrics(q: MusicLyricsQuery, ctx: MusicLyricsCtx): Promise<MusicLyricsSourceResult | null> {
  const base = `/assets/music/lyrics/${encodeURIComponent(String(q.trackId))}`;
  const ttml = await readText(await request(ctx, 'owner', `${base}.ttml`));
  if (ttml && !looksLikeHtml(ttml)) {
    const parsed = parseTTML(ttml);
    const r = parsed && result('owner', parsed.lines, parsed.songwriters);
    if (r) return r;
  }
  const lrc = await readText(await request(ctx, 'owner', `${base}.lrc`));
  if (lrc && !looksLikeHtml(lrc)) {
    const parsed = parseLRC(lrc);
    const r = result('owner', parsed.lines.length > 0 ? parsed.lines : parsePlain(lrc));
    if (r) return r;
  }
  return null;
}

// ───────────────────────────── lrc.red ─────────────────────────────

async function lrcRedTtml(isrc: string, ctx: MusicLyricsCtx): Promise<MusicLyricsSourceResult | null> {
  const text = await readText(await request(ctx, 'lrcred', `https://lrc.red/s/${encodeURIComponent(isrc)}.ttml`));
  if (!text) return null;
  const parsed = parseTTML(text);
  return parsed ? result('lrcred', parsed.lines, parsed.songwriters) : null;
}

export async function fetchLrcRed(q: MusicLyricsQuery, ctx: MusicLyricsCtx): Promise<MusicLyricsSourceResult | null> {
  if (q.isrc) {
    const direct = await lrcRedTtml(q.isrc, ctx);
    if (direct) return direct;
  }
  if (!q.title || !q.artist) return null;
  const params = new URLSearchParams({ track: q.title, artist: q.artist });
  if (q.album) params.set('album', q.album);
  if (q.durationSec && q.durationSec > 0) params.set('duration', secs(q.durationSec));
  const payload = await readJson(await request(ctx, 'lrcred', `https://lrc.red/match.json?${params}`));
  const hits = isRecord(payload) && Array.isArray(payload['hits']) ? (payload['hits'] as unknown[]) : [];
  const hit = hits[0];
  const isrc = isRecord(hit) ? asString(hit['isrc']).trim() : '';
  // Never fetch anything but a plain ISRC.
  if (isrc && /^[A-Za-z0-9]{8,16}$/.test(isrc) && isrc !== q.isrc) return lrcRedTtml(isrc, ctx);
  return null;
}

// ───────────────────────────── BiniLyrics ─────────────────────────────

export async function fetchBini(q: MusicLyricsQuery, ctx: MusicLyricsCtx): Promise<MusicLyricsSourceResult | null> {
  if ((!q.title || !q.artist) && !q.isrc) return null;
  const firstResult = (data: unknown): Record<string, unknown> | null => {
    if (!isRecord(data) || !Array.isArray(data['results'])) return null;
    const r = (data['results'] as unknown[])[0];
    return isRecord(r) ? r : null;
  };
  let hit: Record<string, unknown> | null = null;
  if (q.isrc) {
    hit = firstResult(await readJson(await request(ctx, 'bini', `https://lyrics-api.binimum.org/?isrc=${encodeURIComponent(q.isrc)}`)));
  }
  if (!hit && q.title && q.artist) {
    const params = new URLSearchParams({ track: q.title, artist: q.artist });
    if (q.album) params.append('album', q.album);
    if (q.durationSec && q.durationSec > 0) params.append('duration', secs(q.durationSec));
    hit = firstResult(await readJson(await request(ctx, 'bini', `https://lyrics-api.binimum.org/?${params}`)));
  }
  const url = hit ? asString(hit['lyricsUrl']) : '';
  // The cache points at a TTML file; follow it only over https.
  if (!/^https:\/\//i.test(url)) return null;
  const ttml = await readText(await request(ctx, 'bini', url));
  if (!ttml) return null;
  const parsed = parseTTML(ttml);
  return parsed ? result('bini', parsed.lines, parsed.songwriters) : null;
}

// ───────────────────────────── Unison ─────────────────────────────

export async function fetchUnison(q: MusicLyricsQuery, ctx: MusicLyricsCtx): Promise<MusicLyricsSourceResult | null> {
  if (!q.title || !q.artist) return null;
  const params = new URLSearchParams({ song: q.title, artist: q.artist });
  if (q.album) params.append('album', q.album);
  if (q.durationSec && q.durationSec > 0) params.append('duration', secs(q.durationSec));
  const payload = await readJson(await request(ctx, 'unison', `https://unison.boidu.dev/lyrics?${params}`));
  if (!isRecord(payload) || !payload['success'] || !isRecord(payload['data'])) return null;
  const data = payload['data'];
  const text = asString(data['lyrics']);
  if (!text) return null;
  const format = asString(data['format']) || 'lrc';
  const syncType = asString(data['syncType']) || 'linesync';
  if (format === 'ttml') {
    const parsed = parseTTML(text);
    return parsed ? result('unison', parsed.lines, parsed.songwriters) : null;
  }
  if (syncType === 'plain') return result('unison', parsePlain(text), [], 'Unison (unsynced)');
  return result('unison', parseLRC(text).lines);
}

// ───────────────────────────── LyricsPlus (KPoe) ─────────────────────────────

/** Converts a KPoe v2 payload (word or line timing, agents, background syllables) to lines. */
export function convertKPoeLyrics(payload: unknown): MusicLyricLine[] | null {
  if (!isRecord(payload)) return null;
  let raw: unknown[] | null = null;
  if (Array.isArray(payload['lyrics'])) raw = payload['lyrics'];
  else if (isRecord(payload['data']) && Array.isArray(payload['data']['lyrics'])) raw = payload['data']['lyrics'] as unknown[];
  else if (Array.isArray(payload['data'])) raw = payload['data'] as unknown[];
  if (!raw || raw.length === 0) return null;

  const entries = raw.filter(isRecord);
  const type = asString(payload['type']).toLowerCase();
  const isLineType = type === 'line';

  const agentTypes: Record<string, string> = {};
  const metadata = isRecord(payload['metadata']) ? payload['metadata'] : null;
  if (metadata && isRecord(metadata['agents'])) {
    for (const [key, agent] of Object.entries(metadata['agents'])) {
      if (isRecord(agent)) agentTypes[asString(agent['alias']) || key] = asString(agent['type']);
    }
  }
  const singers = entries.map((e) => (isRecord(e['element']) ? asString(e['element']['singer']) || undefined : undefined));
  const alignments = calculateLineAlignments(singers, agentTypes);

  const lines: MusicLyricLine[] = [];
  entries.forEach((entry, i) => {
    const text = asString(entry['text']);
    const startMs = toMilliseconds(entry['time']);
    const durMs = toMilliseconds(entry['duration']);
    const explicitEnd = toMilliseconds(entry['endTime']);
    const endMs = explicitEnd || startMs + durMs;

    const rawSyl = Array.isArray(entry['syllabus']) ? entry['syllabus'] : Array.isArray(entry['words']) ? entry['words'] : [];
    const syl = (rawSyl as unknown[]).filter(isRecord);
    const main: MusicLyricSyllable[] = [];
    const bg: MusicLyricSyllable[] = [];
    if (!isLineType) {
      for (const s of syl) {
        const start = toMilliseconds(s['time'], startMs);
        const dur = toMilliseconds(s['duration']);
        const end = dur === 0 && syl.length === 1 ? endMs : start + dur;
        const piece = { start: start / 1000, end: Math.max(start, end) / 1000, text: asString(s['text']) };
        (s['isBackground'] ? bg : main).push(piece);
      }
    }
    const mainText = main.length > 0 ? main.map((s) => s.text).join('').replace(/\s+/g, ' ').trim() : text.trim();
    const singer = singers[i];
    const align = alignments[i];
    if (mainText) {
      const line: MusicLyricLine = { start: startMs / 1000, end: Math.max(endMs, startMs) / 1000, text: mainText };
      if (main.length > 0) line.syllables = main;
      if (singer) line.agent = singer;
      if (align) line.align = align;
      if (looksRightToLeft(mainText)) line.dir = 'rtl';
      const translation = isRecord(entry['translation']) ? asString(entry['translation']['text']) : '';
      if (translation) line.translation = translation;
      const translit = isRecord(entry['transliteration']) ? asString(entry['transliteration']['text']) : '';
      if (translit) line.romanized = translit;
      lines.push(line);
    }
    if (bg.length > 0) {
      const bgText = bg.map((s) => s.text).join('').replace(/\s+/g, ' ').trim().replace(/^\((.*)\)$/, '$1');
      if (bgText) {
        const bgLine: MusicLyricLine = {
          start: Math.min(...bg.map((s) => s.start)),
          end: Math.max(...bg.map((s) => s.end)),
          text: bgText,
          background: true,
          syllables: bg,
        };
        if (singer) bgLine.agent = singer;
        if (align) bgLine.align = align;
        lines.push(bgLine);
      }
    }
  });
  return lines.length > 0 ? lines : null;
}

function kpoeLabel(payload: unknown): string {
  if (isRecord(payload) && isRecord(payload['metadata'])) {
    return asString(payload['metadata']['source']) || asString(payload['metadata']['provider']) || 'LyricsPlus (KPoe)';
  }
  return 'LyricsPlus (KPoe)';
}

/** LyricsPlus: three random mirrors, then binimum forced when nothing word-synced turned up. */
export async function fetchLyricsPlus(q: MusicLyricsQuery, ctx: MusicLyricsCtx): Promise<MusicLyricsSourceResult[]> {
  if ((!q.title || !q.artist) && !q.isrc) return [];
  const params = new URLSearchParams();
  if (q.title) params.append('title', q.title);
  if (q.artist) params.append('artist', q.artist);
  if (q.isrc) params.append('isrc', q.isrc);
  if (q.album) params.append('album', q.album);
  if (q.durationSec && q.durationSec > 0) params.append('duration', secs(q.durationSec));
  params.append('source', KPOE_SOURCE_ORDER);

  const shuffled = [...KPOE_SERVERS]
    .map((s) => ({ s, k: ctx.random() }))
    .sort((a, b) => a.k - b.k)
    .map((x) => x.s)
    .slice(0, 3);

  const out: MusicLyricsSourceResult[] = [];
  const ask = async (base: string): Promise<MusicLyricsSourceResult | null> => {
    const payload = await readJson(await request(ctx, 'lyricsplus', `${base}/v2/lyrics/get?${params}`));
    const lines = convertKPoeLyrics(payload);
    return lines ? result('lyricsplus', lines, [], kpoeLabel(payload)) : null;
  };

  for (const base of shuffled) {
    const r = await ask(base);
    if (!r) continue;
    out.push(r);
    if (rankSource(r.source, r.lines) <= 1) break;
  }
  // Nothing word-synced from the random three: ask binimum explicitly for word lyrics.
  if (!out.some((r) => rankSource(r.source, r.lines) <= 2)) {
    const forced = await ask(KPOE_SERVERS[0]);
    if (forced && isWordSynced(forced.lines)) out.push(forced);
  }
  return out;
}

// ───────────────────────────── LRCLIB ─────────────────────────────

export async function fetchLrclib(q: MusicLyricsQuery, ctx: MusicLyricsCtx): Promise<MusicLyricsSourceResult | null> {
  if (!q.title || !q.artist) return null;
  const payload = await readJson(await request(ctx, 'lrclib', `https://lrclib.net/api/search?${new URLSearchParams({ q: `${q.artist} ${q.title}` })}`));
  if (!Array.isArray(payload) || payload.length === 0) return null;
  const items = payload.filter(isRecord);
  const best = items.find((r) => typeof r['syncedLyrics'] === 'string' && r['syncedLyrics']) ?? items[0];
  if (!best) return null;
  const synced = asString(best['syncedLyrics']);
  if (synced) {
    const lines = parseLRC(synced).lines;
    if (lines.length > 0) return result('lrclib', lines);
  }
  const plain = asString(best['plainLyrics']);
  if (plain) return result('lrclib', parsePlain(plain), [], 'LRCLIB (unsynced)');
  return null;
}

// ───────────────────────────── Genius (plain text, no key) ─────────────────────────────

export async function fetchGenius(q: MusicLyricsQuery, ctx: MusicLyricsCtx): Promise<MusicLyricsSourceResult | null> {
  if (!q.title || !q.artist) return null;
  const payload = await readJson(await request(ctx, 'genius', `${GENIUS_WORKER_URL}?${new URLSearchParams({ title: q.title, artist: q.artist })}`));
  const text = isRecord(payload) ? asString(payload['lyrics']) : '';
  if (!text) return null;
  const lines = parsePlain(text.split('\n').filter((l) => !l.trim().startsWith('[')).join('\n'));
  return result('genius', lines);
}

// ───────────────────────────── ranking and cascade ─────────────────────────────

/** Lower is better: lrc.red, then word-synced, then line-synced, then plain; Genius last. */
export function rankSource(label: string, lines: readonly MusicLyricLine[]): number {
  const lower = label.toLowerCase();
  if (lower === 'lrc.red') return 0;
  if (lower === 'fiesta') return -1;
  const word = isWordSynced(lines);
  const synced = isSynced(lines);
  const order = ['apple', 'bini', 'unison', 'qq|lyricsplus', 'musixmatch', 'lrclib'];
  const idx = order.findIndex((o) => o.split('|').some((k) => lower.includes(k)));
  const tier = word ? 0 : synced ? 1 : 2;
  if (lower.includes('genius')) return 21;
  return 1 + tier * 7 + (idx < 0 ? order.length : idx);
}

export function mergeAndSort(sources: readonly MusicLyricsSourceResult[]): MusicLyricsSourceResult[] {
  const seen = new Map<string, MusicLyricsSourceResult>();
  for (const s of sources) {
    const label = s.source.toLowerCase().includes('lyricsplus') ? 'QQ' : s.source;
    if (!seen.has(label)) seen.set(label, { ...s, source: label });
  }
  return [...seen.values()].sort((a, b) => rankSource(a.source, a.lines) - rankSource(b.source, b.lines));
}

export interface MusicLyricsCascadeOptions {
  /** Providers the user left on. Owner files are always checked. */
  enabled?: Partial<Record<MusicLyricsProviderId, boolean>>;
  /** 'first' stops at the first good source; 'all' asks every provider so Switch source has choices. */
  mode?: 'first' | 'all';
}

export interface MusicLyricsCascadeResult {
  sources: MusicLyricsSourceResult[];
  /** Display names of the providers that were asked. */
  tried: string[];
  /** True when no provider answered at all (offline / blocked), as opposed to "no lyrics". */
  failed: boolean;
  /** Every provider was asked, so `sources` is the full set. */
  complete: boolean;
}

const REMOTE: readonly MusicLyricsProviderId[] = ['lrcred', 'bini', 'unison', 'lyricsplus', 'lrclib', 'genius'];

function finish(ctx: MusicLyricsCtx, sources: MusicLyricsSourceResult[], complete: boolean): MusicLyricsCascadeResult {
  const remoteTried = REMOTE.filter((p) => ctx.tried.has(p));
  const failed =
    sources.length === 0 &&
    remoteTried.length > 0 &&
    !remoteTried.some((p) => ctx.responded.has(p)) &&
    remoteTried.some((p) => ctx.errored.has(p));
  const tried = (['owner', ...REMOTE] as MusicLyricsProviderId[]).filter((p) => ctx.tried.has(p)).map((p) => MUSIC_LYRICS_DISPLAY_NAMES[p]);
  return { sources, tried, failed, complete };
}

/**
 * Provider cascade (am-lyrics fetchLyrics order): owner file, lrc.red,
 * BiniLyrics, Unison, LyricsPlus, LRCLIB, Genius. A timeout, error or 404 moves
 * on to the next provider. Throws an AbortError when `ctx.signal` aborts.
 */
export async function fetchLyricsCascade(
  q: MusicLyricsQuery,
  ctx: MusicLyricsCtx,
  opts: MusicLyricsCascadeOptions = {},
): Promise<MusicLyricsCascadeResult> {
  const on = (p: MusicLyricsProviderId) => opts.enabled?.[p] !== false;
  const mode = opts.mode ?? 'first';

  if (mode === 'all') {
    const jobs: Promise<MusicLyricsSourceResult | MusicLyricsSourceResult[] | null>[] = [fetchOwnerLyrics(q, ctx)];
    if (on('lrcred')) jobs.push(fetchLrcRed(q, ctx));
    if (on('bini')) jobs.push(fetchBini(q, ctx));
    if (on('unison')) jobs.push(fetchUnison(q, ctx));
    if (on('lyricsplus')) jobs.push(fetchLyricsPlus(q, ctx));
    if (on('lrclib')) jobs.push(fetchLrclib(q, ctx));
    if (on('genius')) jobs.push(fetchGenius(q, ctx));
    const settled = await Promise.all(jobs);
    throwIfAborted(ctx);
    return finish(ctx, mergeAndSort(settled.flat().filter((r): r is MusicLyricsSourceResult => !!r)), true);
  }

  const owner = await fetchOwnerLyrics(q, ctx);
  if (owner) return finish(ctx, [owner], true);

  if (on('lrcred')) {
    const r = await fetchLrcRed(q, ctx);
    if (r) return finish(ctx, [r], false);
  }

  const collected: MusicLyricsSourceResult[] = [];
  const anyWord = () => collected.some((s) => isWordSynced(s.lines));
  const anySync = () => collected.some((s) => isSynced(s.lines));

  if (on('bini')) {
    const r = await fetchBini(q, ctx);
    if (r) collected.push(r);
  }
  if (on('unison') && (collected.length === 0 || !anyWord())) {
    const r = await fetchUnison(q, ctx);
    if (r) collected.push(r);
  }
  if (on('lyricsplus') && (collected.length === 0 || !anyWord())) {
    collected.push(...(await fetchLyricsPlus(q, ctx)));
  }
  if (on('lrclib') && (collected.length === 0 || !anySync())) {
    const r = await fetchLrclib(q, ctx);
    if (r) collected.push(r);
  }
  if (on('genius') && collected.length === 0) {
    const r = await fetchGenius(q, ctx);
    if (r) collected.push(r);
  }
  const merged = mergeAndSort(collected);
  // "Complete" only when the last-resort providers already ran (nothing else could add a source).
  const complete = merged.length === 0 || merged.some((s) => s.provider === 'lrclib' || s.provider === 'genius');
  return finish(ctx, merged, complete);
}
