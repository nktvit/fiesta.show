// Pure link-preview meta logic shared by middleware.js (Vercel) and
// src/worker/index.ts (Cloudflare). Environment specifics are injected via `ctx`:
//   ctx.api(path)   -> Promise<Response> for an /api/... path on this deployment
//   ctx.tmdbKey     -> TMDB API key (or undefined)
//   ctx.getIndexHtml() -> Promise<string|null> the SPA index.html

// Returns the meta-injected HTML string, or null (caller falls back to the SPA).
export async function renderPageMeta(ctx, url, fetchMeta) {
  try {
    const meta = await fetchMeta();
    if (!meta) return null;

    const indexHtml = await ctx.getIndexHtml();
    if (!indexHtml) return null;

    return injectMeta(indexHtml, meta, url);
  } catch {
    return null;
  }
}

export async function fetchMovieMeta(ctx, url, rawId) {
  const details = /^tt\d+$/.test(rawId)
    ? await fetchOmdbDetails(ctx, rawId)
    : /^\d+$/.test(rawId)
      ? await fetchTmdbDetails(ctx, rawId, url.searchParams.get('type'))
      : null;
  if (!details) return null;

  const yearSuffix = details.year ? ` (${details.year})` : '';
  const title = `${details.title}${yearSuffix} — Stream Free | Stream Fiesta`;
  const description = details.plot
    ? `Watch ${details.title}${yearSuffix} online for free. ${details.plot.substring(0, 120)}...`
    : `Watch ${details.title}${yearSuffix} online for free on Stream Fiesta. No subscription, no sign-up.`;

  return { title, description, image: details.image };
}

async function fetchOmdbDetails(ctx, rawId) {
  const res = await ctx.api('/api/movie?id=' + rawId);
  if (!res.ok) return null;
  const data = await res.json();
  if (data.Response === 'False' || !data.Title || data.Title === 'N/A') return null;

  return {
    title: data.Title,
    year: data.Year && data.Year !== 'N/A' ? data.Year : null,
    plot: data.Plot && data.Plot !== 'N/A' ? data.Plot : null,
    image: data._backdrop || (data.Poster && data.Poster !== 'N/A' ? data.Poster : null),
  };
}

async function fetchTmdbDetails(ctx, tmdbId, typeHint) {
  const apiKey = ctx.tmdbKey;
  if (!apiKey) return null;

  const order = typeHint === 'tv' ? ['tv', 'movie'] : ['movie', 'tv'];
  for (const kind of order) {
    const res = await fetch(`https://api.themoviedb.org/3/${kind}/${tmdbId}?api_key=${apiKey}&language=en-US`);
    if (!res.ok) continue;
    const data = await res.json();
    const title = data.title || data.name;
    if (!title) continue;

    return {
      title,
      year: (data.release_date || data.first_air_date || '').substring(0, 4) || null,
      plot: data.overview || null,
      image: data.backdrop_path
        ? 'https://image.tmdb.org/t/p/w1280' + data.backdrop_path
        : (data.poster_path ? 'https://image.tmdb.org/t/p/w500' + data.poster_path : null),
    };
  }

  return null;
}

export async function fetchPersonMeta(ctx, rawId) {
  if (!/^\d+$/.test(rawId)) return null;

  const res = await ctx.api('/api/tmdb?list=person&id=' + rawId);
  if (!res.ok) return null;
  const data = await res.json();
  if (!data || !data.name) return null;

  const title = `${data.name} — Movies & TV Shows | Stream Fiesta`;
  const description = data.biography
    ? `${data.biography.substring(0, 150)}...`
    : `Browse movies and TV shows featuring ${data.name} on Stream Fiesta.`;

  return { title, description, image: data.profilePath || null };
}

const BOT_UA = /bot|crawler|spider|facebookexternalhit|facebot|slurp|embedly|quora link preview|whatsapp|telegram|discord|slack|linkedin|pinterest|skypeuripreview|mastodon|bluesky|iframely|vkshare|redditbot|applebot|imessage|google-inspectiontool|preview/i;

export function isBotUserAgent(ua) {
  return BOT_UA.test(ua || '');
}

const MUSIC_ID = {
  album: /^\d{1,12}$/,
  artist: /^\d{1,12}$/,
  track: /^\d{1,12}$/,
  playlist: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  mix: /^[A-Za-z0-9]{8,40}$/,
};

