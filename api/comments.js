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
// An author can edit their own comment or reply for EDIT_WINDOW_MS after
// posting. An edit re-runs moderation whenever the text changed (otherwise
// "post something bland, then rewrite it" would walk around the only gate
// there is), keeps the comment's original score so it can't bump itself up
// the feed, and stamps `editedAt` so readers can see it was changed.
// `spoiler` is a purely presentational flag the author sets: the UI masks
// the text until the reader asks for it. Moderation neither sets nor reads
// it — it has no title or plot to judge "is this a spoiler" against, and the
// verdict schema has no outcome between allow and reject anyway.
//
//   GET  /api/comments?type=&id=&s=&e=&cursor=   + optional header X-Client-Id
//        -> { comments: [{ ..., replies: [...] }], nextCursor }
//   POST /api/comments   { type, id, s?, e?, clientId, text, displayName?, parentId?, spoiler? }
//        -> 201 { comment }   |   422 { error }  (flagged or moderation-unavailable)
//   PATCH /api/comments  { type, id, s?, e?, commentId, clientId, text, spoiler?, parentId? }
//        -> 200 { comment }   |   403 { error }  (not yours / edit window closed)
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

// How long a comment stays editable by its author. Enforced here against the
// comment's own stored createdAt — the client runs the same countdown only to
// know when to hide the Edit button; this is the authority.
const EDIT_WINDOW_MS = 15 * 60 * 1000;
// Per-comment ceiling on edits, tracked on the comment itself. Unlike the rate
// limiters below, this one can't be reset by rotating a clientId or an IP.
const EDIT_MAX = 5;

// commentId/parentId are interpolated straight into Redis key names, so they're
// held to the crypto.randomUUID() shape the ids are actually generated in.
const COMMENT_ID_RE = /^[0-9a-fA-F-]{8,64}$/;

function isCommentId(value) {
  return typeof value === 'string' && COMMENT_ID_RE.test(value);
}

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

