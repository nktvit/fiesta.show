import { callApi } from './api-router';
import { handleSitePage } from './pages';

export interface Env {
  ASSETS: Fetcher;
  DEPLOY_ENV?: string;
  [key: string]: unknown;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) return callApi(request);
    try {
      const res = await handleSitePage(request, env, ctx);
      if (res) return res;
    } catch (e) {
      console.error('page handler error:', e);
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
