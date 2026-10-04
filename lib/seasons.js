// TMDB lists announced-but-unreleased seasons the moment they're greenlit
// (Rick and Morty's season 10: episode_count 0, air_date null), and
// `number_of_seasons` counts them. Showing that season's button leads to an
// empty episode list and a player with nothing to play, so only seasons that
// actually have episodes are offered.

// Real seasons (no specials), minus empty ones. If TMDB has no episode counts
// at all (a brand-new show), keep the lot rather than offer no seasons.
function seasonsWithEpisodes(seasons) {
  var real = (seasons || []).filter(function (s) { return s.season_number > 0; });
  var withEpisodes = real.filter(function (s) { return s.episode_count > 0; });
  return withEpisodes.length ? withEpisodes : real;
}

// Highest season that has episodes - what "N Seasons" should say.
function lastSeason(seasons, fallback) {
  var list = seasonsWithEpisodes(seasons);
  return list.length ? Math.max.apply(null, list.map(function (s) { return s.season_number; })) : fallback;
}

module.exports = { seasonsWithEpisodes, lastSeason };
