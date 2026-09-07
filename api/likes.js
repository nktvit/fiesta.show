// Anonymous per-visitor likes — for a movie/episode AND, separately, for an
// individual comment. One Redis Set per target — set membership doubles as
// the counter (SCARD), so there's no separate counter that can desync, and
// SADD/SREM are each a single atomic toggle (no check-then-act race under a
// double-click/double-request).
//
//   GET  /api/likes?type=movie|tv&id=tt123[&s=&e=]   + header X-Client-Id
//   GET  /api/likes?commentId=<id>                   + header X-Client-Id
//        -> { count, liked }
//   POST /api/likes   { type, id, s?, e?, clientId, action } (content)
//   POST /api/likes   { commentId, clientId, action }        (a comment)
//        -> { count, liked }

const { Ratelimit } = require('@upstash/ratelimit');
const { redis } = require('../lib/redis');
const { resolveLikeTargetKey } = require('../lib/content-key');

// Likes are idempotent (SADD/SREM), so this is just an abuse backstop, not a
// correctness requirement.
const ipLimiter = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(30, '1 m'),
  prefix: 'ratelimit:likes:ip',
});

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  return (Array.isArray(fwd) ? fwd[0] : fwd || '').split(',')[0].trim() || 'unknown';
}

async function handleGet(req, res) {
  let key;
  try {
    key = resolveLikeTargetKey(req.query);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  const clientId = req.headers['x-client-id'];

  try {
    const [count, liked] = await Promise.all([
      redis.scard(key),
      clientId ? redis.sismember(key, clientId) : Promise.resolve(0),
    ]);
    return res.status(200).json({ count, liked: !!liked });
  } catch (e) {
    console.error('likes GET error:', e);
    return res.status(502).json({ error: 'Could not load likes right now.' });
  }
}

async function handlePost(req, res) {
  const body = req.body || {};
  let key;
  try {
    key = resolveLikeTargetKey(body);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  const { clientId, action } = body;
  if (!clientId || typeof clientId !== 'string') {
    return res.status(400).json({ error: 'Missing clientId.' });
  }
  if (action !== 'like' && action !== 'unlike') {
    return res.status(400).json({ error: 'action must be "like" or "unlike".' });
  }

  try {
    if (action === 'like') await redis.sadd(key, clientId);
    else await redis.srem(key, clientId);
    const count = await redis.scard(key);
    return res.status(200).json({ count, liked: action === 'like' });
  } catch (e) {
    console.error('likes POST error:', e);
    return res.status(502).json({ error: 'Could not update like right now.' });
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Accept, Content-Type, X-Client-Id');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { success } = await ipLimiter.limit(clientIp(req));
  if (!success) return res.status(429).json({ error: 'Too many requests — try again shortly.' });

  if (req.method === 'GET') return handleGet(req, res);
  if (req.method === 'POST') return handlePost(req, res);
  return res.status(405).json({ error: 'Method not allowed.' });
};
