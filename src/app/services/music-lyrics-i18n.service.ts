// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
// Derived from @uimaxbai/am-lyrics src/GoogleService.ts - adapted for Fiesta.
import { Injectable } from '@angular/core';

const GOOGLE = 'https://translate.googleapis.com/translate_a/single';
const TIMEOUT_MS = 6000;
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 400;
/** Google's GET limit is about 2000 characters of query. */
const BATCH_CHARS = 1500;
const PARALLEL = 4;
const KUROMOJI_DICT = 'https://cdn.jsdelivr.net/npm/kuromoji@0.1.2/dict/';

const LATIN = /^[\u0000-ɏḀ-ỿ -⁯₠-⃏]*$/;
const KANA = /[぀-ゟ゠-ヿ]/;

/** The slice of kuroshiro we use (the package ships no typings). */
interface KuroshiroLike {
  init(analyzer: unknown): Promise<void>;
  convert(text: string, opts: { to: string; mode: string; romajiSystem: string }): Promise<string>;
}

export function isPurelyLatin(text: string): boolean {
  return LATIN.test(text);
}

export function hasKana(text: string): boolean {
  return KANA.test(text);
}

/**
 * Google Translate (keyless gtx endpoint) for lyric translation and
 * romanization, plus lazy Kuroshiro Romaji for Japanese. Lines are batched,
 * every request times out at 6 s, results are cached in memory. Methods throw
 * when the network fails so the caller can toast and leave the lyrics alone.
 */
@Injectable({ providedIn: 'root' })
export class MusicLyricsI18nService {
  /** Replaced in tests. */
  protected fetchFn: typeof fetch = (...a) => fetch(...a);
  private readonly translations = new Map<string, string>();
  private readonly romanizations = new Map<string, string>();
  private kuroshiro: Promise<KuroshiroLike> | null = null;

  /** Translates every line (same order, same length). Blank lines stay blank. */
  async translate(texts: readonly string[], lang: string, signal?: AbortSignal): Promise<string[]> {
    const todo = [...new Set(texts.filter((t) => t.trim() && !this.translations.has(`${lang}\n${t}`)))];
    for (const batch of this.batches(todo)) {
      let out: string[] | null = null;
      try {
        out = this.splitLines(await this.gtx(`client=gtx&sl=auto&tl=${encodeURIComponent(lang)}&dt=t`, batch.join('\n'), signal, (d) => this.joinTranslation(d)), batch.length);
      } catch (e) {
        if (signal?.aborted) throw e;
        throw e instanceof Error ? e : new Error('translate failed');
      }
      if (out) batch.forEach((t, i) => this.translations.set(`${lang}\n${t}`, out[i]));
      else {
        // Line count drifted: ask line by line.
        await this.parallel(batch, signal, async (t) => {
          const one = await this.gtx(`client=gtx&sl=auto&tl=${encodeURIComponent(lang)}&dt=t`, t, signal, (d) => this.joinTranslation(d));
          this.translations.set(`${lang}\n${t}`, one.trim() || t);
        });
      }
    }
    return texts.map((t) => (t.trim() ? (this.translations.get(`${lang}\n${t}`) ?? t) : t));
  }

  /** Romanizes lines. Japanese (kana) goes through Kuroshiro Romaji, other non-Latin scripts through Google. */
  async romanize(texts: readonly string[], signal?: AbortSignal): Promise<string[]> {
    const result = [...texts];
    const jp = texts.map((t, i) => (hasKana(t) ? i : -1)).filter((i) => i >= 0);
    const other = texts.map((t, i) => (t.trim() && !isPurelyLatin(t) && !hasKana(t) ? i : -1)).filter((i) => i >= 0);

    if (jp.length > 0) {
      try {
        const romaji = await this.romaji(jp.map((i) => texts[i]), signal);
        jp.forEach((i, k) => (result[i] = romaji[k]));
      } catch (e) {
        if (signal?.aborted) throw e;
        other.push(...jp); // dictionary unreachable: Google can still do kana
      }
    }
    const googleIdx = [...new Set(other)];
    if (googleIdx.length > 0) {
      const out = await this.googleRomanize(googleIdx.map((i) => texts[i]), signal);
      googleIdx.forEach((i, k) => (result[i] = out[k]));
    }
    return result;
  }

  /** Hepburn Romaji with Kuroshiro (the analyzer and dictionary load on first use). */
  async romaji(texts: readonly string[], signal?: AbortSignal): Promise<string[]> {
    const k = await this.loadKuroshiro();
    const out: string[] = [];
    for (const t of texts) {
      if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
      out.push(t.trim() ? await k.convert(t, { to: 'romaji', mode: 'spaced', romajiSystem: 'hepburn' }) : t);
    }
    return out;
  }

