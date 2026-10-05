// Lightweight harness to run the Vercel /api functions locally without `vercel dev`.
// Mounts the api/*.js handlers, parsing ?query into req.query like Vercel does.
// `ng serve` proxies /api/* here (src/proxy.conf.json), so dev runs the same
// api/tmdb.js and api/movie.js code as production. Needs TMDB_API_KEY and
// OMDB_API_KEY (repo-root .env, .env.local or the shell environment).
import http from 'node:http';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');

// Load local-only env (STREAM_RELAY_URL / STREAM_RELAY_SECRET) from a gitignored .env.local.
const envFile = path.join(HERE, '.env.local');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  console.log('loaded .env.local; STREAM_RELAY_URL', process.env.STREAM_RELAY_URL ? 'set' : 'unset');
}

// Repo-root env (TIDAL_*, TMDB/OMDB keys), same gitignored files `vercel dev` would read.
for (const name of ['.env.local', '.env']) {
  const f = path.join(ROOT, name);
  if (!fs.existsSync(f)) continue;
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    const m = line.match(/^\s*((?:TIDAL_[A-Z0-9_]+)|TMDB_API_KEY|OMDB_API_KEY)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

// Every handler the browser calls in dev (mirrors src/proxy.conf.json). A handler
// whose dependencies are missing is skipped with a warning instead of taking the
// whole harness down.
const ROUTES = {};
for (const name of ['stream', 'subs', 'music', 'tmdb', 'movie', 'omdb', 'suggestions']) {
  try {
    ROUTES['/api/' + name] = require(path.join(ROOT, 'api', name + '.js'));
  } catch (e) {
    console.warn('skipping /api/' + name + ':', e && e.message);
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  req.query = Object.fromEntries(url.searchParams.entries());
  // shim res.status().json()/send()/end() like Vercel
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (o) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(o)); return res; };
  const origSend = (b) => { res.end(b); return res; };
  res.send = origSend;

  try {
    const handler = ROUTES[url.pathname];
    if (handler) return await handler(req, res);
    res.statusCode = 404; res.end('not found');
  } catch (e) {
    res.statusCode = 500; res.end('handler threw: ' + (e && e.stack || e));
  }
});

const PORT = process.env.PORT || 3999;
server.listen(PORT, () => console.log('local api server on http://127.0.0.1:' + PORT));
