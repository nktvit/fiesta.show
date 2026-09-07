// Builds Redis keys for likes/comments. Shared by api/likes.js and
// api/comments.js (both GET query params and POST body) so the two can't
// silently drift onto different key shapes for the same content or comment.

// crypto.randomUUID() shape — bounds what can end up inside a Redis key built
// from user input.
const COMMENT_ID_RE = /^[0-9a-fA-F-]{8,64}$/;

function commentLikesKey(commentId) {
  return `commentlikes:${commentId}`;
}

// A like target is either a specific comment (commentId given) or the
// movie/episode itself (type+id[+s+e]) — same idempotent Set-based toggle
// either way, just a different key, so api/likes.js handles both through one
// endpoint.
function resolveLikeTargetKey(input) {
  const commentId = input && input.commentId;
  if (commentId !== undefined && commentId !== null && commentId !== '') {
    if (typeof commentId !== 'string' || !COMMENT_ID_RE.test(commentId)) {
      throw new Error('Invalid commentId.');
    }
    return commentLikesKey(commentId);
  }
  return `likes:${resolveContentKey(input)}`;
}

function resolveContentKey({ type, id, s, e }) {
  const t = type === 'tv' ? 'tv' : type === 'movie' ? 'movie' : null;
  if (!t) throw new Error('Invalid type. Expected "movie" or "tv".');
  if (!id || !/^tt\d+$/.test(id)) throw new Error('Invalid IMDB ID. Expected format: tt1234567');

  if (t === 'movie') return `content:movie:${id}`;

  const season = parseInt(s, 10);
  const episode = parseInt(e, 10);
  if (!Number.isInteger(season) || season < 1 || !Number.isInteger(episode) || episode < 1) {
    throw new Error('TV content requires a valid season (s) and episode (e).');
  }
  return `content:tv:${id}:s${season}:e${episode}`;
}

module.exports = { resolveContentKey, resolveLikeTargetKey, commentLikesKey };
