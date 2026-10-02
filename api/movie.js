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

  res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=86400');

  var id = req.query.id;
  if (!id || !/^tt\d+$/.test(id)) {
    return res.status(400).json({ error: 'Invalid IMDB ID. Expected format: tt1234567' });
  }

  var omdbKey = process.env['OMDB_API_KEY'];
  var tmdbKey = process.env['TMDB_API_KEY'];

  if (!omdbKey) {
    return res.status(500).json({ error: 'OMDB API key not configured' });
  }

  try {
    // Fetch OMDB details and TMDB find in parallel
    var omdbUrl = 'https://www.omdbapi.com/?apikey=' + omdbKey + '&i=' + encodeURIComponent(id) + '&plot=full';
    var requests = [fetch(omdbUrl)];

    if (tmdbKey) {
      var tmdbUrl = 'https://api.themoviedb.org/3/find/' + id + '?api_key=' + tmdbKey + '&external_source=imdb_id';
      requests.push(fetch(tmdbUrl));
    }

    var responses = await Promise.all(requests);
    var omdbData = await responses[0].json();

    // Parse TMDB result (needed when OMDB lacks a title or is out of quota)
    var tmdbMatch = null;
    var isTv = false;
    if (responses[1]) {
      var tmdbData = await responses[1].json();
      tmdbMatch = (tmdbData.movie_results || [])[0] || (tmdbData.tv_results || [])[0];
      isTv = !(tmdbData.movie_results || []).length && !!(tmdbData.tv_results || []).length;
    }

    // The full TMDB record carries runtime, genres, credits, certification,
    // budget and revenue, so an OMDB miss -- or OMDB's daily quota running out
    // ("Request limit reached!") -- no longer leaves the page nearly empty.
    var tmdbFull = null;
    if (tmdbMatch) {
      var append = isTv ? 'credits,content_ratings' : 'credits,release_dates';
      try {
        var fullRes = await fetch('https://api.themoviedb.org/3/' + (isTv ? 'tv/' : 'movie/') + tmdbMatch.id +
          '?api_key=' + tmdbKey + '&append_to_response=' + append);
        if (fullRes.ok) tmdbFull = await fullRes.json();
      } catch (e) {
        console.error('TMDB details error:', e);
      }
    }

    var omdbError = omdbData.Response === 'False' ? (omdbData.Error || 'Movie not found') : null;
    if (omdbError) {
      if (!tmdbMatch) {
        res.setHeader('Cache-Control', 's-maxage=600');
        return res.status(404).json({ error: omdbError, Response: 'False' });
      }
      omdbData = { Response: 'True', imdbID: id, Type: isTv ? 'series' : 'movie' };
    }

    fillFromTmdb(omdbData, tmdbMatch, tmdbFull, isTv);

    if (omdbError) {
      // A quota/key failure is temporary: cache the TMDB-only version for an
      // hour so OMDB's ratings, awards and US box office return once it resets.
      // A title OMDB genuinely lacks is re-checked daily.
      var transient = /limit|api key/i.test(omdbError);
      res.setHeader('Cache-Control', 's-maxage=' + (transient ? 3600 : 86400) + ', stale-while-revalidate=600');
    }

    if (!omdbError) {
      // Per-title data barely changes: 30 days. A film still in cinemas keeps
      // collecting (Worldwide Gross), so its first 90 days refresh daily.
      var released = Date.parse((tmdbFull && (tmdbFull.release_date || tmdbFull.first_air_date)) || '');
      var recent = !released || Date.now() - released < 90 * 86400000;
      res.setHeader('Cache-Control', 's-maxage=' + (recent ? 86400 : 2592000) + ', stale-while-revalidate=86400');
    }

    return res.status(200).json(omdbData);
  } catch (error) {
    console.error('Movie API error:', error);
    return res.status(500).json({ error: 'Failed to fetch movie details', details: error.message });
  }
};

function na(v) {
  return v === undefined || v === null || v === '' || v === 'N/A';
}

function names(list) {
  return (list || []).map(function(x) { return x.english_name || x.name; }).filter(Boolean).join(', ');
}

function usd(n) {
  return n > 0 ? '$' + Math.round(n).toLocaleString('en-US') : null;
}

// "1994-09-23" -> "23 Sep 1994", the format OMDB uses.
function omdbDate(iso) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
  if (!m) return null;
  var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return m[3] + ' ' + months[+m[2] - 1] + ' ' + m[1];
}

function certification(full, isTv) {
  if (isTv) {
    var tv = ((full.content_ratings || {}).results || []);
    var tvUs = tv.find(function(r) { return r.iso_3166_1 === 'US'; }) || tv[0];
    return tvUs && tvUs.rating || null;
  }
  var all = ((full.release_dates || {}).results || []);
  var us = all.find(function(r) { return r.iso_3166_1 === 'US'; });
  var dates = (us && us.release_dates) || [];
  var hit = dates.find(function(d) { return d.certification; });
  return hit ? hit.certification : null;
}

// Fill every OMDB field that is missing or "N/A" from TMDB, and add the
// fields only TMDB has (budget, worldwide gross, tagline). Mutates `data`.
function fillFromTmdb(data, match, full, isTv) {
  var src = full || match;
  if (!src) {
    data._tmdbId = null;
    data._backdrop = null;
    return data;
  }

  var set = function(key, value) {
    if (na(data[key]) && !na(value)) data[key] = value;
  };

  var date = src.release_date || src.first_air_date || '';
  var crew = ((full && full.credits) || {}).crew || [];
  var cast = ((full && full.credits) || {}).cast || [];
  var unique = function(arr) { return arr.filter(function(v, i) { return arr.indexOf(v) === i; }); };

  set('Title', src.title || src.name);
  set('Year', date.substring(0, 4));
  set('Released', omdbDate(date));
  set('Plot', src.overview);
  set('Poster', src.poster_path ? 'https://image.tmdb.org/t/p/w342' + src.poster_path : null);

  if (full) {
    var runtime = isTv ? (full.episode_run_time || [])[0] : full.runtime;
    set('Runtime', runtime ? runtime + ' min' : null);
    set('Genre', names(full.genres));
    set('Rated', certification(full, isTv));
    set('Director', isTv
      ? names(full.created_by)
      : unique(crew.filter(function(c) { return c.job === 'Director'; }).map(function(c) { return c.name; })).join(', '));
    set('Writer', unique(crew.filter(function(c) { return c.department === 'Writing'; }).map(function(c) { return c.name; })).slice(0, 4).join(', '));
    set('Actors', cast.slice(0, 4).map(function(c) { return c.name; }).join(', '));
    set('Language', names(full.spoken_languages));
    set('Country', names(full.production_countries) || (full.origin_country || []).join(', '));
    set('Production', names((full.production_companies || []).slice(0, 3)));
    if (isTv) {
      set('totalSeasons', full.number_of_seasons ? String(full.number_of_seasons) : null);
      data._network = names(full.networks) || null;
      data._status = full.status || null;
    }
    data._tagline = full.tagline || null;
    data._budget = usd(full.budget);
    data._revenue = usd(full.revenue);
  }

  var vote = src.vote_average;
  if (na(data.imdbRating) && (!data.Ratings || data.Ratings.length === 0) && vote) {
    data.imdbRating = vote.toFixed(1);
    data.Ratings = [{ Source: 'TMDB', Value: vote.toFixed(1) + '/10' }];
  }
  if (!data.Ratings) data.Ratings = [];

  data._tmdbId = match ? match.id : src.id;
  data._backdrop = src.backdrop_path ? 'https://image.tmdb.org/t/p/w1280' + src.backdrop_path : null;
  return data;
}
