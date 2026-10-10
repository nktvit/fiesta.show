import { runHandler } from './node-compat';
import movie from '../../api/movie.js';
import omdb from '../../api/omdb.js';
import tmdb from '../../api/tmdb.js';
import subs from '../../api/subs.js';
import suggestions from '../../api/suggestions.js';
import stream from '../../api/stream.js';
import likes from '../../api/likes.js';
import comments from '../../api/comments.js';
import music from '../../api/music.js';

const API: Record<string, (req: any, res: any) => unknown> = {
  movie, omdb, tmdb, subs, suggestions, stream, likes, comments, music,
};

/** Call an /api/<name> handler in-process (no subrequest to ourselves). */
export function callApi(request: Request): Promise<Response> {
  const name = new URL(request.url).pathname.replace(/^\/api\//, '').replace(/\/$/, '');
  const handler = Object.prototype.hasOwnProperty.call(API, name) ? API[name] : null;
  if (!handler) {
    return Promise.resolve(
      new Response(JSON.stringify({ error: 'not_found' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }
  return runHandler(handler, request);
}
