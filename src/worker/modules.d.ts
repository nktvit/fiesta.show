// The api/ handlers are plain CommonJS Node (req, res) functions.
declare module '*/api/*.js' {
  const handler: (req: any, res: any) => Promise<unknown> | unknown;
  export default handler;
}
declare module '*/lib/page-meta.mjs' {
  export function renderPageMeta(ctx: any, url: URL, fetchMeta: () => Promise<any>): Promise<string | null>;
  export function fetchMovieMeta(ctx: any, url: URL, rawId: string): Promise<any>;
  export function fetchPersonMeta(ctx: any, rawId: string): Promise<any>;
  export function fetchMusicMeta(ctx: any, kind: string, rawId: string): Promise<any>;
  export function isBotUserAgent(ua: string): boolean;
}
