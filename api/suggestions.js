var tmdbSearch = require('./_tmdb-search');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
  );

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=600');

  try {
    var query = req.query.q || '';
    var apiKey = process.env['OMDB_API_KEY'];

    if (!query || query.length < 2) {
      return res.status(200).json({ suggestions: [], message: 'Query too short' });
    }

    var page = parseInt(req.query.page) || 1;

    var data = null;
    if (apiKey) {
      try {
        var response = await fetch(
          'https://www.omdbapi.com/?apikey=' + apiKey + '&s=' + encodeURIComponent(query) + '&page=' + page
        );
        data = await response.json();
      } catch (e) {
        console.error('OMDB suggestions error:', e);
      }
    }

    if (!data || data.Response !== 'True') {
      // OMDB out of quota (or no match): TMDB. Ids are TMDB ids, so each
      // suggestion says its type for the movie page (?type=tv).
      var tmdb = await tmdbSearch(query, page).catch(function() { return null; });
      if (tmdb && tmdb.items.length) {
        res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=600');
        return res.status(200).json({
          suggestions: tmdb.items.map(function(x) {
            return { id: String(x.tmdbId), title: x.title, year: x.year, type: x.mediaType === 'tv' ? 'series' : 'movie', poster: x.poster, source: 'tmdb' };
          }),
          // 0 on the last page stops the dropdown asking for more
          totalResults: tmdb.lastPage ? 0 : tmdb.total,
        });
      }
      return res.status(200).json({ suggestions: [], totalResults: 0, message: (data && data.Error) || 'No results found' });
    }

    var suggestions = data.Search.map(function(item) {
      return {
        id: item.imdbID,
        title: item.Title,
        year: item.Year,
        type: item.Type,
        poster: item.Poster !== 'N/A' ? item.Poster : null
      };
    });

    return res.status(200).json({ suggestions: suggestions, totalResults: parseInt(data.totalResults) || 0 });
  } catch (error) {
    console.error('Error in suggestions API:', error);
    return res.status(500).json({ error: 'Failed to fetch suggestions', errorDetails: error.message, suggestions: [] });
  }
};
