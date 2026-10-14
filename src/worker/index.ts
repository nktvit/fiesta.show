import { callApi } from './api-router';
import { handleSitePage } from './pages';
import { sitemapResponse } from './sitemap';
import { isBotUserAgent } from '../../lib/page-meta.mjs';

export interface Env {
  ASSETS: Fetcher;
  DEPLOY_ENV?: string;
  /** Workers Rate Limiting binding (wrangler.jsonc `ratelimits`). */
  STREAM_LIMIT?: { limit(o: { key: string }): Promise<{ success: boolean }> };
  MUSIC_LIMIT?: { limit(o: { key: string }): Promise<{ success: boolean }> };
  /** Workers AI binding, used by lib/moderation.js for comment moderation. */
  AI?: { run(model: string, input: unknown): Promise<any> };
  [key: string]: unknown;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    (globalThis as any).__CF_AI = env.AI;
    if (url.pathname === '/sitemap.xml') return sitemapResponse(request, env, ctx);
    const action = url.searchParams.get('action');
    if (url.pathname === '/api/stream') {
      const denied = await guardPlayback(request, env.STREAM_LIMIT);
      if (denied) return denied;
    } else if (url.pathname === '/api/music' && (action === 'manifest' || action === 'seg')) {
      // Audio: the manifest hands out the signed relay URLs, seg is the fallback byte path.
      const denied = await guardPlayback(request, action === 'manifest' ? env.MUSIC_LIMIT : undefined);
      if (denied) return denied;
    }
    if (url.pathname.startsWith('/api/')) return callApi(request, ctx);
    try {
      const res = await handleSitePage(request, env, ctx);
      if (res) return res;
    } catch (e) {
      console.error('page handler error:', e);
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;

const json = (status: number, error: string, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify({ error }), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...extra } });

/**
 * Only people watch films and listen to music: /api/stream and /api/music?action=manifest hand out the signed relay URLs, so crawlers (and clients
 * with no User-Agent) get nothing here while the rest of the site stays open to them. A viewer
 * resolves a stream once per title/episode, so the per-IP limit is far above normal use.
 */
async function guardPlayback(request: Request, limiter?: Env['STREAM_LIMIT']): Promise<Response | null> {
  const ua = request.headers.get('user-agent') || '';
  if (!ua || isBotUserAgent(ua)) return json(403, 'playback_not_available_for_bots');
  if (limiter) {
    const ip = request.headers.get('cf-connecting-ip') || 'unknown';
    try {
      if (!(await limiter.limit({ key: ip })).success) return json(429, 'too_many_requests', { 'retry-after': '60' });
    } catch {
      /* the limiter is best-effort */
    }
  }
  return null;
}
