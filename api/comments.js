// Anonymous, pre-moderated comments, one level of replies deep (no
// replies-to-replies). Top-level comments live in one Redis Sorted Set per
// content item (score = createdAt ms); each top-level comment's replies live
// in their OWN sorted set (`replies:{commentId}`), kept separate so paging
// the top-level list never has to reason about interleaved reply timestamps.
// Replies aren't paginated (reply counts per comment are expected to stay
// small) — fetched in full whenever their parent is. Moderation is
// synchronous and the ONLY safety mechanism here (no human review queue) —
// see lib/moderation.js for the fail-closed rationale; replies go through
// the exact same check as top-level comments.
//
//   GET  /api/comments?type=&id=&s=&e=&cursor=   + optional header X-Client-Id
//        -> { comments: [{ ..., replies: [...] }], nextCursor }
//   POST /api/comments   { type, id, s?, e?, clientId, text, displayName?, parentId? }
//        -> 201 { comment }   |   422 { error }  (flagged or moderation-unavailable)
//   DELETE /api/comments   { type, id, s?, e?, commentId, clientId, parentId? }
//        -> 200 { deleted: true }

const { randomUUID } = require('crypto');
const { Ratelimit } = require('@upstash/ratelimit');
const { redis } = require('../lib/redis');
const { resolveContentKey, commentLikesKey } = require('../lib/content-key');
const { moderateComment } = require('../lib/moderation');

const PAGE_SIZE = 20;
const TEXT_MAX = 500;
const NAME_MAX = 24;

// Two limiters: per-clientId stops rapid-fire posting, per-IP stops cycling
// clientIds (trivial to fake, it's just a localStorage value) from bypassing
// the first one from a single source.
const clientLimiter = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(1, '20 s'),
  prefix: 'ratelimit:comments:client',
});
const ipLimiter = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(20, '10 m'),
  prefix: 'ratelimit:comments:ip',
});

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  return (Array.isArray(fwd) ? fwd[0] : fwd || '').split(',')[0].trim() || 'unknown';
}

