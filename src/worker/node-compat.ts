// Adapter: run Vercel-style Node `(req, res)` handlers inside a Worker.

export interface NodeReq {
  method: string;
  url: string;
  query: Record<string, string | string[]>;
  headers: Record<string, string>;
  body: any;
}

export interface NodeRes {
  statusCode: number;
  headersSent: boolean;
  status(code: number): NodeRes;
  setHeader(name: string, value: string | number | string[]): NodeRes;
  getHeader(name: string): string | undefined;
  removeHeader(name: string): void;
  json(obj: unknown): NodeRes;
  send(body?: unknown): NodeRes;
  write(chunk: string | Uint8Array | ArrayBuffer): boolean;
  end(chunk?: string | Uint8Array | ArrayBuffer): NodeRes;
  on(): NodeRes;
  once(): NodeRes;
}

export async function toNodeReq(request: Request): Promise<NodeReq> {
  const url = new URL(request.url);
  const query: Record<string, string | string[]> = {};
  for (const [k, v] of url.searchParams) {
    const prev = query[k];
    if (prev === undefined) query[k] = v;
    else if (Array.isArray(prev)) prev.push(v);
    else query[k] = [prev, v];
  }

  const headers: Record<string, string> = {};
  request.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
  // Cloudflare equivalents of the headers the handlers read on Vercel. Set
  // unconditionally so a client cannot spoof them.
  const ip = request.headers.get('cf-connecting-ip');
  if (ip) headers['x-forwarded-for'] = ip;
  else delete headers['x-forwarded-for'];
  const country = request.headers.get('cf-ipcountry');
  if (country) headers['x-vercel-ip-country'] = country;
  else delete headers['x-vercel-ip-country'];

  let body: any = undefined;
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    const ct = (headers['content-type'] || '').toLowerCase();
    try {
      if (ct.includes('application/json')) {
        const text = await request.text();
        body = text ? JSON.parse(text) : undefined;
      } else if (ct.includes('application/x-www-form-urlencoded')) {
        body = Object.fromEntries(new URLSearchParams(await request.text()));
      } else {
        const text = await request.text();
        body = text || undefined;
      }
    } catch {
      body = undefined;
    }
  }

  return { method: request.method, url: url.pathname + url.search, query, headers, body };
}

const encoder = new TextEncoder();

function toBytes(chunk: string | Uint8Array | ArrayBuffer): Uint8Array {
  if (typeof chunk === 'string') return encoder.encode(chunk);
  if (chunk instanceof Uint8Array) return chunk;
  return new Uint8Array(chunk);
}

/**
 * Builds a `res` and a promise for the Response. The promise resolves as soon as
 * the headers are committed (first write/end/json/send), so write()/end() can stream.
 */
export function createNodeRes(): { res: NodeRes; response: Promise<Response> } {
  const headers = new Headers();
  let status = 200;
  let sent = false;
  let resolve!: (r: Response) => void;
  const response = new Promise<Response>((r) => (resolve = r));
  let writer: WritableStreamDefaultWriter<Uint8Array> | null = null;

  const commitFull = (body: BodyInit | null) => {
    if (sent) return;
    sent = true;
    const nullBody = status === 204 || status === 304 || status === 101;
    resolve(new Response(nullBody ? null : body, { status, headers }));
  };

  const res: NodeRes = {
    get statusCode() {
      return status;
    },
    set statusCode(v: number) {
      status = v;
    },
    get headersSent() {
      return sent;
    },
    status(code) {
      status = code;
      return res;
    },
    setHeader(name, value) {
      headers.delete(name);
      if (Array.isArray(value)) value.forEach((v) => headers.append(name, String(v)));
      else headers.set(name, String(value));
      return res;
    },
    getHeader(name) {
      return headers.get(name) ?? undefined;
    },
    removeHeader(name) {
      headers.delete(name);
    },
    json(obj) {
      if (!headers.has('content-type')) headers.set('content-type', 'application/json; charset=utf-8');
      commitFull(JSON.stringify(obj));
      return res;
    },
    send(body) {
      if (body === undefined || body === null) commitFull(null);
      else if (typeof body === 'string') {
        if (!headers.has('content-type')) headers.set('content-type', 'text/html; charset=utf-8');
        commitFull(body);
      } else if (body instanceof Uint8Array || body instanceof ArrayBuffer) {
        commitFull(body as BodyInit);
      } else return res.json(body);
      return res;
    },
    write(chunk) {
      if (!sent) {
        sent = true;
        const ts = new TransformStream<Uint8Array, Uint8Array>();
        writer = ts.writable.getWriter();
        resolve(new Response(ts.readable, { status, headers }));
      }
      // Backpressure is handled by the stream; errors surface on close.
      writer!.write(toBytes(chunk)).catch(() => {});
      return true;
    },
    end(chunk) {
      if (writer) {
        if (chunk !== undefined) writer.write(toBytes(chunk)).catch(() => {});
        writer.close().catch(() => {});
        return res;
      }
      if (sent) return res;
      commitFull(chunk === undefined ? null : (toBytes(chunk) as BodyInit));
      return res;
    },
    on() {
      return res;
    },
    once() {
      return res;
    },
  };

  return { res, response };
}

export async function runHandler(
  handler: (req: any, res: any) => unknown,
  request: Request,
): Promise<Response> {
  const req = await toNodeReq(request);
  const { res, response } = createNodeRes();
  Promise.resolve()
    .then(() => handler(req, res))
    .then(() => {
      // Handler returned without ending: close out so the request does not hang.
      if (!res.headersSent) res.end();
    })
    .catch((e) => {
      console.error('handler error:', e);
      if (!res.headersSent) {
        res.status(500).json({ error: 'internal_error' });
      } else {
        res.end();
      }
    });
  return response;
}