// TIDAL cover URLs end in /320x320.jpg etc.; link previews want a bigger one.
function bigCover(src) {
  return src ? String(src).replace(/\/\d+x\d+\.(jpg|jpeg|png|webp)$/i, '/750x750.$1') : null;
}

export async function fetchMusicMeta(ctx, kind, rawId) {
  if (!MUSIC_ID[kind].test(rawId)) return null;
  const res = await ctx.api('/api/music?action=' + kind + '&id=' + encodeURIComponent(rawId));
  if (!res.ok) return null;
  const data = await res.json();
  if (!data) return null;

  if (kind === 'album' && data.album && data.album.title) {
    const a = data.album;
    const by = a.artist ? ` by ${a.artist}` : '';
    const bits = [a.year, a.tracks ? `${a.tracks} songs` : ''].filter(Boolean).join(' · ');
    return {
      title: `${a.title}${by} | Stream Fiesta`,
      description: `Listen to ${a.title}${by} in lossless on Stream Fiesta.${bits ? ' ' + bits + '.' : ''}`,
      image: bigCover(a.cover),
    };
  }
  if (kind === 'artist' && data.artist && data.artist.name) {
    return {
      title: `${data.artist.name} | Stream Fiesta`,
      description: `Listen to ${data.artist.name}: top songs and albums in lossless on Stream Fiesta.`,
      image: bigCover(data.artist.picture),
    };
  }
  if (kind === 'track' && data.track && data.track.title) {
    const t = data.track;
    return {
      title: `${t.title}${t.artist ? ' by ' + t.artist : ''} | Stream Fiesta`,
      description: `Listen to ${t.title}${t.artist ? ' by ' + t.artist : ''}${t.album ? ' from ' + t.album : ''} in lossless on Stream Fiesta.`,
      image: bigCover(t.cover),
    };
  }
  if (kind === 'playlist' && data.playlist && data.playlist.title) {
    const p = data.playlist;
    return {
      title: `${p.title} | Stream Fiesta`,
      description: (p.description || `Listen to the ${p.title} playlist${p.creator ? ' by ' + p.creator : ''} on Stream Fiesta.`).substring(0, 200),
      image: bigCover(p.cover),
    };
  }
  if (kind === 'mix' && data.mix && data.mix.title) {
    const m = data.mix;
    return {
      title: `${m.title} | Stream Fiesta`,
      description: (m.subTitle || `Listen to ${m.title} on Stream Fiesta.`).substring(0, 200),
      image: m.cover || null,
    };
  }
  return null;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function injectMeta(html, meta, url) {
  const image = meta.image || 'https://fiesta.show/assets/og-image.png';
  const pageUrl = url.origin + url.pathname;

  const t = escapeHtml(meta.title);
  const d = escapeHtml(meta.description);
  const img = escapeHtml(image);
  const u = escapeHtml(pageUrl);

  html = html.replace(/<title>[^<]*<\/title>/, `<title>${t}</title>`);
  html = html.replace(/<meta name="description" content="[^"]*">/, `<meta name="description" content="${d}">`);
  html = html.replace(/<meta property="og:title" content="[^"]*">/, `<meta property="og:title" content="${t}">`);
  html = html.replace(/<meta property="og:description" content="[^"]*">/, `<meta property="og:description" content="${d}">`);
  html = html.replace(/<meta property="og:url" content="[^"]*">/, `<meta property="og:url" content="${u}">`);
  html = html.replace(/<meta property="og:image" content="[^"]*">/, `<meta property="og:image" content="${img}">`);
  if (meta.image) {
    // Declared dimensions on the generic fallback image don't hold for a
    // per-title poster/backdrop — drop them so crawlers measure the real image.
    html = html.replace(/\s*<meta property="og:image:width" content="[^"]*">\n?/, '\n');
    html = html.replace(/\s*<meta property="og:image:height" content="[^"]*">\n?/, '\n');
  }
  html = html.replace(/<meta name="twitter:title" content="[^"]*">/, `<meta name="twitter:title" content="${t}">`);
  html = html.replace(/<meta name="twitter:description" content="[^"]*">/, `<meta name="twitter:description" content="${d}">`);
  html = html.replace(/<meta name="twitter:image" content="[^"]*">/, `<meta name="twitter:image" content="${img}">`);

  return html;
}

