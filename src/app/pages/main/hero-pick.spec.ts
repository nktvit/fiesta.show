import { IMovie } from '../../interfaces/movie.interface';
import { pickHero } from './hero-pick';

const m = (id: number, Backdrop = 'b' + id) => ({ tmdbId: id, Backdrop } as unknown as IMovie);
const DAY = 86_400_000;

describe('pickHero', () => {
  const list = [m(1), m(2, ''), m(3), m(4), m(5), m(6), m(7)];

  it('is stable within a UTC day', () => {
    const d = 20000 * DAY;
    expect(pickHero(list, d + 1)).toBe(pickHero(list, d + DAY - 1));
  });

  it('rotates through the first 5 titles that have a backdrop, one per day', () => {
    const ids = [0, 1, 2, 3, 4, 5].map(i => pickHero(list, (20000 + i) * DAY)!.tmdbId as number);
    const eligible = [1, 3, 4, 5, 6];
    expect(new Set(ids.slice(0, 5)).size).toBe(5);
    ids.forEach(id => expect(eligible).toContain(id));
    expect(ids[5]).toBe(ids[0]);
  });

  it('falls back to the first movie when none has a backdrop, and null when empty', () => {
    expect(pickHero([m(1, ''), m(2, '')])!.tmdbId).toBe(1 as number);
    expect(pickHero([])).toBeNull();
  });
});
