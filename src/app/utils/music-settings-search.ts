import { MusicSettingEntry } from '../services/music-settings-registry';

/**
 * Ranks registry entries for a free-text query. Every query word must match
 * the label, a keyword or the description (prefix match on words scores higher
 * than a substring). Returns at most `limit` entries, best first.
 */
export function searchSettings(registry: readonly MusicSettingEntry[], query: string, limit = 8): MusicSettingEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const scored: { e: MusicSettingEntry; score: number; i: number }[] = [];
  registry.forEach((e, i) => {
    const label = e.label.toLowerCase();
    const kws = e.keywords.map((k) => k.toLowerCase());
    const desc = (e.description ?? '').toLowerCase();
    let total = 0;
    for (const w of words) {
      let s = 0;
      if (label.split(/[\s:-]+/).some((t) => t.startsWith(w))) s = 4;
      else if (label.includes(w)) s = 3;
      else if (kws.some((k) => k === w || k.startsWith(w))) s = 2;
      else if (kws.some((k) => k.includes(w)) || desc.includes(w)) s = 1;
      if (!s) return;
      total += s;
    }
    scored.push({ e, score: total, i });
  });
  return scored.sort((a, b) => b.score - a.score || a.i - b.i).slice(0, limit).map((x) => x.e);
}
