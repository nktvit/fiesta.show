// Shared Upstash Redis client for api/likes.js and api/comments.js.
// Redis.fromEnv() reads UPSTASH_REDIS_REST_URL/_TOKEN, falling back to
// KV_REST_API_URL/_TOKEN — the names `vercel integration add upstash` set.
//
// Created lazily on first use: on Cloudflare Workers, process.env is only
// populated per request, not while the module's top level is evaluated.

const { Redis } = require('@upstash/redis');

let client = null;
function get() {
  if (!client) client = Redis.fromEnv();
  return client;
}

const redis = new Proxy(
  {},
  {
    get(_t, prop) {
      const c = get();
      const v = c[prop];
      return typeof v === 'function' ? v.bind(c) : v;
    },
  },
);

module.exports = { redis };
