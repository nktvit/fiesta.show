// Run: node --test tools/fiesta-proxy/seasons.test.mjs
// lib/seasons.js is what api/tmdb.js uses for the season list. The browser used to
// carry a hand-kept copy of this logic (with its own spec) in the dev-only TMDB
// branches; those are gone, so the rules are pinned here instead.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { seasonsWithEpisodes, lastSeason } = createRequire(import.meta.url)('../../lib/seasons.js');

test('skips announced seasons that have no episodes yet (Rick and Morty season 10)', () => {
  const seasons = [
    { season_number: 0, name: 'Specials', episode_count: 5 },
    { season_number: 8, name: 'Season 8', episode_count: 10 },
    { season_number: 9, name: 'Season 9', episode_count: 10 },
    { season_number: 10, name: 'Season 10', episode_count: 0 },
  ];
  assert.deepEqual(seasonsWithEpisodes(seasons).map(s => s.season_number), [8, 9]);
  assert.equal(lastSeason(seasons, 10), 9);
});

test('keeps every season when TMDB has no episode counts at all (brand-new show)', () => {
  const seasons = [{ season_number: 1, name: 'Season 1', episode_count: 0 }];
  assert.deepEqual(seasonsWithEpisodes(seasons).map(s => s.season_number), [1]);
  assert.equal(lastSeason(seasons, 1), 1);
});

test('falls back to number_of_seasons when there are no seasons', () => {
  assert.equal(lastSeason(undefined, 3), 3);
});
