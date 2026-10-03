// Title search on TMDB, for when OMDB can't answer. OMDB's free key allows
// 1,000 requests a day and our traffic spends it; search then returned
// "Request limit reached!" and the site looked dead. TMDB has no daily cap.
//
// Results carry tmdbId + mediaType and an empty imdbID, like the TMDB-backed
// home lists: the movie page resolves the IMDb id from /movie/<tmdbId>?type=tv.
// /search/multi also returns people, which are dropped here (the search box
// looks people up separately).

const TMDB_BASE = 'https://api.themoviedb.org/3';

module.exports = async function tmdbSearch(query, page) {
  const key = process.env['TMDB_API_KEY'];
  if (!key) return null;
  const url =
    TMDB_BASE + '/search/multi?api_key=' + key + '&language=en-US&include_adult=false' +
    '&query=' + encodeURIComponent(query) + '&page=' + (parseInt(page, 10) || 1);
  const r = await fetch(url);
  if (!r.ok) return null;
  const data = await r.json();
  const items = (data.results || [])
    .filter(function(x) { return x.media_type === 'movie' || x.media_type === 'tv'; })
    .map(function(x) {
      return {
        tmdbId: x.id,
        mediaType: x.media_type,
        title: x.title || x.name || '',
        year: (x.release_date || x.first_air_date || '').substring(0, 4),
        poster: x.poster_path ? 'https://image.tmdb.org/t/p/w342' + x.poster_path : null,
      };
    });
  return {
    items: items,
    // counts people too, so it is an upper bound; lastPage is what stops paging
    total: data.total_results || 0,
    lastPage: (data.page || 1) >= (data.total_pages || 1),
  };
};
