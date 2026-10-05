import {
  addToQueue, clearUpcoming, cycleRepeatMode, insertNext, moveItem, nextIndex, playOrder, prevIndex, QueueState,
  removeAt, shuffleQueue, shuffleWithPinned, unshuffleQueue,
} from './music-queue';

/** Deterministic rng (LCG) so shuffles are reproducible. */
function seeded(seed = 7): () => number {
  let x = seed;
  return () => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648);
}

const q = (items: string[], index = 0): QueueState<string> => ({ original: items, order: null, index });
const cur = (s: QueueState<string>) => playOrder(s)[s.index];

describe('music-queue', () => {
  it('shuffleWithPinned keeps the current entry first and every entry once', () => {
    const list = ['a', 'b', 'c', 'd', 'e', 'f'];
    const out = shuffleWithPinned(list, 3, seeded());
    expect(out[0]).toBe('d');
    expect([...out].sort()).toEqual(list);
    expect(shuffleWithPinned(list, -1, seeded()).length).toBe(6);
  });

  it('shuffle puts the current track first; unshuffle restores the original order', () => {
    const s = q(['a', 'b', 'c', 'd', 'e'], 2);
    const sh = shuffleQueue(s, seeded());
    expect(sh.index).toBe(0);
    expect(cur(sh)).toBe('c');
    expect([...playOrder(sh)].sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
    // Move on two tracks while shuffled, then unshuffle: same entry stays current.
    const moved = { ...sh, index: 2 };
    const playing = cur(moved);
    const un = unshuffleQueue(moved);
    expect(playOrder(un)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(cur(un)).toBe(playing);
  });

  it('handles duplicate entries in shuffle/unshuffle', () => {
    const s = q(['a', 'b', 'a', 'c'], 2);
    const un = unshuffleQueue(shuffleQueue(s, seeded(3)));
    expect(un.index).toBe(2);
  });

  it('addToQueue appends to both orders', () => {
    const sh = shuffleQueue(q(['a', 'b', 'c'], 0), seeded());
    const added = addToQueue(sh, ['x', 'y']);
    expect(playOrder(added).slice(-2)).toEqual(['x', 'y']);
    expect(unshuffleQueue(added).original).toEqual(['a', 'b', 'c', 'x', 'y']);
    expect(added.index).toBe(0);
  });

  it('insertNext without shuffle puts tracks right after the current one', () => {
    const s = insertNext(q(['a', 'b', 'c'], 1), ['x', 'y']);
    expect(playOrder(s)).toEqual(['a', 'b', 'x', 'y', 'c']);
    expect(s.index).toBe(1);
  });

  it('insertNext with shuffle plays next and stays next after unshuffle', () => {
    const sh = shuffleQueue(q(['a', 'b', 'c', 'd'], 1), seeded());
    const s = insertNext(sh, ['x']);
    expect(playOrder(s)[s.index + 1]).toBe('x');
    expect(cur(s)).toBe('b');
    const un = unshuffleQueue(s);
    expect(playOrder(un)).toEqual(['a', 'b', 'x', 'c', 'd']);
    expect(cur(un)).toBe('b');
  });

  it('removeAt shifts the index for earlier entries and flags the current one', () => {
    const r1 = removeAt(q(['a', 'b', 'c', 'd'], 2), 0);
    expect(r1.state.index).toBe(1);
    expect(cur(r1.state)).toBe('c');
    expect(r1.removedCurrent).toBeFalse();

    const r2 = removeAt(q(['a', 'b', 'c', 'd'], 2), 3);
    expect(r2.state.index).toBe(2);

    const r3 = removeAt(q(['a', 'b', 'c', 'd'], 2), 2);
    expect(r3.removedCurrent).toBeTrue();
    expect(cur(r3.state)).toBe('d');

    const r4 = removeAt(q(['a'], 0), 0);
    expect(r4.state.index).toBe(-1);
  });

  it('removeAt while shuffled removes the same entry from the original order', () => {
    const sh = shuffleQueue(q(['a', 'b', 'c', 'd', 'e'], 0), seeded());
    const victim = playOrder(sh)[3];
    const { state } = removeAt(sh, 3);
    expect(playOrder(state)).not.toContain(victim);
    expect(unshuffleQueue(state).original).toEqual(['a', 'b', 'c', 'd', 'e'].filter((x) => x !== victim));
    expect(cur(state)).toBe('a');
  });

  it('moveItem keeps the current entry current', () => {
    let s = moveItem(q(['a', 'b', 'c', 'd'], 1), 0, 3); // a moves after current
    expect(playOrder(s)).toEqual(['b', 'c', 'd', 'a']);
    expect(cur(s)).toBe('b');
    s = moveItem(q(['a', 'b', 'c', 'd'], 1), 3, 0); // d moves before current
    expect(cur(s)).toBe('b');
    expect(s.index).toBe(2);
    s = moveItem(q(['a', 'b', 'c', 'd'], 1), 1, 3); // the current one moves
    expect(s.index).toBe(3);
    expect(cur(s)).toBe('b');
  });

  it('moveItem while shuffled changes only the play order', () => {
    const sh = shuffleQueue(q(['a', 'b', 'c', 'd'], 0), seeded());
    const before = playOrder(sh);
    const s = moveItem(sh, 3, 1);
    expect(playOrder(s)[1]).toBe(before[3]);
    expect(s.original).toEqual(['a', 'b', 'c', 'd']);
  });

  it('clearUpcoming drops what comes after the current entry, shuffled or not', () => {
    expect(playOrder(clearUpcoming(q(['a', 'b', 'c'], 1)))).toEqual(['a', 'b']);
    const sh = { ...shuffleQueue(q(['a', 'b', 'c', 'd', 'e'], 0), seeded()), index: 2 };
    const kept = playOrder(sh).slice(0, 3);
    const c = clearUpcoming(sh);
    expect(playOrder(c)).toEqual(kept);
    expect(cur(c)).toBe(kept[2]);
    expect(unshuffleQueue(c).original.length).toBe(3);
  });

  it('nextIndex / prevIndex honour repeat', () => {
    expect(nextIndex(3, 0, 'off')).toBe(1);
    expect(nextIndex(3, 2, 'off')).toBe(-1);
    expect(nextIndex(3, 2, 'all')).toBe(0);
    expect(nextIndex(3, 2, 'one')).toBe(-1);
    expect(nextIndex(0, -1, 'all')).toBe(-1);
    expect(prevIndex(3, 0, 'off')).toBe(-1);
    expect(prevIndex(3, 0, 'all')).toBe(2);
    expect(prevIndex(3, 2, 'off')).toBe(1);
  });

  it('cycleRepeatMode goes off -> all -> one -> off', () => {
    expect(cycleRepeatMode('off')).toBe('all');
    expect(cycleRepeatMode('all')).toBe('one');
    expect(cycleRepeatMode('one')).toBe('off');
  });
});
