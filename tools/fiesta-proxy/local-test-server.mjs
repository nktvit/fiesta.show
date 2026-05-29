// Lightweight harness to run the Vercel /api functions locally without `vercel dev`.
// Mounts api/stream.js and api/hls.js, parsing ?query into req.query like Vercel does.
import http from 'node:http';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');

// Load local-only env (e.g. STREAM_PROXY_URL) from a gitignored .env.local.
const envFile = path.join(HERE, '.env.local');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  console.log('loaded .env.local; STREAM_PROXY_URL', process.env.STREAM_PROXY_URL ? 'set' : 'unset');
}

const stream = require(path.join(ROOT, 'api/stream.js'));
const hls = require(path.join(ROOT, 'api/hls.js'));

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  req.query = Object.fromEntries(url.searchParams.entries());
  // shim res.status().json()/send()/end() like Vercel
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (o) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(o)); return res; };
  const origSend = (b) => { res.end(b); return res; };
  res.send = origSend;

  try {
    if (url.pathname === '/api/stream') return await stream(req, res);
    if (url.pathname === '/api/hls') return await hls(req, res);
    res.statusCode = 404; res.end('not found');
  } catch (e) {
    res.statusCode = 500; res.end('handler threw: ' + (e && e.stack || e));
  }
});

const PORT = process.env.PORT || 3999;
server.listen(PORT, () => console.log('local api server on http://127.0.0.1:' + PORT));
