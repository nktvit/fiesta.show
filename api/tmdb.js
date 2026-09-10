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

  var cacheValues = {
    trending: 's-maxage=3600, stale-while-revalidate=600',
    popular: 's-maxage=3600, stale-while-revalidate=600',
    now_playing: 's-maxage=7200, stale-while-revalidate=600',
    top_rated: 's-maxage=86400, stale-while-revalidate=3600',
    trending_tv: 's-maxage=3600, stale-while-revalidate=600',
    popular_tv: 's-maxage=3600, stale-while-revalidate=600',
    movie: 's-maxage=604800, stale-while-revalidate=86400',
    recommendations: 's-maxage=86400, stale-while-revalidate=3600',
    genres: 's-maxage=86400, stale-while-revalidate=3600',
    discover: 's-maxage=3600, stale-while-revalidate=600',
    upcoming: 's-maxage=7200, stale-while-revalidate=600',
    tv_details: 's-maxage=86400, stale-while-revalidate=3600',
    tv_episodes: 's-maxage=86400, stale-while-revalidate=3600',
    find: 's-maxage=604800, stale-while-revalidate=86400',
    videos: 's-maxage=86400, stale-while-revalidate=3600',
    credits: 's-maxage=604800, stale-while-revalidate=86400',
    person: 's-maxage=604800, stale-while-revalidate=86400',
    search_person: 's-maxage=3600, stale-while-revalidate=600',
  };

  var listParam = req.query.list;
  if (listParam && cacheValues[listParam]) {
    res.setHeader('Cache-Control', cacheValues[listParam]);
  }

  const apiKey = process.env['TMDB_API_KEY'];
  if (!apiKey) {
    return res.status(500).json({ error: 'TMDB API key not configured' });
  }

  const TMDB_BASE = 'https://api.themoviedb.org/3';

  const LIST_ENDPOINTS = {
    trending: '/trending/movie/week',
    now_playing: '/movie/now_playing',
    popular: '/movie/popular',
    top_rated: '/movie/top_rated',
    trending_tv: '/trending/tv/week',
    popular_tv: '/tv/popular',
    upcoming: '/movie/upcoming',
  };

  function mapMovie(item, mediaType) {
    return {
      imdbID: '',
      tmdbId: item.id,
      mediaType: mediaType || (item.first_air_date || (item.name && !item.title) ? 'tv' : 'movie'),
      Title: item.title || item.name || '',
      Poster: item.poster_path
        ? 'https://image.tmdb.org/t/p/w342' + item.poster_path
        : '',
      Plot: item.overview || '',
      Backdrop: item.backdrop_path
        ? 'https://image.tmdb.org/t/p/w1280' + item.backdrop_path
        : '',
      Rating: item.vote_average || 0,
      Year: (item.release_date || item.first_air_date || '').substring(0, 4),
    };
  }

  var list = req.query.list;
  var id = req.query.id;

  try {
    if (list === 'movie' && id) {
      if (req.query.type === 'tv') {
        var tvResponse = await fetch(TMDB_BASE + '/tv/' + id + '/external_ids?api_key=' + apiKey);
        var tvData = await tvResponse.json();
        if (tvData.imdb_id) {
          return res.status(200).json({ imdbID: tvData.imdb_id });
        }

        var movieFallbackResponse = await fetch(TMDB_BASE + '/movie/' + id + '?api_key=' + apiKey);
        var movieFallbackData = await movieFallbackResponse.json();
        return res.status(200).json({ imdbID: movieFallbackData.imdb_id || '' });
      }

      // Try as movie first
      var response = await fetch(TMDB_BASE + '/movie/' + id + '?api_key=' + apiKey);
      var data = await response.json();
      if (data.imdb_id) {
        return res.status(200).json({ imdbID: data.imdb_id });
      }
      // Fall back to TV show
      var tvResponse = await fetch(TMDB_BASE + '/tv/' + id + '/external_ids?api_key=' + apiKey);
      var tvData = await tvResponse.json();
      return res.status(200).json({ imdbID: tvData.imdb_id || '' });
    }

    if (list === 'tv_details' && id) {
      var response = await fetch(TMDB_BASE + '/tv/' + id + '?api_key=' + apiKey + '&language=en-US');
      var data = await response.json();
      var seasons = (data.seasons || [])
        .filter(function(s) { return s.season_number > 0; })
        .map(function(s) { return { number: s.season_number, name: s.name, episodeCount: s.episode_count }; });
      return res.status(200).json({ totalSeasons: data.number_of_seasons || 0, seasons: seasons });
    }

    if (list === 'tv_episodes' && id) {
      var season = req.query.season || '1';
      var response = await fetch(TMDB_BASE + '/tv/' + id + '/season/' + season + '?api_key=' + apiKey + '&language=en-US');
      var data = await response.json();
      var episodes = (data.episodes || []).map(function(ep) {
        return {
          number: ep.episode_number,
          title: ep.name || ('Episode ' + ep.episode_number),
          rating: ep.vote_average ? ep.vote_average.toFixed(1) : null,
          airDate: ep.air_date || null,
          still: ep.still_path ? 'https://image.tmdb.org/t/p/w300' + ep.still_path : null,
        };
      });
      return res.status(200).json({ episodes: episodes });
    }

    if (list === 'videos' && id) {
      var mediaType = req.query.type === 'tv' ? 'tv' : 'movie';
      var response = await fetch(TMDB_BASE + '/' + mediaType + '/' + id + '/videos?api_key=' + apiKey + '&language=en-US');
      var data = await response.json();
      var trailer = (data.results || []).find(function(v) { return v.type === 'Trailer' && v.site === 'YouTube'; });
      return res.status(200).json({ trailerKey: trailer ? trailer.key : null });
    }

    if (list === 'find' && id) {
      var response = await fetch(TMDB_BASE + '/find/' + id + '?api_key=' + apiKey + '&external_source=imdb_id');
      var data = await response.json();
      var movie = (data.movie_results || [])[0];
      var tv = (data.tv_results || [])[0];
      var match = movie || tv;
      if (!match) return res.status(200).json({ tmdbId: null });
      return res.status(200).json({
        tmdbId: match.id,
        poster: match.poster_path || null,
        backdrop: match.backdrop_path || null,
        overview: match.overview || null,
        rating: match.vote_average || null,
        releaseDate: match.release_date || match.first_air_date || null,
      });
    }

    if (list === 'recommendations' && id) {
      var mediaType = req.query.type === 'tv' ? 'tv' : 'movie';
      var response = await fetch(TMDB_BASE + '/' + mediaType + '/' + id + '/recommendations?api_key=' + apiKey + '&language=en-US&page=1');
      var data = await response.json();
      if (!data.results) {
        return res.status(200).json({ movies: [] });
      }
      var movies = data.results
        .filter(function(item) { return item.vote_count > 50; })
        .map(function(item) { return mapMovie(item, mediaType); });
      return res.status(200).json({ movies: movies });
    }

    if (list === 'credits' && id) {
      var mediaType = req.query.type === 'tv' ? 'tv' : 'movie';
      var response = await fetch(TMDB_BASE + '/' + mediaType + '/' + id + '/credits?api_key=' + apiKey + '&language=en-US');
      var data = await response.json();
      var mapPerson = function(p) {
        return {
          id: p.id,
          name: p.name,
          profilePath: p.profile_path ? 'https://image.tmdb.org/t/p/w185' + p.profile_path : null,
        };
      };
      var cast = (data.cast || []).slice(0, 12).map(function(p) {
        var mapped = mapPerson(p);
        mapped.character = p.character || '';
        return mapped;
      });
      var directors = (data.crew || [])
        .filter(function(p) { return p.job === 'Director'; })
        .map(mapPerson);
      return res.status(200).json({ cast: cast, directors: directors });
    }

    if (list === 'person' && id) {
      var personResponse = await fetch(TMDB_BASE + '/person/' + id + '?api_key=' + apiKey + '&language=en-US');
      var personData = await personResponse.json();
      if (!personData || !personData.id) {
        return res.status(404).json({ error: 'Person not found' });
      }

      var creditsResponse = await fetch(TMDB_BASE + '/person/' + id + '/combined_credits?api_key=' + apiKey + '&language=en-US');
      var creditsData = await creditsResponse.json();

      // Acting and crew work are listed separately: merging them made a
      // director's page show films they directed next to films they only
      // appeared in, with no way to tell which was which.
      function dedupeCredits(entries) {
        var seen = {};
        return (entries || [])
          .filter(function(c) {
            if (!c.poster_path) return false;
            var key = c.media_type + '_' + c.id;
            if (seen[key]) return false;
            seen[key] = true;
            return true;
          })
          .sort(function(a, b) {
            var da = a.release_date || a.first_air_date || '';
            var db = b.release_date || b.first_air_date || '';
            return db.localeCompare(da);
          })
          .map(function(c) { return mapMovie(c, c.media_type); });
      }

      var actingCredits = dedupeCredits(creditsData.cast);
      var crewCredits = dedupeCredits(creditsData.crew);
      var seenAll = {};
      var credits = actingCredits.concat(crewCredits).filter(function(c) {
        var key = c.mediaType + '_' + c.tmdbId;
        if (seenAll[key]) return false;
        seenAll[key] = true;
        return true;
      });

      return res.status(200).json({
        id: personData.id,
        name: personData.name || '',
        biography: personData.biography || '',
        profilePath: personData.profile_path ? 'https://image.tmdb.org/t/p/w342' + personData.profile_path : null,
        birthday: personData.birthday || null,
        deathday: personData.deathday || null,
        placeOfBirth: personData.place_of_birth || null,
        knownForDepartment: personData.known_for_department || null,
        credits: credits,
        actingCredits: actingCredits,
        crewCredits: crewCredits,
      });
    }

    if (list === 'search_person') {
      var query = req.query.query || '';
      if (!query) return res.status(200).json({ people: [] });
      var response = await fetch(TMDB_BASE + '/search/person?api_key=' + apiKey + '&language=en-US&query=' + encodeURIComponent(query) + '&page=1');
      var data = await response.json();
      var people = (data.results || [])
        .filter(function(p) { return p.known_for_department === 'Acting' || p.known_for_department === 'Directing'; })
        .sort(function(a, b) { return (b.popularity || 0) - (a.popularity || 0); })
        .slice(0, 8)
        .map(function(p) {
          return {
            id: p.id,
            name: p.name,
            profilePath: p.profile_path ? 'https://image.tmdb.org/t/p/w185' + p.profile_path : null,
            knownForDepartment: p.known_for_department || null,
          };
        });
      return res.status(200).json({ people: people });
    }

    if (list === 'genres') {
      var response = await fetch(TMDB_BASE + '/genre/movie/list?api_key=' + apiKey + '&language=en-US');
      var data = await response.json();
      return res.status(200).json({ genres: data.genres || [] });
    }

    if (list === 'discover') {
      var genre = req.query.genre || '';
      var page = req.query.page || '1';
      var response = await fetch(TMDB_BASE + '/discover/movie?api_key=' + apiKey + '&with_genres=' + genre + '&sort_by=popularity.desc&vote_count.gte=100&page=' + page + '&language=en-US');
      var data = await response.json();
      if (!data.results) {
        return res.status(200).json({ movies: [], totalPages: 0 });
      }
      var movies = data.results
        .filter(function(item) { return item.original_language !== 'ru'; })
        .map(function(item) { return mapMovie(item, 'movie'); });
      return res.status(200).json({ movies: movies, totalPages: data.total_pages || 0 });
    }

    var endpoint = list ? LIST_ENDPOINTS[list] : null;
    if (!endpoint) {
      return res.status(400).json({ error: 'Invalid list parameter' });
    }

    var response = await fetch(TMDB_BASE + endpoint + '?api_key=' + apiKey + '&language=en-US&page=' + (req.query.page || '1'));
    var data = await response.json();

    if (!data.results) {
      return res.status(200).json({ movies: [] });
    }

    var movies = data.results
      .filter(function(item) { return item.original_language !== 'ru' && item.vote_count > 100; })
      .map(function(item) {
        return mapMovie(item, list === 'trending_tv' || list === 'popular_tv' ? 'tv' : 'movie');
      });
    return res.status(200).json({ movies: movies, totalPages: data.total_pages || 0 });
  } catch (error) {
    console.error('TMDB API error:', error);
    return res.status(500).json({ error: 'Failed to fetch from TMDB', details: error.message });
  }
};
