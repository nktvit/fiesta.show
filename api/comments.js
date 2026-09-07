// Anonymous, pre-moderated comments. One Redis Sorted Set per content item
// (score = createdAt ms), so it's naturally ordered and pageable with no
// separate index. Moderation is synchronous and the ONLY safety mechanism
// here (no human review queue) — see lib/moderation.js for the fail-closed
// rationale.
//
//   GET  /api/comments?type=&id=&s=&e=&cursor=   + optional header X-Client-Id
//        -> { comments: [...], nextCursor }
//   POST /api/comments   { type, id, s?, e?, clientId, text, displayName? }
//        -> 201 { comment }   |   422 { error }  (flagged or moderation-unavailable)

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

    const stripped = raw.map((entry) => {
      const c = typeof entry === 'string' ? JSON.parse(entry) : entry;
      const { clientId, ...rest } = c;
      return { ...rest, isMine: !!requesterId && clientId === requesterId };
    });

    // Per-comment like count/state, batched into one round trip rather than
    // 1-2 Redis calls per comment.
    let comments = stripped;
    if (stripped.length > 0) {
      const pipe = redis.pipeline();
      for (const c of stripped) {
        pipe.scard(commentLikesKey(c.id));
        pipe.sismember(commentLikesKey(c.id), requesterId || '');
      }
      const results = await pipe.exec();
      comments = stripped.map((c, i) => ({
        ...c,
        likeCount: results[i * 2],
        liked: requesterId ? !!results[i * 2 + 1] : false,
      }));
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
  };

  try {
    await redis.zadd(`comments:${key}`, { score: comment.createdAt, member: JSON.stringify(comment) });
  } catch (e) {
    console.error('comments POST save error:', e);
    return res.status(502).json({ error: 'Could not save your comment right now.' });
  }

  const { clientId: _drop, ...rest } = comment;
  return res.status(201).json({ comment: { ...rest, isMine: true, likeCount: 0, liked: false } });
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Accept, Content-Type, X-Client-Id');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET') return handleGet(req, res);
  if (req.method === 'POST') return handlePost(req, res);
  return res.status(405).json({ error: 'Method not allowed.' });
};