// Edits get their OWN limiters rather than sharing the post ones: the post
// limiter is 1-per-20s, which would reject the single most common edit there
// is — spotting a typo seconds after posting. Separate prefixes are separate
// buckets, so an edit never eats a post's allowance either. Still tight enough
// that the (AI-backed, quota-limited) re-moderation call can't be spammed.
const editClientLimiter = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(5, '5 m'),
  prefix: 'ratelimit:comments:edit:client',
});
const editIpLimiter = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(15, '10 m'),
  prefix: 'ratelimit:comments:edit:ip',
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
      const { clientId, editCount, ...rest } = c;
      // spoiler/editedAt are normalized rather than passed straight through:
      // comments stored before those fields existed have neither, and the
      // client shouldn't have to special-case `undefined` for them.
      return {
        ...rest,
        spoiler: rest.spoiler === true,
        editedAt: typeof rest.editedAt === 'number' ? rest.editedAt : null,
        isMine: !!requesterId && clientId === requesterId,
      };
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
  // Presentation only — a spoiler-marked comment is masked in the UI until the
  // reader opts in. It is NOT a moderation category: the text still goes
  // through the exact same check either way.
  const spoiler = body.spoiler === true;

  if (!clientId || typeof clientId !== 'string') {
    return res.status(400).json({ error: 'Missing clientId.' });
  }
  if (!text || text.length > TEXT_MAX) {
    return res.status(400).json({ error: `Comment must be 1-${TEXT_MAX} characters.` });
  }
  if (displayName.length > NAME_MAX) {
    return res.status(400).json({ error: `Display name must be ${NAME_MAX} characters or fewer.` });
  }
  if (parentId !== null && !isCommentId(parentId)) {
    return res.status(400).json({ error: 'Invalid parentId.' });
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
    editedAt: null,
    parentId,
    spoiler,
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
// already auto-deserialized by @upstash/redis (the same surprise the GET
// path's `typeof entry === 'string'` guard exists for) — normalize back to the
// exact stored string, since ZREM needs a byte-for-byte match, not just the
// same data.
function rawMember(entry) {
  return typeof entry === 'string' ? entry : JSON.stringify(entry);
}

// Editing rewrites a Sorted Set member in place: drop the old JSON string, add
// the new one at the SAME score so the comment keeps its position in the
// timeline. Done as one script so it's atomic — two concurrent edits of the
// same comment can't both remove-then-add and leave two members carrying the
// same comment id (which the UI tracks by id, so a duplicate would be visible,
// not just untidy). Returning 0 means the old member was already gone: someone
// else changed or deleted this comment in between, so the caller reloads
// instead of resurrecting a stale copy.
// The score is read back out of Redis rather than passed in from JS, so the
// rewritten member lands on the byte-identical score it had (no float
// round-trip through JavaScript) and the comment keeps its exact place.
const SWAP_MEMBER_SCRIPT = `
local score = redis.call('ZSCORE', KEYS[1], ARGV[1])
if not score then return 0 end
redis.call('ZREM', KEYS[1], ARGV[1])
redis.call('ZADD', KEYS[1], score, ARGV[2])
return 1
`;

async function handlePatch(req, res) {
  const body = req.body || {};
  let key;
  try {
    key = resolveContentKey(body);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  const { commentId, clientId } = body;
  const parentId = typeof body.parentId === 'string' && body.parentId ? body.parentId : null;
  const text = typeof body.text === 'string' ? body.text.trim() : '';

  if (!isCommentId(commentId)) {
    return res.status(400).json({ error: 'Missing or invalid commentId.' });
  }
  if (parentId !== null && !isCommentId(parentId)) {
    return res.status(400).json({ error: 'Invalid parentId.' });
  }
  if (!clientId || typeof clientId !== 'string') {
    return res.status(400).json({ error: 'Missing clientId.' });
  }
  if (!text || text.length > TEXT_MAX) {
    return res.status(400).json({ error: `Comment must be 1-${TEXT_MAX} characters.` });
  }

  // The per-IP limit is spent before the read, because the lookup below is a
  // full ZRANGE of the thread — otherwise an unknown commentId would be a free
  // way to hammer Redis. The per-client limit is spent later, only once we know
  // this is a real change (see below), so a rejected or no-op edit doesn't eat
  // the author's allowance.
  const ipCheck = await editIpLimiter.limit(clientIp(req));
  if (!ipCheck.success) {
    return res.status(429).json({ error: 'You’re editing too fast — wait a moment and try again.' });
  }

  const targetKey = parentId ? `replies:${parentId}` : `comments:${key}`;

  let match;
  try {
    const raw = await redis.zrange(targetKey, 0, -1);
    match = raw.find((entry) => {
      const c = typeof entry === 'string' ? JSON.parse(entry) : entry;
      return c.id === commentId;
    });
  } catch (e) {
    console.error('comments PATCH lookup error:', e);
    return res.status(502).json({ error: 'Could not load this comment right now.' });
  }
  if (!match) {
    return res.status(404).json({ error: 'Comment not found.' });
  }

  const parsed = typeof match === 'string' ? JSON.parse(match) : match;
  // Omitting `spoiler` leaves the existing mask alone; sending false clears it.
  const spoiler = body.spoiler === undefined ? parsed.spoiler === true : body.spoiler === true;
  const editCount = typeof parsed.editCount === 'number' ? parsed.editCount : 0;

  if (parsed.clientId !== clientId) {
    return res.status(403).json({ error: 'You can only edit your own comments.' });
  }
  if (Date.now() - parsed.createdAt > EDIT_WINDOW_MS) {
    return res.status(403).json({ error: 'Comments can only be edited within 15 minutes of posting.' });
  }
  // Moderation verdicts on borderline text aren't perfectly deterministic (see
  // lib/moderation.js), so an unlimited edit endpoint would let someone simply
  // re-submit the same rejected text until the model happens to allow it. The
  // rate limiters don't stop that — both clientId and IP are rotatable — but a
  // counter stored on the comment itself does.
  if (editCount >= EDIT_MAX) {
    return res.status(403).json({ error: `A comment can only be edited ${EDIT_MAX} times.` });
  }

  // Nothing actually changed: don't write, don't spend a moderation call, and
  // don't stamp it "(edited)". Re-moderating already-approved text would be
  // worse than wasteful — a flipped verdict would 422 a comment that's already
  // live on the page.
  if (text === parsed.text && spoiler === (parsed.spoiler === true)) {
    const { clientId: _same, editCount: _kept, ...unchanged } = parsed;
    return res.status(200).json({
      comment: { ...unchanged, spoiler, editedAt: parsed.editedAt ?? null, isMine: true },
    });
  }

  const clientCheck = await editClientLimiter.limit(clientId);
  if (!clientCheck.success) {
    return res.status(429).json({ error: 'You’re editing too fast — wait a moment and try again.' });
  }

  // Re-moderate whenever the text actually changed — otherwise "post something
  // innocuous, then edit it into whatever you like" would walk straight around
  // the only safety mechanism this feature has. Toggling the spoiler mask on
  // text that was already approved doesn't need a fresh verdict. (displayName
  // isn't editable, so the rest of the moderated input can't have changed.)
  if (text !== parsed.text) {
    let verdict;
    try {
      verdict = await moderateComment({ text, displayName: parsed.displayName || null });
    } catch (e) {
      console.error('comments PATCH moderation error:', e);
      return res.status(422).json({ error: "Couldn't verify this edit right now — please try again." });
    }
    if (!verdict.allowed) {
      return res.status(422).json({ error: verdict.reason || "This comment isn't allowed." });
    }
  }

  // Rebuilt from the STORED comment, not from the request body: id, author,
  // country, createdAt and parentId are all server-owned and stay put — an
  // edit can only ever change the text and the spoiler mask. (createdAt in
  // particular doubles as the ZSET score and the pagination cursor, so letting
  // it move would both bump the comment up the feed and corrupt "Load more".)
  const updated = { ...parsed, text, spoiler, editedAt: Date.now(), editCount: editCount + 1 };

  try {
    const swapped = await redis.eval(SWAP_MEMBER_SCRIPT, [targetKey], [rawMember(match), JSON.stringify(updated)]);
    if (!swapped) {
      return res.status(409).json({ error: 'This comment changed somewhere else — reload and try again.' });
    }
  } catch (e) {
    console.error('comments PATCH save error:', e);
    return res.status(502).json({ error: 'Could not save your edit right now.' });
  }

  const { clientId: _drop, editCount: _n, ...rest } = updated;
  return res.status(200).json({ comment: { ...rest, isMine: true } });
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
  if (!isCommentId(commentId)) {
    return res.status(400).json({ error: 'Missing or invalid commentId.' });
  }
  if (parentId !== null && !isCommentId(parentId)) {
    return res.status(400).json({ error: 'Invalid parentId.' });
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
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Accept, Content-Type, X-Client-Id');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET') return handleGet(req, res);
  if (req.method === 'POST') return handlePost(req, res);
  if (req.method === 'PATCH') return handlePatch(req, res);
  if (req.method === 'DELETE') return handleDelete(req, res);
  return res.status(405).json({ error: 'Method not allowed.' });
};