  private async googleRomanize(texts: string[], signal?: AbortSignal): Promise<string[]> {
    const result = [...texts];
    const todo = [...new Set(texts.filter((t) => !this.romanizations.has(t)))];
    for (const batch of this.batches(todo)) {
      let parts: string[] = [];
      try {
        parts = await this.gtx('client=gtx&sl=auto&tl=en&dt=rm', batch.join('\n'), signal, (d) => this.romanizationParts(d));
      } catch (e) {
        if (signal?.aborted) throw e;
        throw e instanceof Error ? e : new Error('romanize failed');
      }
      if (parts.length === batch.length) batch.forEach((t, i) => this.romanizations.set(t, parts[i]));
      else {
        await this.parallel(batch, signal, async (t) => {
          const one = await this.gtx('client=gtx&sl=auto&tl=en&dt=rm', t, signal, (d) => this.romanizationParts(d));
          this.romanizations.set(t, one.join(' ').trim() || t);
        });
      }
    }
    return result.map((t) => this.romanizations.get(t) ?? t);
  }

  /** Response: [[[translated, original, null, romanization], ...], ...]. */
  private joinTranslation(data: unknown): string {
    const segs = Array.isArray(data) && Array.isArray(data[0]) ? (data[0] as unknown[]) : [];
    return segs.map((s) => (Array.isArray(s) && typeof s[0] === 'string' ? s[0] : '')).join('');
  }

  private romanizationParts(data: unknown): string[] {
    const segs = Array.isArray(data) && Array.isArray(data[0]) ? (data[0] as unknown[]) : [];
    const out: string[] = [];
    for (const s of segs) if (Array.isArray(s) && typeof s[3] === 'string' && s[3]) out.push(s[3].trim());
    return out;
  }

  private splitLines(text: string, expected: number): string[] | null {
    const lines = text.split('\n');
    return lines.length === expected ? lines : null;
  }

  private batches(texts: string[]): string[][] {
    const out: string[][] = [];
    let cur: string[] = [];
    let len = 0;
    for (const t of texts) {
      if (cur.length > 0 && len + t.length > BATCH_CHARS) {
        out.push(cur);
        cur = [];
        len = 0;
      }
      cur.push(t);
      len += t.length + 1;
    }
    if (cur.length > 0) out.push(cur);
    return out;
  }

  private async parallel<T>(items: T[], signal: AbortSignal | undefined, fn: (item: T) => Promise<void>): Promise<void> {
    let next = 0;
    const worker = async () => {
      while (next < items.length) {
        if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
        await fn(items[next++]);
      }
    };
    await Promise.all(Array.from({ length: Math.min(PARALLEL, items.length) }, worker));
  }

  /** One gtx call with a 6 s timeout and a couple of retries. */
  private async gtx<T>(query: string, text: string, signal: AbortSignal | undefined, read: (data: unknown) => T): Promise<T> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      const onAbort = () => controller.abort();
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        const res = await this.fetchFn(`${GOOGLE}?${query}&q=${encodeURIComponent(text)}`, { signal: controller.signal });
        if (!res.ok) throw new Error(`Google Translate answered ${res.status}`);
        return read(await res.json());
      } catch (e) {
        if (signal?.aborted) throw e;
        lastError = e;
        if (attempt + 1 < MAX_RETRIES) await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * 2 ** attempt));
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      }
    }
    throw lastError instanceof Error ? lastError : new Error('Google Translate is unreachable');
  }

  private loadKuroshiro(): Promise<KuroshiroLike> {
    this.kuroshiro ??= this.initKuroshiro().catch((e) => {
      this.kuroshiro = null; // allow a retry later
      throw e;
    });
    return this.kuroshiro;
  }

  private async initKuroshiro(): Promise<KuroshiroLike> {
    // Heavy and rarely needed: separate lazy chunks. The prebuilt dist files are used because the
    // package roots require node's `path`, which the Angular webpack build cannot resolve.
    const [kuroMod, analyzerMod] = await Promise.all([
      import('kuroshiro/dist/kuroshiro.min.js'),
      import('kuroshiro-analyzer-kuromoji/dist/kuroshiro-analyzer-kuromoji.min.js'),
    ]);
    const pick = (m: unknown): new (...a: never[]) => unknown => {
      let cur = m as { default?: unknown };
      for (let i = 0; i < 3 && cur && typeof cur !== 'function'; i++) cur = cur.default as { default?: unknown };
      return cur as unknown as new (...a: never[]) => unknown;
    };
    const Kuroshiro = pick(kuroMod) as unknown as new () => KuroshiroLike;
    const Analyzer = pick(analyzerMod) as unknown as new (o: { dictPath: string }) => unknown;

    // kuromoji 0.1.2 joins the dictionary URL with path.join, which turns "https://" into "https:/".
    // Repair it for the duration of the load only (the old workaround patched XHR for good).
    const proto = XMLHttpRequest.prototype;
    const original = proto.open;
    proto.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
      const fixed = String(url).replace(/^(https?:)\/(?!\/)/, '$1//');
      return (original as (...a: unknown[]) => void).call(this, method, fixed, ...rest);
    } as typeof proto.open;
    try {
      const k = new Kuroshiro();
      await k.init(new Analyzer({ dictPath: KUROMOJI_DICT }));
      return k;
    } finally {
      proto.open = original;
    }
  }
}
