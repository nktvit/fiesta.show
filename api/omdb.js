var tmdbSearch = require('./_tmdb-search');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Content-Type'
  );

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  var apiKey = process.env['OMDB_API_KEY'];
  if (!apiKey) {
    return res.status(500).json({ error: 'OMDB API key not configured' });
  }

  var action = req.query.action;

  try {
    if (action === 'search') {
      res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=600');

      var query = req.query.q || '';
      var page = req.query.page || '1';

      if (!query || query.length < 2) {
        return res.status(200).json({ Search: [], totalResults: '0', Response: 'False' });
      }

      var data = null;
      try {
        var response = await fetch(
          'https://www.omdbapi.com/?apikey=' + apiKey + '&s=' + encodeURIComponent(query) + '&page=' + page
        );
        data = await response.json();
      } catch (e) {
        console.error('OMDB search error:', e);
      }
      if (data && data.Response === 'True') return res.status(200).json(data);

      // OMDB out of quota (or no match): answer from TMDB in OMDB's shape.
      var tmdb = await tmdbSearch(query, page).catch(function() { return null; });
      if (tmdb && tmdb.items.length) {
        res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=600');
        return res.status(200).json({
          Response: 'True',
          totalResults: String(tmdb.total),
          _lastPage: tmdb.lastPage,
          Search: tmdb.items.map(function(x) {
            return {
              Title: x.title,
              Year: x.year,
              imdbID: '',
              tmdbId: x.tmdbId,
              mediaType: x.mediaType,
              Type: x.mediaType === 'tv' ? 'series' : 'movie',
              Poster: x.poster || 'N/A',
            };
          }),
        });
      }
      return res.status(200).json(data || { Search: [], totalResults: '0', Response: 'False' });
    }

    if (action === 'episodes') {
      res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=3600');

      var id = req.query.id || '';
      var season = req.query.season || '1';

      if (!id) {
        return res.status(400).json({ error: 'Missing id parameter' });
      }

      var response = await fetch(
        'https://www.omdbapi.com/?apikey=' + apiKey + '&i=' + encodeURIComponent(id) + '&Season=' + season
      );
      var data = await response.json();
      return res.status(200).json(data);
    }

    return res.status(400).json({ error: 'Invalid action. Use "search" or "episodes".' });
  } catch (error) {
    console.error('OMDB proxy error:', error);
    return res.status(500).json({ error: 'Failed to fetch from OMDB', details: error.message });
  }
};
