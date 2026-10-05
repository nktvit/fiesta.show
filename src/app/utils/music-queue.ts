// Ported from Monochrome (Apache-2.0), js/player.js - adapted for Fiesta.
// Pure queue math: shuffle with the current track pinned first (toggleShuffle),
// add / play next / remove / move keeping the original and shuffled orders
// consistent (addToQueue..moveInQueue), and the next/previous index rules
// (playNext, getNextTrack).
//
// Upstream kept two parallel track arrays and tagged tracks with a mutable
// `_originalIndex`, which broke on duplicate tracks and drifted on "play next"
// while shuffled. Here the shuffled order is a permutation of indexes into the
// original list, so both orders always describe the same set of entries.

export type MusicRepeat = 'off' | 'all' | 'one';

export interface QueueState<T> {
  /** Entries in the order they were queued (what un-shuffling restores). */
  original: T[];
  /** While shuffled: play position -> index into `original`. null = original order. */
  order: number[] | null;
  /** Current play position in the play order; -1 when nothing is current. */
  index: number;
}

export function emptyQueue<T>(): QueueState<T> {
  return { original: [], order: null, index: -1 };
}

/** The entries in play order. */
export function playOrder<T>(s: QueueState<T>): T[] {
  return s.order ? s.order.map((i) => s.original[i]) : s.original.slice();
}

/** Fisher-Yates; the entry at `currentIdx` (if any) is pinned first. Returns a new array. */
export function shuffleWithPinned<T>(list: readonly T[], currentIdx: number, rng: () => number = Math.random): T[] {
  const rest = list.filter((_, i) => i !== currentIdx);
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  return currentIdx >= 0 && currentIdx < list.length ? [list[currentIdx], ...rest] : rest;
}

/** Shuffles: the current entry becomes position 0, the rest random. */
export function shuffleQueue<T>(s: QueueState<T>, rng: () => number = Math.random): QueueState<T> {
  const base = s.order ?? s.original.map((_, i) => i);
  const order = shuffleWithPinned(base, s.index, rng);
  return { original: s.original, order, index: s.index >= 0 && s.index < base.length ? 0 : -1 };
}

/** Back to the original order, still pointing at the same entry. */
export function unshuffleQueue<T>(s: QueueState<T>): QueueState<T> {
  if (!s.order) return s;
  const index = s.index >= 0 && s.index < s.order.length ? s.order[s.index] : -1;
  return { original: s.original, order: null, index };
}

/** Appends to the end (of both orders). */
export function addToQueue<T>(s: QueueState<T>, items: readonly T[]): QueueState<T> {
  if (!items.length) return s;
  const start = s.original.length;
  const original = [...s.original, ...items];
  const order = s.order ? [...s.order, ...items.map((_, k) => start + k)] : null;
  return { original, order, index: s.index };
}

/**
 * Inserts right after the current entry. While shuffled the entries also go
 * right after the current one in the original order, so un-shuffling keeps
 * them next.
 */
export function insertNext<T>(s: QueueState<T>, items: readonly T[]): QueueState<T> {
  if (!items.length) return s;
  const n = items.length;
  if (!s.order) {
    const at = s.index + 1;
    const original = [...s.original.slice(0, at), ...items, ...s.original.slice(at)];
    return { original, order: null, index: s.index };
  }
  const curOrig = s.index >= 0 ? s.order[s.index] : s.original.length - 1;
  const at = curOrig + 1;
  const original = [...s.original.slice(0, at), ...items, ...s.original.slice(at)];
  const shifted = s.order.map((i) => (i >= at ? i + n : i));
  const added = items.map((_, k) => at + k);
  const pos = s.index + 1;
  const order = [...shifted.slice(0, pos), ...added, ...shifted.slice(pos)];
  return { original, order, index: s.index };
}

/**
 * Removes the entry at play position `i`. If it was the current one, `index`
 * now points at the entry that followed it (or past the end:
 * `index === length`), and `removedCurrent` is true.
 */
export function removeAt<T>(s: QueueState<T>, i: number): { state: QueueState<T>; removedCurrent: boolean } {
  const len = s.original.length;
  if (i < 0 || i >= len) return { state: s, removedCurrent: false };
  const orig = s.order ? s.order[i] : i;
  const original = s.original.filter((_, k) => k !== orig);
  const order = s.order ? s.order.filter((_, k) => k !== i).map((k) => (k > orig ? k - 1 : k)) : null;
  const removedCurrent = i === s.index;
  const index = i < s.index ? s.index - 1 : s.index;
  return { state: { original, order, index: original.length ? index : -1 }, removedCurrent };
}

/** Moves the entry at play position `from` to `to`; the current entry stays current. */
export function moveItem<T>(s: QueueState<T>, from: number, to: number): QueueState<T> {
  const len = s.original.length;
  if (from < 0 || from >= len || to < 0 || to >= len || from === to) return s;
  const move = <U>(a: U[]): U[] => {
    const out = a.slice();
    const [x] = out.splice(from, 1);
    out.splice(to, 0, x);
    return out;
  };
  let index = s.index;
  if (s.index === from) index = to;
  else if (from < s.index && to >= s.index) index--;
  else if (from > s.index && to <= s.index) index++;
  // Shuffled: reorder the play order only (the original order is what the user queued).
  if (s.order) return { original: s.original, order: move(s.order), index };
  return { original: move(s.original), order: null, index };
}

/** Drops everything after the current entry (in play order). */
export function clearUpcoming<T>(s: QueueState<T>): QueueState<T> {
  const len = s.original.length;
  if (s.index < 0) return emptyQueue<T>();
  if (s.index >= len - 1) return s;
  if (!s.order) return { original: s.original.slice(0, s.index + 1), order: null, index: s.index };
  const keep = s.order.slice(0, s.index + 1);
  const sorted = [...keep].sort((a, b) => a - b);
  const remap = new Map(sorted.map((o, k) => [o, k]));
  return {
    original: sorted.map((o) => s.original[o]),
    order: keep.map((o) => remap.get(o) as number),
    index: s.index,
  };
}

/**
 * Where playback goes after `index` ends (or Next is pressed): the following
 * entry; past the end, wraps to 0 under repeat 'all'; else -1.
 * Repeat 'one' is the caller's business on `ended` (replay); Next moves on.
 */
export function nextIndex(length: number, index: number, repeat: MusicRepeat): number {
  if (length <= 0) return -1;
  if (index + 1 < length) return index + 1;
  return repeat === 'all' ? 0 : -1;
}

/** The entry before `index`; wraps to the last under repeat 'all'; else -1. */
export function prevIndex(length: number, index: number, repeat: MusicRepeat): number {
  if (length <= 0) return -1;
  if (index - 1 >= 0) return index - 1;
  return repeat === 'all' ? length - 1 : -1;
}

/** The repeat mode after `mode`: off -> all -> one -> off. */
export function cycleRepeatMode(mode: MusicRepeat): MusicRepeat {
  return mode === 'off' ? 'all' : mode === 'all' ? 'one' : 'off';
}
