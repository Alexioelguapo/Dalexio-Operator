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
    if (url.pathname === '/set-session') {
      // Simulates a login: sets a cookie, and the page stores a localStorage value.
      const who = (url.searchParams.get('who') ?? 'anon').replace(/[^a-z0-9-]/gi, '');
      res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': `session=${who}; Path=/; Max-Age=3600; HttpOnly` });
      res.end(`<title>Logged in</title><script>localStorage.setItem('brand', ${JSON.stringify(who)})</script><p>ok</p>`);
      return;
    }
    if (url.pathname === '/whoami') {
      const cookie = /(?:^|;\s*)session=([^;]+)/.exec(req.headers.cookie ?? '')?.[1] ?? 'nobody';
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<title>whoami</title><h1 id="who">${cookie}</h1><p id="ls"></p><script>document.getElementById('ls').textContent = localStorage.getItem('brand') || 'none'</script>`);
      return;
    }
    if (url.pathname.startsWith('/files/')) {
      const files = {
        'report.csv': { type: 'text/csv', name: 'report.csv', body: 'brand,posts\nmixed-beanz,12\n' },
        'evil': { type: 'application/octet-stream', name: '../../../evil.sh', body: '#!/bin/sh\necho pwned\n' },
        'logo': { type: 'image/png', name: 'logo.png', body: Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex') },
        'hidden': { type: 'text/plain', name: '.bashrc', body: 'alias x=y\n' },
      };
      const f = files[url.pathname.slice('/files/'.length)];
      if (!f) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'content-type': f.type, 'content-disposition': `attachment; filename="${f.name}"` });
      res.end(f.body);
      return;
    }
    if (url.pathname === '/upload' && req.method === 'POST') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = Buffer.concat(chunks).toString('latin1');
      const names = [...body.matchAll(/filename="([^"]*)"/g)].map((m) => m[1]);
      const caption = /name="caption"\r\n\r\n([^\r]*)/.exec(body)?.[1] ?? '';
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<title>Upload received</title><h1>Received ${names.length} file(s)</h1><p id="names">${names.join(',').replace(/[<>&]/g, '')}</p><p id="caption">${caption.replace(/[<>&]/g, '')}</p>`);
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
