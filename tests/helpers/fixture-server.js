// Minimal static server for deterministic browser tests (no network needed).
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

export async function startFixtureServer() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/search') {
      const q = url.searchParams.get('search') ?? '';
      const safe = q.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><title>Search results for ${safe}</title><h1>Results for ${safe}</h1><a href="/en.html">Result one</a>`);
      return;
    }
    if (url.pathname === '/slow') {
      setTimeout(() => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<title>Slow</title><p>slow</p>'); }, 5_000);
      return;
    }
    const name = path.basename(url.pathname === '/' ? 'portal.html' : url.pathname);
    try {
      const body = await readFile(path.join(ROOT, name));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(body);
    } catch {
      res.writeHead(404, { 'content-type': 'text/html' });
      res.end('<title>Not found</title><h1>404</h1>');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: (p = '/') => `http://127.0.0.1:${port}${p}`,
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }),
  };
}
