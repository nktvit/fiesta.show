// Shared Upstash Redis client for api/likes.js and api/comments.js.
// Redis.fromEnv() reads UPSTASH_REDIS_REST_URL/_TOKEN, falling back to
// KV_REST_API_URL/_TOKEN — the names `vercel integration add upstash` set.

const { Redis } = require('@upstash/redis');

const redis = Redis.fromEnv();

module.exports = { redis };