async function handleGet(req, res) {
  let key;
  try {
    key = resolveContentKey(req.query);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  const requesterId = req.headers['x-client-id'] || null;

  const cursorParam = req.query.cursor;
  let upperBound = '+inf';
  if (cursorParam !== undefined) {
    const cursor = Number(cursorParam);
    if (!Number.isFinite(cursor)) return res.status(400).json({ error: 'Invalid cursor.' });
    upperBound = `(${cursor}`; // exclusive: never re-show the last row of the previous page
  }

  try {
    // ZRANGE ... REV BYSCORE requires (max, min) order, not (min, max).
    const raw = await redis.zrange(`comments:${key}`, upperBound, '-inf', {
      byScore: true,
      rev: true,
      offset: 0,
      count: PAGE_SIZE,
    });

    const strip = (entry) => {
      const c = typeof entry === 'string' ? JSON.parse(entry) : entry;
      const { clientId, ...rest } = c;
      return { ...rest, isMine: !!requesterId && clientId === requesterId };
    };
    const stripped = raw.map(strip);

    // Pass 1: each top-level comment's like state + its raw replies,
    // batched into one round trip.
    let comments = stripped.map((c) => ({ ...c, likeCount: 0, liked: false, replies: [] }));
    if (stripped.length > 0) {
      const pipe1 = redis.pipeline();
      for (const c of stripped) {
        pipe1.scard(commentLikesKey(c.id));
        pipe1.sismember(commentLikesKey(c.id), requesterId || '');
        pipe1.zrange(`replies:${c.id}`, 0, -1);
      }
      const results1 = await pipe1.exec();

      comments = stripped.map((c, i) => ({
        ...c,
        likeCount: results1[i * 3],
        liked: requesterId ? !!results1[i * 3 + 1] : false,
        replies: (results1[i * 3 + 2] || []).map(strip).sort((a, b) => a.createdAt - b.createdAt),
      }));

      // Pass 2: each reply's own like state, once we know how many replies
      // exist (can't be folded into pass 1 — that count isn't known yet).
      const allReplies = comments.flatMap((c) => c.replies);
      if (allReplies.length > 0) {
        const pipe2 = redis.pipeline();
        for (const r of allReplies) {
          pipe2.scard(commentLikesKey(r.id));
          pipe2.sismember(commentLikesKey(r.id), requesterId || '');
        }
        const results2 = await pipe2.exec();
        let idx = 0;
        comments = comments.map((c) => ({
          ...c,
          replies: c.replies.map((r) => {
            const patched = { ...r, likeCount: results2[idx * 2], liked: requesterId ? !!results2[idx * 2 + 1] : false };
            idx++;
            return patched;
          }),
        }));
      }
    }

    const nextCursor = comments.length === PAGE_SIZE ? comments[comments.length - 1].createdAt : null;

    return res.status(200).json({ comments, nextCursor });
  } catch (e) {
    console.error('comments GET error:', e);
    return res.status(502).json({ error: 'Could not load comments right now.' });
  }
}

async function handlePost(req, res) {
  const body = req.body || {};
  let key;
  try {
    key = resolveContentKey(body);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  const { clientId } = body;
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  const displayName = typeof body.displayName === 'string' ? body.displayName.trim() : '';
  const parentId = typeof body.parentId === 'string' && body.parentId ? body.parentId : null;

  if (!clientId || typeof clientId !== 'string') {
    return res.status(400).json({ error: 'Missing clientId.' });
  }
  if (!text || text.length > TEXT_MAX) {
    return res.status(400).json({ error: `Comment must be 1-${TEXT_MAX} characters.` });
  }
  if (displayName.length > NAME_MAX) {
    return res.status(400).json({ error: `Display name must be ${NAME_MAX} characters or fewer.` });
  }

  const [clientCheck, ipCheck] = await Promise.all([
    clientLimiter.limit(clientId),
    ipLimiter.limit(clientIp(req)),
  ]);
  if (!clientCheck.success || !ipCheck.success) {
    return res.status(429).json({ error: 'You’re posting too fast — wait a moment and try again.' });
  }

  let verdict;
  try {
    verdict = await moderateComment({ text, displayName: displayName || null });
  } catch (e) {
    console.error('comments moderation error:', e);
    // Fail closed: a moderation-check failure must never become a silent
    // bypass, since moderation is the only safety mechanism here.
    return res.status(422).json({ error: "Couldn't verify this comment right now — please try again." });
  }
  if (!verdict.allowed) {
    return res.status(422).json({ error: verdict.reason || "This comment isn't allowed." });
  }

  const comment = {
    id: randomUUID(),
    text,
    displayName: displayName || null,
    country: req.headers['x-vercel-ip-country'] || null,
    clientId,
    createdAt: Date.now(),
    parentId,
  };

  try {
    const targetKey = parentId ? `replies:${parentId}` : `comments:${key}`;
    await redis.zadd(targetKey, { score: comment.createdAt, member: JSON.stringify(comment) });
  } catch (e) {
    console.error('comments POST save error:', e);
    return res.status(502).json({ error: 'Could not save your comment right now.' });
  }

  const { clientId: _drop, ...rest } = comment;
  return res.status(201).json({ comment: { ...rest, isMine: true, likeCount: 0, liked: false, replies: [] } });
}

// A comment's Redis member is JSON, either as the exact stored string or
// already auto-deserialized by @upstash/redis (see api/likes.js's sibling
// note) — normalize back to the exact stored string, since ZREM needs a
// byte-for-byte match, not just the same data.
function rawMember(entry) {
  return typeof entry === 'string' ? entry : JSON.stringify(entry);
}

async function handleDelete(req, res) {
  const body = req.body || {};
  let key;
  try {
    key = resolveContentKey(body);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  const { commentId, clientId } = body;
  const parentId = typeof body.parentId === 'string' && body.parentId ? body.parentId : null;
  if (!commentId || typeof commentId !== 'string') {
    return res.status(400).json({ error: 'Missing commentId.' });
  }
  if (!clientId || typeof clientId !== 'string') {
    return res.status(400).json({ error: 'Missing clientId.' });
  }

  const targetKey = parentId ? `replies:${parentId}` : `comments:${key}`;

  try {
    const raw = await redis.zrange(targetKey, 0, -1);
    const match = raw.find((entry) => {
      const c = typeof entry === 'string' ? JSON.parse(entry) : entry;
      return c.id === commentId;
    });
    if (!match) {
      return res.status(404).json({ error: 'Comment not found.' });
    }
    const parsed = typeof match === 'string' ? JSON.parse(match) : match;
    if (parsed.clientId !== clientId) {
      return res.status(403).json({ error: 'You can only delete your own comments.' });
    }

    await redis.zrem(targetKey, rawMember(match));
    await redis.del(commentLikesKey(commentId));
    // Deleting a top-level comment cascades to its replies thread. (Each
    // individual reply's own commentlikes: key is left behind — a small,
    // harmless orphan, not worth an extra round trip to enumerate and clean.)
    if (!parentId) {
      await redis.del(`replies:${commentId}`);
    }
    return res.status(200).json({ deleted: true });
  } catch (e) {
    console.error('comments DELETE error:', e);
    return res.status(502).json({ error: 'Could not delete this comment right now.' });
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Accept, Content-Type, X-Client-Id');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET') return handleGet(req, res);
  if (req.method === 'POST') return handlePost(req, res);
  if (req.method === 'DELETE') return handleDelete(req, res);
  return res.status(405).json({ error: 'Method not allowed.' });
};
