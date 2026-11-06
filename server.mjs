import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 4173);
const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const server = http.createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    if (pathname === '/desktop') {
      response.writeHead(302, { Location: '/desktop/' }).end();
      return;
    }
    if (pathname === '/tool') {
      response.writeHead(302, { Location: '/tool/' }).end();
      return;
    }

    let relativePath;
    if (pathname === '/' || pathname === '/index.html') {
      relativePath = 'website/index.html';
    } else if (pathname === '/desktop/' || pathname === '/tool/') {
      relativePath = 'website/tool.html';
    } else if (pathname.startsWith('/desktop/')) {
      relativePath = path.join('website', 'tool', pathname.slice('/desktop/'.length));
    } else if (pathname.startsWith('/tool/')) {
      relativePath = path.join('website', 'tool', pathname.slice('/tool/'.length));
    } else if (pathname === '/website/tool.html') {
      relativePath = 'website/tool.html';
    } else if (pathname.startsWith('/website/')) {
      relativePath = path.join('website', pathname.slice('/website/'.length));
    } else {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
      return;
    }

    const absolutePath = path.resolve(root, relativePath);
    const allowedRoots = [path.join(root, 'website'), path.join(root, 'app')];
    if (!allowedRoots.some((allowedRoot) => absolutePath.startsWith(`${allowedRoot}${path.sep}`))) {
      response.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Forbidden');
      return;
    }

    const body = await readFile(absolutePath);
    response.writeHead(200, {
      'Content-Type': mimeTypes[path.extname(absolutePath)] || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    response.end(body);
  } catch (error) {
    const notFound = error?.code === 'ENOENT';
    response.writeHead(notFound ? 404 : 500, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end(notFound ? 'Not found' : 'Could not load this page');
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`FrameHarbor website: http://127.0.0.1:${port}`);
  console.log(`Desktop UI preview: http://127.0.0.1:${port}/desktop/`);
});
