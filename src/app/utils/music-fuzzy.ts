/**
 * Small fuzzy scorer for the command palette (replaces Monochrome's fuse.js).
 * Pure. A score of 0 means "no match"; higher is better.
 *
 * Per query token: exact (1000) > prefix (800) > word-start substring (600)
 * > substring (450) > in-order subsequence (up to ~300). Every token has to
 * match something; the score is the average over tokens.
 */

/** Lower-case, accent-free, trimmed. */
export function fuzzyNormalize(s: string): string {
  return (s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

function isBoundary(text: string, i: number): boolean {
  return i === 0 || /[^a-z0-9]/.test(text[i - 1]);
}

function tokenScore(q: string, t: string): number {
  if (!q || !t) return 0;
  if (t === q) return 1000;
  if (t.startsWith(q)) return 800 - Math.min(100, t.length - q.length);
  const idx = t.indexOf(q);
  if (idx >= 0) {
    // Prefer a hit at the start of a later word over one in the middle of a word.
    for (let at = idx; at >= 0; at = t.indexOf(q, at + 1)) {
      if (isBoundary(t, at)) return 600 - Math.min(100, at);
    }
    return 450 - Math.min(100, idx);
  }
  // In-order subsequence ("tgl shf" style): reward runs and word starts, reject sparse spreads.
  let qi = 0;
  let first = -1;
  let last = -2;
  let run = 0;
  let score = 100;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] !== q[qi]) continue;
    if (first < 0) first = ti;
    if (ti === last + 1) {
      run++;
      score += 12 * run;
    } else {
      run = 0;
    }
    if (isBoundary(t, ti)) score += 14;
    last = ti;
    qi++;
  }
  if (qi < q.length) return 0;
  if (last - first + 1 > q.length * 4 + 8) return 0;
  return Math.min(300, score) - Math.min(40, first);
}

/**
 * Score of `query` against one or more texts (the first is the main label,
 * later ones such as keywords count 60 %). 0 when any token matches nothing.
 */
export function fuzzyScore(query: string, ...texts: string[]): number {
  const tokens = fuzzyNormalize(query).split(/\s+/).filter(Boolean);
  if (!tokens.length) return 1;
  const hay = texts.map(fuzzyNormalize);
  let total = 0;
  for (const tok of tokens) {
    let best = 0;
    hay.forEach((t, i) => {
      const s = tokenScore(tok, t) * (i === 0 ? 1 : 0.6);
      if (s > best) best = s;
    });
    if (best <= 0) return 0;
    total += best;
  }
  return total / tokens.length;
}

/**
 * Items that match `query`, best first (ties keep their original order).
 * An empty query returns everything in the given order.
 */
export function fuzzyRank<T>(items: readonly T[], query: string, texts: (item: T) => string[]): { item: T; score: number }[] {
  if (!fuzzyNormalize(query)) return items.map((item) => ({ item, score: 0 }));
  const out: { item: T; score: number; i: number }[] = [];
  items.forEach((item, i) => {
    const [main = '', ...rest] = texts(item);
    const score = fuzzyScore(query, main, ...rest);
    if (score > 0) out.push({ item, score, i });
  });
  out.sort((a, b) => b.score - a.score || a.i - b.i);
  return out.map(({ item, score }) => ({ item, score }));
}
